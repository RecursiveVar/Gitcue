// src/parser/skeleton.mjs —— 语法骨架渲染（叶子库，零内部依赖）
//
// 完整骨架（mode='full'，默认）：按声明序渲染全部 pattern：
//    option → `key | alias`（有 aliases 时）+ ` <name>`（有 param 时）；optional → 外包 `[]`；
//    mutex group → 成员以 ` | ` 连接后按组 optional 包 `[]`；repeat → 后缀 `...`；
//    positional → `<name>`（optional 包 `[]`，repeatable 后缀 `...`）；literal → key 后内联渲染其 then。
// 紧凑骨架（mode='compact'，REPL 语法区默认）：已消费 pattern（不论常用度）+ 未消费且
//    popularity ≥ 3 的 option + 全部 positional；group(mode:mutex) 的未消费成员一律
//    不进紧凑骨架（已消费成员照常单独显示）；互斥伙伴被消费后随之消失（动态收缩）；
//    未消费 literal 集合折叠为 `[<command>]`，进入分支后渲染该分支
//    （`git stash push [-m <msg>] [<pathspec>...]` 形态，根序列剩余 pattern 失效）。
// 已消耗标注：marks[].state='consumed'（渲染层据此高亮/下划线）。
//    紧凑骨架（REPL 语法区）中命令头 `git <command>` 与已进入的 literal 分支路径
//    （如 `git stash push` 的 push）同为用户已输入内容，一并标注 consumed
//    （patternId 记为 `<command>:cmd:<command>`，分支路径复用该 literal 的 patternId）。
//    完整骨架（加载期预生成 syntaxFull）为静态展示，不附带命令头标注。
// 当前位置：cursorOn pattern 的槽位（`[` 处或核心文本起点）记为 cursor 字符偏移；
//    cursorOn 为带 param 的 option（待填参数场景）时 cursor 指向 ` <name>` 段的 `<` 处。
// 空态与未收录文案由 guideSkeleton/uncoveredSkeleton 提供（i18n 值的内联副本——
//    本模块为零内部依赖叶子库，不得 import 上层 i18n 模块）。
//
// 实现约定：渲染只向缓冲区【追加】，绝不在中段插入文本，保证已记录的 span 偏移恒有效。

/**
 * 骨架标注。
 * @typedef {object} SkelMark
 * @property {number} start      骨架文本字符偏移（闭区间左端）
 * @property {number} end        开区间右端
 * @property {string} patternId
 * @property {'consumed'|'available'|'dim'} state
 */

/** 界面文案内联副本（与上层 i18n 的 ui.syntax.guide / ui.syntax.uncovered 值对齐） */
const GUIDE_TEXT = {
  'zh-CN': '输入子命令，↓ 浏览全部',
  'en-US': 'Type a subcommand, press ↓ to browse all',
};
const UNCOVERED_TEXT = {
  'zh-CN': 'git <command> [args...]（未收录，直接执行）',
  'en-US': 'git <command> [args...] (not covered, will execute directly)',
};

/** 只有 `git ` 尚无子命令时的引导骨架 */
export function guideSkeleton(lang = 'zh-CN') {
  return { text: GUIDE_TEXT[lang] ?? GUIDE_TEXT['zh-CN'], marks: [], cursor: null };
}

/** 知识库未收录命令的骨架（`<command>` 为字面占位，不替换实际命令名） */
export function uncoveredSkeleton(lang = 'zh-CN') {
  return { text: UNCOVERED_TEXT[lang] ?? UNCOVERED_TEXT['zh-CN'], marks: [], cursor: null };
}

/**
 * 渲染语法骨架。
 * @param {{ commandName: string, compiled: object, consumedIds?: Set<string>,
 *           activeBranchKey?: string|null, frontier?: object|null, cursorOn?: object|null,
 *           mode?: 'full'|'compact' }} opts
 *   mode 默认 'full'（src/kb/loader.mjs 预生成 syntaxFull 时只传 commandName/compiled 即可）；
 *   'compact' 为 REPL 紧凑骨架（suggest 每键调用，传 consumedIds/activeBranchKey/cursorOn）。
 *   frontier 为契约入参，本渲染器不消费其内容（保留以兼容既有签名）。
 * @returns {{ text: string, marks: SkelMark[], cursor: number|null }}
 */
export function renderSkeleton(opts) {
  const {
    commandName,
    compiled,
    consumedIds = new Set(),
    activeBranchKey = null,
    frontier = null, // eslint-disable-line no-unused-vars —— 契约入参，语义由 consumedIds/cursorOn 承载
    cursorOn = null,
    mode = 'full',
  } = opts;

  let buf = '';
  const append = (s) => {
    buf += s;
  };
  const appendSpace = () => {
    if (buf.length > 0) append(' ');
  };

  /** patternId → {start,end,paramStart,slot}（核心文本 span 与槽位/参数段偏移） */
  const spanOf = new Map();
  const marks = [];

  const isConsumed = (p) => consumedIds.has(p.id);
  /** 互斥伙伴已消费 → 本 pattern 从骨架消失（动态收缩） */
  const mutexBlocked = (p) => {
    if (p.mutex === null) return false;
    const members = compiled.mutexGroups.get(p.mutex) ?? [];
    return members.some((id) => id !== p.id && consumedIds.has(id));
  };
  /** 标注状态：consumed 优先（已输入标注是更强信号），其次光标位 available，其余 dim */
  const stateOf = (p) => (isConsumed(p) ? 'consumed' : cursorOn === p ? 'available' : 'dim');

  /** 折叠 literal 集合时光标候选偏移（`[<command>]` 槽位） */
  let collapsedCursor = null;
  /** literal 集合是否已折叠（紧凑模式下只折叠一次；紧凑模式不会递归进入 literal 内联） */
  let literalCollapsed = false;

  /**
   * 渲染单个 pattern。
   * @param {object} p 运行时 Pattern
   * @param {boolean} bare true 时不按自身 optional 包 `[]`（group 成员由整组统一包）
   * @param {boolean} leadingSpace 是否在 pattern 前补分隔空格（group 成员由 ` | ` 分隔、
   *                              literal 内联由调用方控制，均传 false）
   */
  function renderPattern(p, bare, leadingSpace = true) {
    if (leadingSpace) appendSpace();
    const slot = buf.length;
    const wrapped = !bare && p.optional !== false;
    if (wrapped) append('[');
    const start = buf.length;
    let paramStart = null;
    if (p.type === 'option') {
      append(mode === 'full' ? [p.key, ...p.aliases].join(' | ') : p.key);
      if (p.param) {
        append(' ');
        paramStart = buf.length;
        append(`<${p.param.name}>`);
      }
    } else if (p.type === 'positional') {
      append(`<${p.param ? p.param.name : 'arg'}>`);
    } else {
      append(p.key);
      if (mode === 'full' && Array.isArray(p.then) && p.then.length > 0) {
        // literal 的 then 内联渲染（递归，span 为绝对偏移）；调用方已补过一个空格
        append(' ');
        renderSeq(p.then.map((c) => ({ kind: 'pattern', id: c.id })), { tight: true });
      }
    }
    if (p.repeatable) append('...');
    if (wrapped) append(']');
    const end = buf.length - (wrapped ? 1 : 0);
    spanOf.set(p.id, { start, end, paramStart, slot });
    marks.push({ start, end, patternId: p.id, state: stateOf(p) });
  }

  /**
   * 渲染一段布局序列。
   * @param {object[]} layout 节点：{kind:'pattern',id} | {kind:'group',mode,optional,children}
   * @param {{tight?:boolean}} [opts] tight=true 时首个渲染元素前不补空格（调用方已补）
   */
  function renderSeq(layout, opts = {}) {
    let needSpace = !opts.tight;
    const sep = () => {
      if (needSpace && buf.length > 0) append(' ');
      needSpace = true;
    };
    for (const node of layout) {
      if (!node) continue;
      if (node.kind === 'pattern') {
        const p = compiled.byId.get(node.id);
        if (!p) continue;
        if (mode === 'compact') {
          if (p.type === 'option') {
            // 已消费（不论常用度）可见；未消费需 popularity≥3、互斥伙伴未消费、非未消费组成员
            const show =
              isConsumed(p) ||
              (!mutexBlocked(p) && !p.fromMutexGroupNode && p.popularity >= 3);
            if (!show) continue;
          } else if (p.type === 'literal') {
            // 未进入分支时 literal 集合折叠为 `[<command>]`（只渲染一次）
            if (literalCollapsed) continue;
            literalCollapsed = true;
            sep();
            const at = buf.length;
            append('[<command>]');
            if (cursorOn === p) collapsedCursor = at;
            continue;
          }
          // positional：始终渲染
        }
        sep();
        renderPattern(p, false, false);
      } else if (node.kind === 'group') {
        const members = (node.children ?? [])
          .map((c) => compiled.byId.get(c.id))
          .filter((p) => p);
        if (mode === 'compact') {
          // 未消费组成员不进紧凑骨架；已消费成员照常（带自身 optional 包装）单独显示
          const visible = members.filter((p) => isConsumed(p));
          if (visible.length === 0) continue;
          for (const p of visible) {
            sep();
            renderPattern(p, false, false);
          }
          continue;
        }
        if (members.length === 0) continue;
        // mutex → 成员 ` | ` 连接；repeat → 空格连接 + `...`；按组 optional 统一包 `[]`
        sep();
        const wrapped = node.optional !== false;
        if (wrapped) append('[');
        let first = true;
        for (const p of members) {
          if (!first) append(node.mode === 'mutex' ? ' | ' : ' ');
          first = false;
          renderPattern(p, true, false); // bare：成员不单独包 optional，分隔符由本层管理
        }
        if (node.mode === 'repeat') append('...');
        if (wrapped) append(']');
      }
    }
  }

  // 命令头 `git <command>`；紧凑模式进入 literal 分支时附带分支路径（`git stash push`）并只渲染该分支
  buf = `git ${commandName}`;
  if (mode === 'compact') {
    // 命令头为用户已输入 → consumed 标注（patternId 遵循 <command>:<缩写>:<key> 形态）
    marks.push({
      start: 4,
      end: 4 + commandName.length,
      patternId: `${commandName}:cmd:${commandName}`,
      state: 'consumed',
    });
  }
  if (mode === 'compact' && activeBranchKey) {
    const branchPath = activeBranchKey.split('::').join(' ');
    buf += ` ${branchPath}`;
    const br = compiled.branches.get(activeBranchKey);
    // 已进入的 literal 分支路径（如 `stash push` 的 push）已由用户输入 → consumed 标注
    marks.push({
      start: buf.length - branchPath.length,
      end: buf.length,
      patternId: br ? br.literal.id : `${commandName}:lit:${branchPath}`,
      state: 'consumed',
    });
    if (br) renderSeq(br.layout);
  } else {
    renderSeq(compiled.rootLayout);
  }

  // 光标偏移 = cursorOn 的槽位；带 param 的 option（待填参数）指向 ` <name>` 的 `<` 处
  let cursor = collapsedCursor;
  if (cursor === null && cursorOn) {
    const span = spanOf.get(cursorOn.id);
    if (span) {
      cursor = cursorOn.param && span.paramStart !== null ? span.paramStart : span.slot;
    }
  }

  return { text: buf, marks, cursor };
}
