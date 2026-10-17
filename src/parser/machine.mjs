// src/parser/machine.mjs —— 语法模式编译 + 匹配状态机（叶子库，零内部依赖）
//
// 设计要点：
// - 匹配为确定性贪心单路径：不回溯，开销 O(n)。
// - 选项是"浮动"的：可在任意位置匹配；positional/literal 有序，由游标推进。
// - literal 进入分支后只在 then 序列内匹配，不回退父序列。
// - 互斥组：显式 mutex 字段、group(mode:"mutex") 摊平、自动互斥三者统一并组。
// - repeatable positional 的"保留必填余数"规则。
// - 非法输入零异常：任何 Token 序列都得到 MatchResult，未识别 Token 标 unknown 兜底。

/**
 * 运行时 Pattern（契约结构，另含少量补充字段）。
 * @typedef {object} Pattern
 * @property {string} id        patternId，形如 'rebase:opt:-i'
 * @property {'option'|'positional'|'literal'} type
 * @property {string} key       option/literal 的匹配主形式；positional 为 '<name>'
 * @property {string[]} aliases 等价形式（显式声明）
 * @property {{kind:string,name:string,enum?:string[]}|null} param
 * @property {boolean} optional
 * @property {boolean} repeatable
 * @property {string|null} mutex 归并后的互斥组 ID（编译末尾回填）
 * @property {string|null} since
 * @property {number} popularity
 * @property {string} summary
 * @property {string|null} detail
 * @property {string|null} example
 * @property {Pattern[]|null} then literal 分支的后续 Pattern（声明序）
 * —— 以下为契约外补充字段（不破坏契约，供匹配/骨架/候选使用）——
 * @property {string[]} implicitForms 自动生成的隐式否定形式（如 '--no-fork-point'），可匹配
 * @property {boolean} fromMutexGroupNode 是否声明在 group(mode:"mutex") 节点内
 * @property {string|null} branchKey literal 专属：其分支在 branches 中的键（嵌套为 'a::b'）
 */

/**
 * 编译结果。
 * @typedef {object} CompiledCommand
 * @property {string} name
 * @property {Pattern[]} patterns            全部 Pattern（含分支内，递归）
 * @property {Map<string,Pattern>} byId
 * @property {Map<string,string[]>} mutexGroups 互斥组 ID → patternId 列表
 * @property {Pattern[]} rootOptions         根级浮动选项
 * @property {Pattern[]} rootOrdered         根级有序序列（positional/literal，声明序）
 * @property {Map<string,{literal:Pattern,options:Pattern[],ordered:Pattern[],layout:object[]}>} branches
 * —— 契约外补充字段 ——
 * @property {object[]} rootLayout           根级声明序布局树（骨架渲染用）：
 *   节点为 { kind:'pattern', id } 或 { kind:'group', mode, optional, children }
 */

const TYPE_ABBR = { option: 'opt', positional: 'pos', literal: 'lit' };

/** 归一化 Param 节点（防御性：缺字段时给安全默认） */
function normalizeParam(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = typeof raw.kind === 'string' ? raw.kind : 'text';
  const name = typeof raw.name === 'string' && raw.name ? raw.name : 'arg';
  const param = { kind, name };
  if (kind === 'enum') param.enum = Array.isArray(raw.enum) ? raw.enum.map(String) : [];
  return param;
}

/**
 * 编译 grammar（JSON 原始节点）为运行时 Pattern 结构：
 * 摊平 group、生成 patternId、归并互斥组、应用隐式否定规则。
 * @param {string} commandName 命令名（patternId 前缀）
 * @param {object[]} grammar 知识库 grammar 节点数组
 * @returns {CompiledCommand}
 */
export function compilePatterns(commandName, grammar) {
  const byId = new Map();
  const all = [];
  const usedIds = new Set();
  const branches = new Map();
  let groupCounter = 0;

  // —— 互斥组并组结构（显式 mutex 字段 / group(mode:mutex) / 自动互斥组统一归并）——
  const groups = new Map(); // 规范组 ID -> Set<patternId>
  const groupAlias = new Map(); // 别名组 ID -> 规范组 ID
  const patternGroup = new Map(); // patternId -> 规范组 ID

  function canonicalGid(gid) {
    let c = groupAlias.get(gid);
    if (c === undefined) {
      c = gid;
      groupAlias.set(gid, c);
      groups.set(c, new Set());
    }
    return c;
  }

  /** 把 pattern 加入互斥组；若已属他组则并组（保留已有组名为规范名） */
  function addToGroup(pid, gid) {
    const c = canonicalGid(gid);
    const existing = patternGroup.get(pid);
    if (existing === undefined) {
      patternGroup.set(pid, c);
      groups.get(c).add(pid);
    } else if (existing !== c) {
      const from = groups.get(c) ?? new Set();
      for (const p of from) {
        patternGroup.set(p, existing);
        groups.get(existing).add(p);
      }
      groups.delete(c);
      for (const [k, v] of groupAlias) {
        if (v === c) groupAlias.set(k, existing);
      }
    }
  }

  function makePattern(node) {
    const type = node.type;
    const key =
      type === 'positional'
        ? `<${node.param && node.param.name ? node.param.name : 'arg'}>`
        : String(node.key ?? '?');
    const abbr = TYPE_ABBR[type] ?? 'x';
    let id = `${commandName}:${abbr}:${key}`;
    let n = 2;
    while (usedIds.has(id)) {
      // 同名 positional（如 diff 的两个 <commit>）追加序号保证 patternId 唯一
      id = `${commandName}:${abbr}:${key}~${n}`;
      n += 1;
    }
    usedIds.add(id);
    const p = {
      id,
      type,
      key,
      aliases: Array.isArray(node.aliases) ? node.aliases.map(String) : [],
      param: normalizeParam(node.param ?? null),
      optional: node.optional === undefined ? type !== 'positional' : Boolean(node.optional),
      repeatable: node.repeatable === true,
      mutex: null, // 编译末尾统一回填
      since: node.since ?? null,
      popularity: Number.isInteger(node.popularity) ? node.popularity : 3,
      summary: typeof node.summary === 'string' ? node.summary : '',
      detail: node.detail ?? null,
      example: node.example ?? null,
      then: null,
      implicitForms: [],
      fromMutexGroupNode: false,
      branchKey: null,
    };
    byId.set(id, p);
    all.push(p);
    return p;
  }

  /** 编译 literal 的分支（then），登记 branches */
  function compileBranch(p, node, parentBranchKey) {
    const bk = parentBranchKey ? `${parentBranchKey}::${p.key}` : p.key;
    p.branchKey = bk;
    const sub = compileSeq(Array.isArray(node.then) ? node.then : [], bk);
    p.then = sub.all;
    branches.set(bk, { literal: p, options: sub.options, ordered: sub.ordered, layout: sub.layout });
  }

  /**
   * 编译一段序列（根或分支）。
   * @returns {{options:Pattern[], ordered:Pattern[], layout:object[], all:Pattern[]}}
   */
  function compileSeq(nodes, parentBranchKey) {
    const options = [];
    const ordered = [];
    const layout = [];
    const seqAll = [];

    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const t = node.type;
      if (t === 'option' || t === 'positional' || t === 'literal') {
        const p = makePattern(node);
        seqAll.push(p);
        layout.push({ kind: 'pattern', id: p.id });
        if (t === 'option') options.push(p);
        else ordered.push(p);
        if (typeof node.mutex === 'string' && node.mutex) addToGroup(p.id, node.mutex);
        if (t === 'literal') compileBranch(p, node, parentBranchKey);
      } else if (t === 'group') {
        // group 摊平：mutex 组成员共享互斥组 ID；repeat 组成员标记 repeatable。
        // 说明：repeat 组"共享组槽位"的精化未单独实现（v0.1 知识库无 repeat 组，成员各自
        // repeatable 即可覆盖 `<pathspec>...` 类语法），行为差异仅在假想的成组重复序列。
        const gid = `grp:${groupCounter}`;
        groupCounter += 1;
        const children = [];
        const members = Array.isArray(node.members) ? node.members : [];
        for (const m of members) {
          if (!m || typeof m !== 'object') continue;
          const mt = m.type;
          if (mt !== 'option' && mt !== 'positional' && mt !== 'literal') continue;
          const p = makePattern(m);
          seqAll.push(p);
          children.push({ kind: 'pattern', id: p.id });
          if (mt === 'option') options.push(p);
          else ordered.push(p);
          if (node.mode === 'mutex') {
            addToGroup(p.id, gid);
            p.fromMutexGroupNode = true;
          } else if (node.mode === 'repeat') {
            p.repeatable = true;
          }
          if (typeof m.mutex === 'string' && m.mutex) addToGroup(p.id, m.mutex);
          if (mt === 'literal') compileBranch(p, m, parentBranchKey);
        }
        layout.push({
          kind: 'group',
          mode: node.mode === 'repeat' ? 'repeat' : 'mutex',
          optional: node.optional === undefined ? true : Boolean(node.optional),
          children,
        });
      }
      // 未知节点类型：防御性跳过（数据层 validate 负责报错）
    }
    return { options, ordered, layout, all: seqAll };
  }

  const root = compileSeq(Array.isArray(grammar) ? grammar : [], null);

  // —— 隐式否定规则，作用于整个条目 ——
  // 1) 收集全部显式形式（key ∪ aliases）
  const explicitClaims = new Map(); // 形式 -> patternId
  for (const p of all) {
    if (!explicitClaims.has(p.key)) explicitClaims.set(p.key, p.id);
    for (const a of p.aliases) {
      if (!explicitClaims.has(a)) explicitClaims.set(a, p.id);
    }
  }
  // 2) 对每个长选项 key `--x`：
  //    `--no-x` 未被显式认领 → 在本 pattern 上生成隐式否定形式（可匹配，消费任一形式整组消失）；
  //    被其他 pattern 显式认领 → `--x` 与认领者划入同一互斥组（auto:no-<x>，与显式 mutex 并组）。
  for (const p of all) {
    if (p.type === 'option' && p.key.startsWith('--')) {
      const stem = p.key.slice(2);
      const neg = `--no-${stem}`;
      const claimer = explicitClaims.get(neg);
      if (claimer === undefined) {
        if (!p.aliases.includes(neg) && p.key !== neg) p.implicitForms.push(neg);
      } else if (claimer !== p.id) {
        const autoGid = `auto:no-${stem}`;
        addToGroup(p.id, autoGid);
        addToGroup(claimer, autoGid);
      }
    }
  }

  // —— 互斥组回填与导出 ——
  for (const p of all) p.mutex = patternGroup.get(p.id) ?? null;
  const mutexGroups = new Map();
  for (const [gid, set] of groups) mutexGroups.set(gid, [...set]);

  return {
    name: commandName,
    patterns: all,
    byId,
    mutexGroups,
    rootOptions: root.options,
    rootOrdered: root.ordered,
    branches,
    rootLayout: root.layout, // 契约外补充：骨架渲染布局树
  };
}

/**
 * 判断 Token 是否"选项形态"（以 - 开头且长度 > 1；单独的 '-' 不算）。
 * @param {string} text
 * @returns {boolean}
 */
function isOptionish(text) {
  return text.startsWith('-') && text.length > 1;
}

/**
 * 统计 ordered 中 j 之后未消费的必填（optional=false）positional 数量。
 */
function countRequiredPositionalsAfter(ordered, j, consumed) {
  let k = 0;
  for (let m = j + 1; m < ordered.length; m += 1) {
    const q = ordered[m];
    if (q.type === 'positional' && q.optional === false && !consumed.has(q.id)) k += 1;
  }
  return k;
}

/**
 * 匹配已完成 Token 序列（不含 'git' 与子命令名）。
 * @param {CompiledCommand} compiled
 * @param {{text:string,quoted:boolean}[]} tokens
 * @returns {MatchResult}
 *
 * MatchResult（契约字段 + pendingParamId 补充字段）：
 * {
 *   marks: TokenMark[],                       // 与 tokens 等长
 *   frontier: { options, nextOrdered, branchKey },
 *   consumedIds: Set<string>,
 *   activeBranchKey: string|null,
 *   unknownTokens: [{ index, text }],         // index 为 tokens 内下标
 *   separatorAt: number|null,
 *   pendingParamId: string|null               // 补充：带 param 的 option 已消费但参数未填
 * }
 * TokenMark = { patternId, role: 'option'|'optionParam'|'positional'|'literal'|'unknown'|'separator', warning }
 */
export function matchTokens(compiled, tokens) {
  const marks = [];
  const unknownTokens = [];
  const consumed = new Set();
  const mutexOccupied = new Set();

  let branchKey = null;
  let options = compiled.rootOptions;
  let ordered = compiled.rootOrdered;
  let orderedCursor = 0;
  let pendingParam = null;
  let separatorSeen = false;
  let separatorAt = null;

  /** pattern 当前是否可消费/可进候选：互斥组未占用，且（未消费 或 repeatable） */
  const isAvailable = (p) =>
    !(p.mutex !== null && mutexOccupied.has(p.mutex)) &&
    (!consumed.has(p.id) || p.repeatable === true);

  const consume = (p) => {
    consumed.add(p.id);
    if (p.mutex !== null) mutexOccupied.add(p.mutex);
  };

  /** enum 参数越界警告文案（仍消费，不阻塞） */
  const enumWarning = (p, value) => {
    if (
      p.param &&
      p.param.kind === 'enum' &&
      Array.isArray(p.param.enum) &&
      !p.param.enum.includes(value)
    ) {
      return '非枚举值';
    }
    return null;
  };

  /** 在当前可用 option 集合中按 key/aliases/隐式否定精确匹配 */
  const findOption = (form) => {
    for (const p of options) {
      if (!isAvailable(p)) continue;
      if (p.key === form || p.aliases.includes(form) || p.implicitForms.includes(form)) return p;
    }
    return null;
  };

  const pushUnknown = (idx, text) => {
    marks.push({ patternId: null, role: 'unknown', warning: null });
    unknownTokens.push({ index: idx, text });
  };

  tokens.forEach((tok, idx) => {
    const text = tok.text;

    // 分隔符 `--`：其后非选项 Token 一律按 positional 匹配，选项 Token 标 unknown。
    // 说明：分隔符不吞噬尚未填充的选项参数（参数填充仍先于 positional 匹配）。
    if (text === '--' && !separatorSeen) {
      separatorSeen = true;
      separatorAt = idx;
      marks.push({ patternId: null, role: 'separator', warning: null });
      return;
    }

    if (isOptionish(text)) {
      if (separatorSeen) {
        pushUnknown(idx, text); // 分隔符之后的选项不合法
        return;
      }
      // 精确匹配（key / aliases / 隐式否定形式）
      const hit = findOption(text);
      if (hit) {
        consume(hit);
        marks.push({ patternId: hit.id, role: 'option', warning: null });
        // 仅当本选项带 param 时更新待填参数；无参选项不清除既有待填参数
        //（选项匹配先于参数填充，`--onto -i main` 中 main 仍填 --onto）
        if (hit.param) pendingParam = hit;
        return;
      }
      // `--opt=value` 一体形式（仅长选项；option 与 param 一并消费）
      const eq = text.indexOf('=');
      if (eq > 2 && text.startsWith('--')) {
        const head = text.slice(0, eq);
        const value = text.slice(eq + 1);
        let hit2 = null;
        for (const p of options) {
          if (!isAvailable(p) || !p.param) continue;
          if (p.key === head || p.aliases.includes(head)) {
            hit2 = p;
            break;
          }
        }
        if (hit2) {
          consume(hit2);
          marks.push({ patternId: hit2.id, role: 'option', warning: enumWarning(hit2, value) });
          pendingParam = null;
          return;
        }
      }
      // 组合短选项（如 -auf）：两阶段——先整体验证全部字母命中，再依次消费，避免半消费状态
      if (/^-[a-zA-Z]+$/.test(text)) {
        const letters = text.slice(1).split('');
        const simConsumed = new Set();
        const simOccupied = new Set();
        const seq = [];
        let ok = true;
        for (const L of letters) {
          const shortKey = `-${L}`;
          let found = null;
          for (const p of options) {
            if (p.key !== shortKey && !p.aliases.includes(shortKey)) continue;
            if (p.mutex !== null && (mutexOccupied.has(p.mutex) || simOccupied.has(p.mutex))) continue;
            if (consumed.has(p.id) && p.repeatable !== true) continue;
            if (simConsumed.has(p.id) && p.repeatable !== true) continue;
            found = p;
            break;
          }
          if (!found) {
            ok = false;
            break;
          }
          seq.push(found);
          simConsumed.add(found.id);
          if (found.mutex !== null) simOccupied.add(found.mutex);
        }
        if (ok && seq.length > 0) {
          for (const p of seq) consume(p);
          marks.push({ patternId: seq[0].id, role: 'option', warning: null });
          // 组合中带参数的短选项：取最后一个为待填参数（退化情形，如 -sm）；无参组合不清除既有待填
          let paramHit = null;
          for (const p of seq) {
            if (p.param) paramHit = p;
          }
          if (paramHit) pendingParam = paramHit;
          return;
        }
      }
      pushUnknown(idx, text);
      return;
    }

    // —— 非选项 Token ——
    // 选项参数：带 param 的 option 消费后，下一个已完成 Token 一律作为其参数
    //（选项匹配先于参数填充，故 `--onto -i main` 中 -i 仍是选项）
    if (pendingParam) {
      marks.push({
        patternId: pendingParam.id,
        role: 'optionParam',
        warning: enumWarning(pendingParam, text),
      });
      pendingParam = null;
      return;
    }

    // 有序匹配（literal / positional），从 orderedCursor 起贪心扫描
    let j = orderedCursor;
    let matched = false;
    while (j < ordered.length) {
      const p = ordered[j];
      if (!isAvailable(p)) {
        j += 1;
        continue;
      }
      if (p.type === 'literal') {
        // 字面量需 key 精确相等（分隔符后不再匹配 literal）；不匹配则跳过继续扫描
        if (!separatorSeen && p.key === text) {
          consume(p);
          branchKey = p.branchKey ?? p.key;
          const br = compiled.branches.get(branchKey);
          options = br ? br.options : [];
          ordered = br ? br.ordered : [];
          orderedCursor = 0; // 进入分支：父序列剩余 pattern 失效，不回退
          marks.push({ patternId: p.id, role: 'literal', warning: null });
          matched = true;
          break;
        }
        j += 1;
        continue;
      }
      // positional
      if (p.repeatable) {
        // 保留必填余数：r（剩余未匹配 token 数，含当前）> k（其后未消费必填 positional 数）
        //   → 当前 token 归该 repeatable（游标不动）；否则游标推进，当前 token 归后续 positional。
        const k = countRequiredPositionalsAfter(ordered, j, consumed);
        const r = tokens.length - idx;
        if (r > k) {
          consume(p);
          marks.push({ patternId: p.id, role: 'positional', warning: null });
          matched = true; // 游标不动：可继续吞并后续 token
          break;
        }
        j += 1;
        continue;
      }
      consume(p);
      orderedCursor = j + 1; // 非 repeatable：消费后游标推进
      marks.push({ patternId: p.id, role: 'positional', warning: null });
      matched = true;
      break;
    }
    if (!matched) {
      pushUnknown(idx, text); // 游标耗尽：自由 Token，不阻塞
    }
  });

  // —— 前沿：可用 option 集合 + 游标指向的下一个可用有序 Pattern ——
  const frontierOptions = separatorSeen ? [] : options.filter(isAvailable);
  let nextOrdered = null;
  for (let j = orderedCursor; j < ordered.length; j += 1) {
    const p = ordered[j];
    if (isAvailable(p)) {
      nextOrdered = p;
      break;
    }
  }

  return {
    marks,
    frontier: { options: frontierOptions, nextOrdered, branchKey },
    consumedIds: consumed,
    activeBranchKey: branchKey,
    unknownTokens,
    separatorAt,
    pendingParamId: pendingParam ? pendingParam.id : null, // 契约外补充字段
    orderedCursor, // 契约外补充字段：suggest 镜像扫描 literal/positional 候选所需
  };
}
