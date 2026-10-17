// src/parser/suggest.mjs —— 建议管线总装（只 import 本模块叶子库，KbDb/providers/usage 经参数注入，不 import 知识库/动态数据/使用统计等上层模块）
//
// 管线：词法 → 命令路由 → 状态机匹配 → 骨架渲染 → 候选生成 → 纠错建议 → SuggestResult。
// 核心原则：活动词永不参与匹配，只做候选前缀过滤。
//
// 界面文案说明：本模块不得 import 上层 i18n 模块，故在此内联少量文案副本
//（（暂无说明）/（需 git ≥ x.y）/ Did you mean 等）。

import { tokenize } from './lexer.mjs';
import { matchTokens } from './machine.mjs';
import { renderSkeleton, guideSkeleton, uncoveredSkeleton } from './skeleton.mjs';
import { editDistance } from './distance.mjs';

/** 六种动态数据 kind */
const DYN_KINDS = ['branch', 'tag', 'remote', 'commit', 'stash', 'pathspec'];

/** 内联文案（zh-CN 文案 + en-US 对应译文） */
const TEXTS = {
  'zh-CN': {
    noSummary: '（暂无说明）',
    sinceSuffix: (v) => `（需 git ≥ ${v}）`,
    didYouMean: (s) => `Did you mean: ${s}? (Tab 采纳)`,
    posEmpty: '空输入',
    posPassthrough: '非 git 命令（直接执行）',
    posCommand: '子命令名',
    posCommandActive: (a) => `子命令名（${a}*）`,
    posUncovered: (name) => `未收录命令 ${name}`,
    posOptions: (a) => `选项名（${a}*）`,
    posOptionParam: (key, name) => `${key} 的参数 <${name}>`,
    posPositional: (name, n) => `<${name}>（第 ${n} 个位置参数）`,
    posEnd: '命令末尾',
    posLiteral: '子命令位',
    enumSummary: (key) => `${key} 的参数取值`,
  },
  'en-US': {
    noSummary: '(no description)',
    sinceSuffix: (v) => ` (requires git >= ${v})`,
    didYouMean: (s) => `Did you mean: ${s}? (Tab to accept)`,
    posEmpty: 'empty input',
    posPassthrough: 'non-git command (execute directly)',
    posCommand: 'subcommand name',
    posCommandActive: (a) => `subcommand name (${a}*)`,
    posUncovered: (name) => `unknown command ${name}`,
    posOptions: (a) => `option name (${a}*)`,
    posOptionParam: (key, name) => `parameter of ${key}: <${name}>`,
    posPositional: (name, n) => `<${name}> (positional #${n})`,
    posEnd: 'end of command',
    posLiteral: 'subcommand slot',
    enumSummary: (key) => `value of ${key}`,
  },
};

/** 解析版本串的 [major, minor]（如 '2.55.0.windows.1' → [2,55]；失败返回 null） */
function parseMajorMinor(version) {
  if (typeof version !== 'string') return null;
  const m = /^(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/** 比较 [major,minor]：负/0/正 */
function cmpMM(a, b) {
  return a[0] - b[0] || a[1] - b[1];
}

/**
 * 创建 suggest 管线（REPL 每键调用；单次模式调用一次）。
 * @param {{ kb: object, providers?: object|null, usage?: object|null,
 *           gitVersion?: string|null, lang?: string }} deps
 *   kb：KbDb（src/kb/loader.mjs 产物）；
 *   providers：ProviderHub（可为 null —— 单次模式降级：无动态候选）；
 *   usage：使用频率统计（可为 null —— 无频率加权）；
 *   gitVersion：本机 git 版本串（null → since 标注不追加）。
 * @returns {{ suggest(line: string, cursor?: number) → object }}
 */
export function createSuggest({ kb, providers = null, usage = null, gitVersion = null, lang = 'zh-CN' }) {
  const T = TEXTS[lang] ?? TEXTS['zh-CN'];
  const localMM = parseMajorMinor(gitVersion);

  /**
   * 构造候选（补全默认值；usage 按 usageKey 规则查询）。
   * @param {Partial<Candidate>} partial
   */
  function mk(partial) {
    const c = {
      text: partial.text,
      paramHint: partial.paramHint ?? null,
      summary: partial.summary && partial.summary.length > 0 ? partial.summary : T.noSummary,
      kind: partial.kind,
      patternId: partial.patternId ?? null,
      placeholderKind: partial.placeholderKind ?? null,
      popularity: partial.popularity ?? 3,
      usage: 0,
      since: partial.since ?? null,
      insert: partial.insert ?? null,
      // 作用详述与示例（详情区渲染）：Candidate 契约的
      // 防御性可选扩展，来自知识库 Pattern 的同名字段；缺失时为 null，详情区回退 summary
      detail: partial.detail ?? null,
      example: partial.example ?? null,
      // 注意事项（详情区第三要素）：同上的防御性可选扩展，
      // 目前仅命令候选携带（条目级 notes）；渲染层缺失时不输出该段
      notes: Array.isArray(partial.notes) ? partial.notes.filter((n) => typeof n === 'string') : [],
    };
    // since 标注：本机已知且 major.minor < since 时追加；版本未知不追加
    if (c.since && localMM) {
      const sinceMM = parseMajorMinor(c.since);
      if (sinceMM && cmpMM(localMM, sinceMM) < 0) {
        c.summary += T.sinceSuffix(c.since);
      }
    }
    const key = usageKeyOf(c);
    c.usage = usage && key ? usage.count(key) : 0;
    return c;
  }

  /** usageKey 规则：command→cmd:<name>；option/enum/literal/placeholder→opt:<patternId>；dynamic→dyn:<kind>:<值> */
  function usageKeyOf(c) {
    if (c.kind === 'command') return `cmd:${c.text}`;
    if (c.kind === 'dynamic') return `dyn:${c.placeholderKind ?? '?'}:${c.text}`;
    if (c.kind === 'option' || c.kind === 'enum' || c.kind === 'literal' || c.kind === 'placeholder') {
      return c.patternId ? `opt:${c.patternId}` : null;
    }
    return null; // correction 不计频率
  }

  /** 排序：使用频率降序 > 常用度降序 > 字典序升序（码点序，不用 localeCompare） */
  function sortCandidates(list) {
    return list.sort(
      (x, y) =>
        y.usage - x.usage ||
        y.popularity - x.popularity ||
        (x.text < y.text ? -1 : x.text > y.text ? 1 : 0),
    );
  }

  /** 去重：同文本保留排序靠前者 */
  function dedupeBy(list) {
    const seen = new Set();
    return list.filter((c) => {
      if (seen.has(c.text)) return false;
      seen.add(c.text);
      return true;
    });
  }

  /** pattern 是否可消费/可进候选（与 machine 的 isAvailable 语义一致的镜像实现） */
  function patternAvailable(compiled, consumed, p) {
    if (p.mutex !== null) {
      const members = compiled.mutexGroups.get(p.mutex) ?? [];
      if (members.some((id) => id !== p.id && consumed.has(id))) return false;
    }
    return !consumed.has(p.id) || p.repeatable === true;
  }

  /**
   * 镜像 machine 的有序扫描：从 orderedCursor 起收集可用 literal、
   * 找第一个可用 positional（占位符目标），遇到可用 positional 即停。
   */
  function scanFrontierOrdered(compiled, match) {
    const branch = match.activeBranchKey ? compiled.branches.get(match.activeBranchKey) : null;
    const ordered = branch ? branch.ordered : compiled.rootOrdered;
    const consumed = match.consumedIds;
    const literals = [];
    let firstPositional = null;
    for (let j = match.orderedCursor; j < ordered.length; j += 1) {
      const p = ordered[j];
      if (!patternAvailable(compiled, consumed, p)) continue;
      if (p.type === 'literal') {
        literals.push(p);
        continue;
      }
      firstPositional = p;
      break;
    }
    return { literals, firstPositional };
  }

  /** 占位符候选（insert='' 语义：Tab 展开动态候选）+ 动态数据就绪时的逐值候选 */
  function placeholderAndDynamic(param, pattern) {
    const out = [
      mk({
        text: `<${param.name}>`,
        kind: 'placeholder',
        patternId: pattern.id,
        placeholderKind: param.kind,
        summary: pattern.summary,
        popularity: pattern.popularity,
        detail: pattern.detail,
        example: pattern.example,
        insert: '',
      }),
    ];
    if (providers && typeof providers.snapshot === 'function' && DYN_KINDS.includes(param.kind)) {
      const snap = providers.snapshot(param.kind);
      if (snap && (snap.status === 'ready' || snap.status === 'stale') && Array.isArray(snap.items)) {
        for (const item of snap.items) {
          out.push(
            mk({
              text: item.value,
              kind: 'dynamic',
              patternId: pattern.id,
              placeholderKind: param.kind,
              summary: item.summary,
              popularity: item.popularity,
            }),
          );
        }
      }
      // loading/disabled/error：仅显示占位符一条（渲染层加"加载中/非仓库"提示）
    }
    return out;
  }

  /**
   * 组合短选项候选：活动词形如 -abc 且整体不是精确可用短选项、
   * 前 |w|-1 个字母全部命中可用短选项时，对每个未包含于前缀的可用短选项生成组合候选。
   */
  function comboCandidates(activeText, options) {
    if (!activeText || !/^-[a-zA-Z]+$/.test(activeText)) return [];
    const whole = options.find((p) => p.key === activeText || p.aliases.includes(activeText));
    if (whole) return []; // 整体已是精确可用的短选项
    const letters = activeText.slice(1);
    const prefix = letters.slice(0, -1);
    const findShort = (L) => options.find((p) => p.key === `-${L}` || p.aliases.includes(`-${L}`));
    for (const L of prefix) {
      if (!findShort(L)) return []; // 前缀命中不完整则不生成
    }
    const out = [];
    const seen = new Set();
    for (const p of options) {
      if (p.type !== 'option' || p.key.length !== 2 || !p.key.startsWith('-')) continue;
      const L = p.key[1];
      if (prefix.includes(L)) continue;
      const text = `-${prefix}${L}`;
      if (seen.has(text)) continue;
      seen.add(text);
      out.push(
        mk({
          text,
          kind: 'option',
          patternId: p.id,
          paramHint: p.param ? `<${p.param.name}>` : null,
          summary: p.summary,
          popularity: p.popularity,
          since: p.since,
          detail: p.detail,
          example: p.example,
          insert: text,
        }),
      );
    }
    return sortCandidates(out).slice(0, 5); // 组合候选上限 5 条
  }

  /**
   * 纠错建议：编辑距离 ≤ 2，距离升序 → 字典序升序，最多 3 条。
   * @returns {string[]}
   */
  function computeSuggestions(token, pool) {
    const scored = [];
    for (const f of pool) {
      if (f === token) continue;
      const d = editDistance(token, f, 2);
      if (d <= 2) scored.push({ f, d });
    }
    scored.sort((a, b) => a.d - b.d || (a.f < b.f ? -1 : a.f > b.f ? 1 : 0));
    return scored.slice(0, 3).map((s) => s.f);
  }

  /** 纠错建议转为置顶候选（kind=correction，insert 承载"替换该 Token"动作） */
  function correctionCandidates(corrections) {
    const out = [];
    for (const corr of corrections) {
      for (const s of corr.suggestions) {
        out.push(
          mk({
            text: s,
            kind: 'correction',
            summary: T.didYouMean(s),
            popularity: 0,
            insert: s,
          }),
        );
      }
    }
    return out;
  }

  /** 命令名候选（phase=command）。
   *  命令条目无 pattern 级 detail 字段（顶层无此项），
   *  作用详述回退 summary；典型示例取条目级 examples 首条 cmd，注意事项透传条目级 notes。 */
  function commandCandidates() {
    return kb.names().map((name) => {
      const e = kb.get(name);
      return mk({
        text: name,
        kind: 'command',
        summary: e ? e.summary : '',
        popularity: e ? e.popularity : 3,
        detail: null,
        example:
          e && Array.isArray(e.examples) && e.examples.length > 0 && typeof e.examples[0].cmd === 'string'
            ? e.examples[0].cmd
            : null,
        notes: e && Array.isArray(e.notes) ? e.notes : [],
      });
    });
  }

  /** 位置参数/命令末尾的中文位置描述 */
  function positionalLabel(compiled, match) {
    const next = match.frontier.nextOrdered;
    if (!next) return T.posEnd;
    if (next.type === 'literal') return T.posLiteral;
    const branch = match.activeBranchKey ? compiled.branches.get(match.activeBranchKey) : null;
    const ordered = branch ? branch.ordered : compiled.rootOrdered;
    let n = 0;
    for (const p of ordered) {
      if (p.type === 'positional') n += 1;
      if (p === next) break;
    }
    return T.posPositional(next.param ? next.param.name : 'arg', n);
  }

  /**
   * 解析一行输入，产出 SuggestResult（UI 与单次模式的唯一数据源）。
   * @param {string} line
   * @param {number} [cursor] 光标偏移，默认行尾
   */
  function suggest(line, cursor = line.length) {
    const t0 = performance.now();
    const { tokens, active } = tokenize(line, cursor);
    const t1 = performance.now();

    let isGit = tokens.length > 0 && tokens[0].text === 'git';
    let covered = false;
    let phase = 'empty';
    let commandName = null;
    let marks = [];
    let skeleton = { text: '', marks: [], cursor: null };
    let pool = []; // 排序前的候选池
    let corrections = [];

    if (!isGit) {
      phase = tokens.length === 0 && !active ? 'empty' : 'passthrough';
    } else if (tokens.length === 1 || (tokens.length >= 2 && tokens[1].text.startsWith('-'))) {
      // 只有 `git`（或 git 后紧跟全局选项——全局选项暂不建模，视作子命令未给出，
      // 引导文案与全部命令候选；此路径不匹配参数，marks 为空）
      phase = 'command';
      skeleton = guideSkeleton(lang);
      pool = commandCandidates();
    } else {
      commandName = tokens[1].text;
      const entry = kb.get(commandName);
      if (!entry) {
        // 完整但未命中 → 未收录（未收录骨架，无普通候选无错误；纠错建议池含全部命令名）
        phase = 'uncovered';
        skeleton = uncoveredSkeleton(lang);
        const suggestions = computeSuggestions(commandName, kb.names());
        if (suggestions.length > 0) {
          corrections.push({ token: commandName, index: 1, suggestions });
        }
        // 与 tokens.slice(2) 对齐：未收录命令的后续 Token 均为自由 Token（unknown 兜底）
        marks = tokens.slice(2).map(() => ({ patternId: null, role: 'unknown', warning: null }));
      } else {
        covered = true;
        const t2 = performance.now();
        const match = matchTokens(
          entry.compiled,
          tokens.slice(2).map((t) => ({ text: t.text, quoted: t.quoted })),
        );
        const t2b = performance.now();
        marks = match.marks;
        const pendingParam = match.pendingParamId
          ? entry.compiled.byId.get(match.pendingParamId)
          : null;
        const cursorOn = pendingParam ?? match.frontier.nextOrdered ?? null;
        skeleton = renderSkeleton({
          commandName,
          compiled: entry.compiled,
          consumedIds: match.consumedIds,
          activeBranchKey: match.activeBranchKey,
          frontier: match.frontier,
          cursorOn,
          mode: 'compact',
        });
        const t3 = performance.now();

        // —— phase 与位置描述 ——
        const activeIsOptionish = Boolean(active && active.text.startsWith('-') && active.text.length > 1);
        let positionLabel;
        if (activeIsOptionish) {
          phase = 'options';
          positionLabel = T.posOptions(active.text);
        } else if (pendingParam) {
          phase = 'optionParam';
          positionLabel = T.posOptionParam(pendingParam.key, pendingParam.param.name);
        } else if (match.unknownTokens.length > 0) {
          phase = 'unknown';
          positionLabel = positionalLabel(entry.compiled, match);
        } else {
          phase = 'positionals';
          positionLabel = positionalLabel(entry.compiled, match);
        }

        // —— 候选生成 ——
        const frontierTexts = []; // 纠错建议池（前沿全部合法出边文本）

        /** 前沿选项候选：主 key + 每个 alias 一条（共享 patternId，联动互斥）；
         *  隐式否定形式仅在活动词是选项形态时进入候选池，避免候选区翻倍噪音 */
        const buildOptionCandidates = () => {
          const out = [];
          for (const p of match.frontier.options) {
            const forms = [p.key, ...p.aliases];
            if (activeIsOptionish) forms.push(...p.implicitForms);
            for (const f of forms) {
              out.push(
                mk({
                  text: f,
                  kind: 'option',
                  patternId: p.id,
                  paramHint: p.param ? `<${p.param.name}>` : null,
                  summary: p.summary,
                  popularity: p.popularity,
                  since: p.since,
                  detail: p.detail,
                  example: p.example,
                }),
              );
              frontierTexts.push(f);
            }
          }
          return out;
        };

        let combos = []; // 组合短选项候选（独立生成机制，不参与前缀过滤）
        if (pendingParam) {
          // 待填参数：枚举值 / 占位符 + 动态候选
          if (pendingParam.param.kind === 'enum') {
            for (const v of pendingParam.param.enum) {
              pool.push(
                mk({
                  text: v,
                  kind: 'enum',
                  patternId: pendingParam.id,
                  summary: T.enumSummary(pendingParam.key),
                }),
              );
              frontierTexts.push(v);
            }
          } else {
            // 非枚举参数（commit/branch/…/text）：占位符 + 动态逐值候选
            pool.push(...placeholderAndDynamic(pendingParam.param, pendingParam));
            frontierTexts.push(`<${pendingParam.param.name}>`);
          }
          // 选项仍可合法输入（选项匹配先于参数填充，如 `--onto -i main`）：
          // 活动词为选项形态（用户正在输入选项）时，选项候选与参数候选并存
          if (activeIsOptionish) {
            pool.push(...buildOptionCandidates());
            combos = comboCandidates(active ? active.text : null, match.frontier.options);
          }
        } else {
          pool.push(...buildOptionCandidates());
          // 活动词为 `--opt=value` 形态（如 --empty=d，活动词未完成、机器看不到它）
          // → 命中带枚举参数的长选项时，合成 `key=value` 整体候选
          if (active && activeIsOptionish && active.text.includes('=')) {
            const eqIdx = active.text.indexOf('=');
            const head = active.text.slice(0, eqIdx);
            const target = match.frontier.options.find(
              (p) =>
                (p.key === head || p.aliases.includes(head)) &&
                p.param &&
                p.param.kind === 'enum',
            );
            if (target) {
              for (const v of target.param.enum) {
                const text = `${head}=${v}`;
                pool.push(
                  mk({
                    text,
                    kind: 'enum',
                    patternId: target.id,
                    summary: T.enumSummary(head),
                    insert: text,
                  }),
                );
              }
            }
          }
          // 前沿 literal（分支名）与第一个可用 positional（占位符 + 动态候选）
          const { literals, firstPositional } = scanFrontierOrdered(entry.compiled, match);
          for (const lp of literals) {
            pool.push(
              mk({
                text: lp.key,
                kind: 'literal',
                patternId: lp.id,
                summary: lp.summary,
                popularity: lp.popularity,
                detail: lp.detail,
                example: lp.example,
              }),
            );
            frontierTexts.push(lp.key);
          }
          if (firstPositional && firstPositional.param) {
            pool.push(...placeholderAndDynamic(firstPositional.param, firstPositional));
            frontierTexts.push(`<${firstPositional.param.name}>`);
          }
          combos = comboCandidates(active ? active.text : null, match.frontier.options);
        }

        // —— 纠错建议：存在 unknown 已完成 Token 必报 ——
        for (const u of match.unknownTokens) {
          const suggestions = computeSuggestions(u.text, frontierTexts);
          if (suggestions.length > 0) {
            corrections.push({ token: u.text, index: 2 + u.index, suggestions });
          }
        }

        // —— 前缀过滤 → 软纠错 → 排序 → 去重 → 组合候选并入 → 纠错候选置顶 ——
        let filtered = pool;
        if (active && active.text.length > 0) {
          filtered = pool.filter((c) => c.text.startsWith(active.text)); // 大小写敏感
          if (filtered.length === 0 && combos.length === 0) {
            // 软提示：活动词非空且过滤后为 0（index=-1 表示活动词，Tab 采纳即替换之）。
            // 触发条件即"前缀过滤后候选为 0"——无距离 ≤2 的建议时也保留条目
            // （suggestions 为空数组），供单次模式输出「⚠ 未识别」。
            const suggestions = computeSuggestions(active.text, frontierTexts);
            corrections.push({ token: active.text, index: -1, suggestions });
          }
        }
        sortCandidates(filtered);
        let candidates = dedupeBy(filtered);
        if (combos.length > 0) {
          // 组合候选并入后统一排序（组合候选自身已截取前 5 条）
          candidates = dedupeBy(sortCandidates([...candidates, ...combos]));
        }
        candidates.unshift(...correctionCandidates(corrections));

        const t5 = performance.now();
        return {
          isGit,
          covered,
          phase,
          tokens,
          active,
          marks,
          commandName,
          skeleton,
          positionLabel,
          candidates,
          corrections,
          debug: {
            timingsMs: {
              lex: round3(t1 - t0),
              match: round3(t2b - t2),
              skeleton: round3(t3 - t2b),
              candidates: round3(t5 - t3),
            },
          },
        };
      }
    }

    // —— 非 covered 路径的收尾（command / uncovered / passthrough / empty）——
    let positionLabel;
    if (phase === 'empty') positionLabel = T.posEmpty;
    else if (phase === 'passthrough') positionLabel = T.posPassthrough;
    else if (phase === 'command') positionLabel = active ? T.posCommandActive(active.text) : T.posCommand;
    else positionLabel = T.posUncovered(commandName);

    let filtered = pool;
    if (phase === 'command' && active && active.text.length > 0) {
      filtered = pool.filter((c) => c.text.startsWith(active.text));
      if (filtered.length === 0) {
        const suggestions = computeSuggestions(active.text, kb.names());
        if (suggestions.length > 0) {
          corrections.push({ token: active.text, index: -1, suggestions });
        }
      }
    }
    sortCandidates(filtered);
    const candidates = dedupeBy(filtered);
    candidates.unshift(...correctionCandidates(corrections));

    const tEnd = performance.now();
    return {
      isGit,
      covered,
      phase,
      tokens,
      active,
      marks,
      commandName,
      skeleton,
      positionLabel,
      candidates,
      corrections,
      debug: {
        timingsMs: {
          lex: round3(t1 - t0),
          match: 0,
          skeleton: 0,
          candidates: round3(tEnd - t1),
        },
      },
    };
  }

  return { suggest };
}

/** 保留 3 位小数（耗时记录） */
function round3(x) {
  return Math.round(x * 1000) / 1000;
}
