/**
 * 五区视图（`src/ui/appView.mjs`）。
 *
 * 职责：
 *  - zone 纯函数：五区内容计算，产出 `segs: [{text, sgr}]`（sgr 为逻辑样式名），
 *    plain 输出逐字节兼容（tui-appview 有黄金快照锚定）；
 *  - renderPlainLines(state)：纯文本降级行渲染（零 React 依赖，repl.mjs plain 路径直写终端，
 *    也是 testHarness.renderAppLines 的单一真源）；
 *  - GitcueApp({state})：Ink 组件树（ANSI 形态，五区顺序固定、候选不足时收缩但区标题保留）。
 *
 * 列对齐口径：候选说明列对齐、标注行 ▏ 列位置、┬/▏ 标注行的空格推算一律用
 * padWidth（码点 > 0xFF 记 2 列）在 zone 纯函数内显式生成文本，不依赖 Ink/yoga 布局宽度
 * ——Ink 只负责边框、行内多段着色与整体差分重绘。
 *
 * 说明文案：本文件维护内部文案表（zh-CN 全量 +
 *  en-US 框架翻译），与 src/i18n.mjs 的表保持一致。
 */

import { createElement as h } from 'react';
import { Text, Box } from 'ink';

/** 框线内容区显示列宽（INNER_W = BOX_W - 4 = 72） */
const INNER_W = 72;
/** 框线总显示列宽（区标题分隔行按此宽度填充 ─） */
const BOX_W = 76;
/** 状态条动态段淡出窗口（1.5s） */
export const FADE_MS = 1500;
/** 候选关键字列宽上限（min(max(text 宽), 24) + 2） */
const KEY_COL_MAX = 24;

/**
 * sgr（逻辑样式名）→ Ink 样式 prop 映射表。
 * consumed 随主题：default=下划线+粗体 / contrast=反色。
 * 静态常量，tui-appview 有逐项断言锚定。
 */
export const INK_STYLES = {
  default: {
    consumed: { underline: true, bold: true },
    dim: { dimColor: true },
    cursor: { inverse: true },
    block: { inverse: true },
    selected: { inverse: true },
    correction: { color: 'red' },
    paramHint: { color: 'cyan', dimColor: true },
    danger: { color: 'red' },
    exitOk: { color: 'green' },
    exitFail: { color: 'red' },
  },
  contrast: {
    consumed: { inverse: true },
    dim: { dimColor: true },
    cursor: { inverse: true },
    block: { inverse: true },
    selected: { inverse: true },
    correction: { color: 'red' },
    paramHint: { color: 'cyan', dimColor: true },
    danger: { color: 'red' },
    exitOk: { color: 'green' },
    exitFail: { color: 'red' },
  },
};

/** 界面文案表（zh-CN 全量；en-US 为框架翻译） */
export const STRINGS = {
  'zh-CN': {
    'ui.title': 'GitCue',
    'ui.prompt': 'git> ',
    'ui.zone.syntax': '语法',
    'ui.zone.candidates': '候选',
    'ui.zone.detail': '详情',
    'ui.zone.log': '历史',
    'ui.log.omitted': '…（更早 {n} 行已省略，F2 展开）',
    'ui.log.noOutput': '（无输出）',
    'ui.syntax.guide': '输入子命令，↓ 浏览全部',
    'ui.syntax.uncovered': 'git <command> [args...]（未收录，直接执行）',
    'ui.loading': '加载中…',
    'ui.notrepo': '（当前目录不是 git 仓库）',
    'ui.didyoumean': 'Did you mean: {s}? (Tab 采纳)',
    'ui.nosummary': '（暂无说明）',
    'ui.exit.ok': '✔ exit {code}',
    'ui.exit.fail': '✘ exit {code}',
    'ui.running': '…运行中',
    'ui.hintbar': 'Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出',
    'ui.since': '（需 git ≥ {v}）',
    'ui.page': '{cur}/{total}页',
    'ui.example': '例：{cmd}',
    'ui.note': '注意：{s}',
    'ui.plain.input': '输入',
    'ui.plain.syntax': '语法',
    'ui.plain.candidates': '候选',
    'ui.plain.detail': '说明',
    'ui.plain.status': '状态',
    'ui.plain.log': '历史',
    'anno.consumed': '已输入',
    'anno.cursor': '当前位置',
    'ui.guide.1': 'GitCue：输入 git 命令，实时获得语法与候选提示',
    'ui.guide.2': 'Tab 补全 │ ↑↓ 选择 │ Enter 执行 │ F1 详情',
    'ui.guide.3': '↑（空行）回溯历史 │ Esc 清空 │ Ctrl+C×2 或 Ctrl+Q 退出',
    'ui.guide.4': '输入非 git 命令将直接执行',
    'ui.guide.5': '按任意键继续',
  },
  'en-US': {
    'ui.title': 'GitCue',
    'ui.prompt': 'git> ',
    'ui.zone.syntax': 'Syntax',
    'ui.zone.candidates': 'Candidates',
    'ui.zone.detail': 'Detail',
    'ui.zone.log': 'History',
    'ui.log.omitted': '…({n} earlier lines omitted, F2 expands)',
    'ui.log.noOutput': '(no output)',
    'ui.syntax.guide': 'Type a subcommand, ↓ to browse all',
    'ui.syntax.uncovered': 'git <command> [args...] (not covered, runs as-is)',
    'ui.loading': 'Loading…',
    'ui.notrepo': '(not a git repository)',
    'ui.didyoumean': 'Did you mean: {s}? (Tab to accept)',
    'ui.nosummary': '(no description)',
    'ui.exit.ok': '✔ exit {code}',
    'ui.exit.fail': '✘ exit {code}',
    'ui.running': '…running',
    'ui.hintbar': 'Tab complete │ ↑↓ select │ F1 detail │ Enter run │ Esc clear │ Ctrl+Q quit',
    'ui.since': '(needs git ≥ {v})',
    'ui.page': 'page {cur}/{total}',
    'ui.example': 'e.g. {cmd}',
    'ui.note': 'note: {s}',
    'ui.plain.input': 'Input',
    'ui.plain.syntax': 'Syntax',
    'ui.plain.candidates': 'Candidates',
    'ui.plain.detail': 'Detail',
    'ui.plain.status': 'Status',
    'ui.plain.log': 'History',
    'anno.consumed': 'typed',
    'anno.cursor': 'current position',
    'ui.guide.1': 'GitCue: type git commands, get syntax & candidates live',
    'ui.guide.2': 'Tab complete │ ↑↓ select │ Enter run │ F1 detail',
    'ui.guide.3': '↑ (empty line) history │ Esc clear │ Ctrl+C×2 or Ctrl+Q quit',
    'ui.guide.4': 'Non-git commands run directly',
    'ui.guide.5': 'Press any key to continue',
  },
};

/** 取文案：缺语言回退 zh-CN，再缺返回键名（不抛错）；{x} 插值。 */
export function t(lang, key, params = {}) {
  const table = STRINGS[lang] || STRINGS['zh-CN'];
  let s = table[key] !== undefined ? table[key] : STRINGS['zh-CN'][key];
  if (s === undefined) return key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, name) => (params[name] !== undefined ? String(params[name]) : m));
  return s;
}

/** 显示宽度：CJK 等宽字符（码点 > 0xFF）记 2 列（padWidth 规则）。 */
export function padWidth(str) {
  let w = 0;
  for (const ch of String(str ?? '')) w += ch.codePointAt(0) > 0xff ? 2 : 1;
  return w;
}

/** 按显示宽度右补空格。 */
export function padEndW(str, width) {
  const s = String(str ?? '');
  const pad = width - padWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

/** 按显示宽度截断并追加省略号（保头弃尾；'…' 占 2 列需预留）。 */
export function truncateW(str, width) {
  const s = String(str ?? '');
  if (padWidth(s) <= width) return s;
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = ch.codePointAt(0) > 0xff ? 2 : 1;
    if (w + cw + 2 > width) break; // 为 '…' 预留 2 列
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** 取详情句首（按 。！？； 断句）。 */
export function firstSentence(s) {
  const m = String(s || '').match(/^.*?[。！？；]/);
  return m ? m[0] : String(s || '');
}

// ───────────────────────── 段工具（plain/ANSI 共用，sgr 为逻辑样式名） ─────────────────────────

function segsWidth(segs) {
  return segs.reduce((w, s) => w + padWidth(s.text), 0);
}

/** 段列表按显示宽度截断（追加 … 段，'…' 占 2 列需预留）。 */
function segsTruncate(segs, width) {
  if (segsWidth(segs) <= width) return segs;
  const out = [];
  let w = 0;
  for (const s of segs) {
    let text = '';
    let sw = 0;
    for (const ch of s.text) {
      const cw = ch.codePointAt(0) > 0xff ? 2 : 1;
      if (w + sw + cw + 2 > width) {
        out.push({ text: text + '…' });
        return out;
      }
      text += ch;
      sw += cw;
    }
    out.push({ text, sgr: s.sgr });
    w += sw;
  }
  return out;
}

/** 构造当前语言的文案函数（组件与 zone 函数共用）。 */
function ttOf(state) {
  return (key, params) => t(state.lang, key, params);
}

// ───────────────────────── 区内容计算（zone 纯函数） ─────────────────────────

/** 标题文本：GitCue ─ <cwd> (branch: <b>)；非仓库时附提示。 */
export function titleText(state, TT) {
  const repo = state.repo || {};
  if (repo.isRepo) return `${TT('ui.title')} ─ ${repo.cwd} (branch: ${repo.branch})`;
  return `${TT('ui.title')} ─ ${repo.cwd} ${TT('ui.notrepo')}`;
}

/** 选项参数"待填提示"：optionParam 态且光标在行尾时，从 positionLabel 提取 <name>。 */
function pendingParamHint(state) {
  const v = state.view;
  if (!v || v.phase !== 'optionParam') return null;
  if (state.cursor !== state.line.length) return null;
  const m = String(v.positionLabel || '').match(/<[^<>]+>/g);
  return m ? m[m.length - 1] : null;
}

/** 输入区文本段：prompt + 光标前文本 + [待填参数位] + 光标块 + 光标后文本。
 *  光标块默认 █（醒目）；渲染层闪烁定时器翻转 state.cursorBlink 时交替为细条 ▏
 *  （两种形态均反色标示插入位置——闪烁期间位置始终可见，行尾是否已敲空格一目了然）。
 *  已执行的命令不再占用输入行（Enter 即清空，命令与输出进窗口顶部历史区）。 */
export function inputSegs(state, TT) {
  const text = state.line;
  const cursor = state.cursor;
  const segs = [{ text: TT('ui.prompt') }];
  segs.push({ text: text.slice(0, cursor) });
  const hint = pendingParamHint(state);
  if (hint) segs.push({ text: hint, sgr: 'paramHint' });
  segs.push({ text: state.cursorBlink ? '▏' : '█', sgr: 'block' });
  segs.push({ text: text.slice(cursor) });
  return segs;
}

/** 输入区当前展示文本与光标（纯文本模式共用）。 */
function shownInput(state) {
  return { text: state.line, cursor: state.cursor };
}

/**
 * 语法区内容（zone 纯函数）：
 *  - `git` 后无子命令 → 引导文案；
 *  - 未收录命令 → 未收录提示文案；
 *  - 已收录 → 骨架着色段（consumed/dim）+ 标注行（└已输入 / ▏当前位置）。
 * 返回 { segs, anno: [markerSegs, labelSegs] } 或 null。
 */
export function buildSyntaxZone(state, TT) {
  const v = state.view;
  if (!v || !v.isGit) return null;
  if (!v.commandName) return { segs: [{ text: TT('ui.syntax.guide') }], anno: [] };
  if (v.covered === false) return { segs: [{ text: TT('ui.syntax.uncovered') }], anno: [] };
  const sk = v.skeleton;
  if (!sk || !sk.text) return null;
  const marks = (sk.marks || []).slice().sort((a, b) => a.start - b.start);
  if (padWidth(sk.text) > INNER_W) {
    // 超宽截断（保头弃尾；标注行随截断一并省略）
    return { segs: [{ text: truncateW(sk.text, INNER_W) }], anno: [] };
  }
  const segs = [];
  let pos = 0;
  for (const m of marks) {
    const s = Math.max(pos, Math.min(m.start, sk.text.length));
    const e = Math.max(s, Math.min(m.end, sk.text.length));
    if (s > pos) segs.push({ text: sk.text.slice(pos, s), sgr: 'dim' });
    // consumed 的主题形态（default=下划线+亮白 / contrast=反色）由 ANSI 组件按映射表渲染
    const style = m.state === 'consumed' ? 'consumed' : m.state === 'dim' ? 'dim' : '';
    segs.push({ text: sk.text.slice(s, e), sgr: style });
    pos = e;
  }
  if (pos < sk.text.length) segs.push({ text: sk.text.slice(pos), sgr: 'dim' });

  // 标注行：第一个已消耗 span 的 ┬（└ 已输入）与光标位 ▏（└ 当前位置）
  const consumed = marks.filter((m) => m.state === 'consumed');
  const c0 = consumed.length ? consumed[0].start : null;
  const c1 = typeof sk.cursor === 'number' ? sk.cursor : null;
  if (c0 === null && c1 === null) return { segs, anno: [] };
  const items = [];
  if (c0 !== null) items.push({ at: c0, mk: '┬', label: TT('anno.consumed') });
  if (c1 !== null) items.push({ at: c1, mk: '▏', label: TT('anno.cursor') });
  items.sort((a, b) => a.at - b.at);
  const markerSegs = [];
  const labelSegs = [];
  let mText = '';
  let lText = '';
  for (const it of items) {
    const gap = Math.max(0, it.at - mText.length);
    if (gap > 0) markerSegs.push({ text: ' '.repeat(gap) });
    markerSegs.push(it.mk === '▏' ? { text: '▏', sgr: 'cursor' } : { text: '┬' });
    mText += ' '.repeat(gap) + it.mk;
    const need = Math.max(it.at, lText.length + 2);
    const lgap = Math.max(0, need - lText.length);
    if (lgap > 0) labelSegs.push({ text: ' '.repeat(lgap) });
    labelSegs.push({ text: '└ ' + it.label });
    lText += ' '.repeat(lgap) + '└ ' + it.label;
  }
  return { segs, anno: [markerSegs, labelSegs] };
}

/** 候选关键字段文本（不含 paramHint 分色时的合并文本）。 */
function keyPart(c) {
  return c.text + (c.paramHint ? ' ' + c.paramHint : '');
}

/**
 * 候选区（zone 纯函数）：{ title, count, pageLabel, rows: [segs[]] }。
 * 分页显示，高亮 ► / 占位符 ▸ / 纠错行整行红字。列宽 = min(max(全部候选 key 宽), 24) + 2
 * （跨页稳定；纠错行不参与列宽计算）。
 */
export function buildCandidatesZone(state, TT) {
  const v = state.view;
  const cands = (v && v.candidates) || [];
  const limit = Math.max(1, Number(state.config?.candidate_limit) || 8);
  const pages = Math.max(1, Math.ceil(cands.length / limit));
  const page = Math.max(0, Math.min(state.page, pages - 1));
  const pageLabel = pages > 1 ? ` ${TT('ui.page', { cur: page + 1, total: pages })}` : '';
  const title = `${TT('ui.zone.candidates')} (${cands.length})${pageLabel}`;
  if (!cands.length || state.dismissed) return { title, count: cands.length, pageLabel, rows: [] };
  const norm = cands.filter((c) => c.kind !== 'correction');
  let keyCol = 4;
  for (const c of norm) keyCol = Math.max(keyCol, padWidth(keyPart(c)));
  keyCol = Math.min(keyCol, KEY_COL_MAX) + 2;
  const rows = [];
  const start = page * limit;
  for (let i = start; i < Math.min(start + limit, cands.length); i++) {
    const c = cands[i];
    const isSel = i === state.selected;
    const marker = isSel ? '►' : c.kind === 'placeholder' ? '▸' : ' ';
    // 标记列统一占 2 显示列（►/▸ 为 2 列字形，空格补齐），保证关键字列起点一致
    const markerCol = padEndW(marker, 2);
    if (c.kind === 'correction') {
      const text = `${markerCol} ${TT('ui.didyoumean', { s: c.text })}`;
      rows.push(isSel ? [{ text, sgr: 'selected' }] : [{ text, sgr: 'correction' }]);
      continue;
    }
    const summary = c.summary || TT('ui.nosummary');
    // 行文本统一为：标记(2列) + 空格 + 关键字（含参数位）+ 列填充 + 一行说明；
    // 填充 = keyCol - 关键字显示宽，保证所有行说明列对齐（CJK 记 2 列）
    const pad = ' '.repeat(Math.max(0, keyCol - padWidth(keyPart(c))));
    const text = `${markerCol} ${keyPart(c)}${pad}${summary}`;
    if (isSel) {
      rows.push([{ text, sgr: 'selected' }]); // 高亮行整段反色
    } else if (c.kind === 'placeholder') {
      rows.push([{ text: `${markerCol} ` }, { text: c.text, sgr: 'paramHint' }, { text: pad }, { text: summary, sgr: 'dim' }]);
    } else {
      rows.push([
        { text: markerCol + ' ' },
        { text: c.text },
        ...(c.paramHint ? [{ text: ' ' + c.paramHint, sgr: 'paramHint' }] : []),
        { text: pad },
        { text: summary, sgr: 'dim' },
      ]);
    }
  }
  return { title, count: cands.length, pageLabel, rows };
}

/**
 * 详情区（zone 纯函数）：{ title, rows: [segs[]] }。默认一行（详情句首或 summary）；
 * detailOpen 展开：详情全文 + 示例 + 注意事项三要素。
 * detail/example/notes 为防御性可选字段（suggest 层提供；
 * 缺失时回退 summary，notes 为空数组时不输出该段）。
 */
export function buildDetailZone(state, TT) {
  const v = state.view;
  const cands = (v && v.candidates) || [];
  const sel = cands.length && !state.dismissed ? cands[Math.max(0, Math.min(state.selected, cands.length - 1))] : null;
  if (!sel) return { title: TT('ui.zone.detail'), rows: [] };
  const title = `${TT('ui.zone.detail')} ${sel.text}${sel.paramHint ? ' ' + sel.paramHint : ''}`;
  const detail = sel.detail || null;
  const example = sel.example || null;
  const notes = Array.isArray(sel.notes) ? sel.notes.filter((n) => typeof n === 'string' && n) : [];
  const summary = sel.summary || TT('ui.nosummary');
  const rows = [];
  if (state.detailOpen) {
    rows.push([{ text: detail || summary }]);
    if (example) rows.push([{ text: TT('ui.example', { cmd: example }), sgr: 'dim' }]);
    for (const n of notes) rows.push([{ text: TT('ui.note', { s: n }), sgr: 'dim' }]);
  } else {
    rows.push([{ text: detail ? firstSentence(detail) : summary }]);
  }
  return { title, rows };
}

/** 历史区以外区域的典型行数开销（边框2+标题1+输入1+语法/候选/详情/状态各含分隔与内容）。
 *  用于终端高度预算：总帧高不超过终端行数，防止顶部（历史区）被滚出视口。 */
const LOG_RESERVED_ROWS = 16;

/**
 * 执行历史区（zone 纯函数，内联形态）：窗口顶部展示已执行命令与捕获的输出。
 * 每条目：`$ <cmd>`（运行中缀 …，非零退出缀 ✘ exit N）+ 输出行（dim，截 INNER_W）；
 * 运行中条目末尾为本地回显行（paramHint 色 + ▏ 光标）。显示行数预算 =
 * config.log_height（F2 展开为 3 倍），并按终端剩余高度收缩（state.term.rows 由渲染层
 * 注入：预算 = max(1, min(配置值, rows - LOG_RESERVED_ROWS))，保证历史区至少可见 1 行）；
 * 超出预算保尾弃头并加省略标记行。
 * @returns {{ title: string, rows: [segs[]], hidden: boolean }}
 */
export function buildLogZone(state, TT) {
  const entries = state.execLog || [];
  if (!entries.length) return { title: TT('ui.zone.log'), rows: [], hidden: true };
  const rows = [];
  for (const e of entries) {
    const running = e.code === null;
    const headSegs = [];
    let head = `$ ${e.cmd}`;
    if (running) head += ` ${TT('ui.running')}`;
    else if (e.code !== 0) head += `  ${TT('ui.exit.fail', { code: e.code })}`;
    else if (!String(e.output || '').trim()) head += `  ${TT('ui.log.noOutput')}`; // 完成且无输出：给出明确反馈，避免"输出丢了"的误会
    headSegs.push({ text: head, sgr: running ? '' : 'dim' });
    rows.push(headSegs);
    const out = String(e.output || '');
    if (out) {
      const parts = out.split('\n');
      if (parts.length && parts[parts.length - 1] === '') parts.pop(); // 末尾完整换行
      for (const ln of parts) rows.push([{ text: truncateW(ln, INNER_W), sgr: 'dim' }]);
    }
    if (running && e.echo) {
      const echoLines = String(e.echo).split('\n');
      echoLines.forEach((ln, i) => {
        const isLast = i === echoLines.length - 1;
        rows.push([{ text: truncateW(ln, INNER_W - 1) + (isLast ? '▏' : ''), sgr: 'paramHint' }]);
      });
    }
  }
  const base = Math.max(1, Number(state.config?.log_height) || 10);
  let budget = state.logExpanded ? base * 3 : base;
  const termRows = Number(state?.term?.rows) || 0;
  if (termRows > 0) budget = Math.max(1, Math.min(budget, termRows - LOG_RESERVED_ROWS));
  let finalRows = rows;
  let omitted = 0;
  if (rows.length > budget) {
    omitted = rows.length - budget;
    finalRows = rows.slice(-budget);
  }
  if (omitted > 0) {
    finalRows = [[{ text: TT('ui.log.omitted', { n: omitted }), sgr: 'dim' }], ...finalRows];
  }
  return { title: `${TT('ui.zone.log')} (${entries.length})`, count: entries.length, rows: finalRows, hidden: false };
}

/** 状态条右侧动态段（优先级：danger > notice > exit > running）。 */
function statusRight(state, TT) {
  const now = state.now || 0;
  if (state.danger && now - state.danger.at < FADE_MS) {
    return { text: state.danger.message, sgr: 'danger' };
  }
  if (state.notice && now - state.notice.at < FADE_MS) {
    return { text: state.notice.text, sgr: '' };
  }
  if (state.lastExit && now - state.lastExit.at < FADE_MS) {
    const code = state.lastExit.code;
    return code === 0
      ? { text: TT('ui.exit.ok', { code }), sgr: 'exitOk' }
      : { text: TT('ui.exit.fail', { code }), sgr: 'exitFail' };
  }
  if (state.mode === 'running') return { text: TT('ui.running'), sgr: 'dim' };
  return null;
}

/** 状态条全部文本段（zone 纯函数）：按键提示条（可配置隐藏）+ 动态段。
 *  框内提示条整条显示宽可能超过内容区（CJK/制表符按 2 列计），此时从尾部
 *  整项丢弃提示条条目，优先保住动态段（exit/danger/运行指示）不被截断；
 *  纯文本模式无宽度限制（maxW = Infinity）。 */
export function buildStatusSegs(state, TT, maxW = Infinity) {
  const right = statusRight(state, TT);
  const rightW = right ? padWidth(' │ ') + padWidth(right.text) : 0;
  const segs = [];
  if (state.config?.hint_bar !== false) {
    let hint = TT('ui.hintbar');
    if (padWidth(hint) + rightW > maxW) {
      const items = hint.split(' │ ');
      while (items.length > 1 && padWidth(items.join(' │ ')) + rightW > maxW) items.pop();
      hint = items.join(' │ ');
      if (padWidth(hint) + rightW > maxW) hint = truncateW(hint, Math.max(4, maxW - rightW - 1));
    }
    segs.push({ text: hint, sgr: 'dim' });
  }
  if (right) {
    segs.push({ text: ' │ ' });
    segs.push(right);
  }
  return segs;
}

// ───────────────────────── 纯文本降级渲染 ─────────────────────────

/** 纯文本渲染（分行标签、无框线；光标以 ▏ 内嵌表示）。 */
function renderPlain(state) {
  const TT = ttOf(state);
  const lines = [];
  lines.push(titleText(state, TT));
  const lz = buildLogZone(state, TT);
  if (!lz.hidden) {
    lines.push(`${TT('ui.plain.log')}(${lz.count}):`);
    for (const row of lz.rows) lines.push('  ' + row.map((s) => s.text).join(''));
  }
  const { text, cursor } = shownInput(state);
  const hint = state.mode === 'input' || state.mode === 'guide' ? pendingParamHint(state) : null;
  lines.push(`${TT('ui.plain.input')}: ${text.slice(0, cursor)}${hint || ''}▏${text.slice(cursor)}`);
  const syn = buildSyntaxZone(state, TT);
  if (syn) {
    lines.push(`${TT('ui.plain.syntax')}: ${syn.segs.map((s) => s.text).join('')}`);
    for (const anno of syn.anno) {
      const atext = anno.map((s) => s.text).join('');
      if (atext.trim()) lines.push(`  ${atext}`);
    }
  }
  const cz = buildCandidatesZone(state, TT);
  if (cz.rows.length || cz.count > 0) {
    // 候选区收缩（Esc 收起）但区标题保留
    lines.push(`${TT('ui.plain.candidates')}(${cz.count})${cz.pageLabel}:`);
    for (const row of cz.rows) lines.push('  ' + row.map((s) => s.text).join(''));
  }
  const dz = buildDetailZone(state, TT);
  if (dz.rows.length) {
    lines.push(`${TT('ui.plain.detail')}: ${dz.rows[0].map((s) => s.text).join('')}`);
    for (const row of dz.rows.slice(1)) lines.push('      ' + row.map((s) => s.text).join(''));
  }
  const segs = buildStatusSegs(state, TT);
  if (segs.length) lines.push(`${TT('ui.plain.status')}: ${segs.map((s) => s.text).join('')}`);
  return lines;
}

/** guide 态：≤5 行快速引导（两种模式同构）。 */
function renderGuide(state) {
  const TT = ttOf(state);
  return [1, 2, 3, 4, 5].map((n) => '  ' + TT(`ui.guide.${n}`));
}

/**
 * 纯文本降级行渲染（纯函数；不含末尾换行；guide 态返回引导行；exited 态返回 []）。
 * 生产 plain 路径（repl.mjs 直写终端）与测试契约（testHarness.renderAppLines）的单一真源。
 * @param {object} state UiState
 * @returns {string[]}
 */
export function renderPlainLines(state) {
  try {
    if (!state) return [];
    if (state.mode === 'exited') return [];
    if (state.mode === 'guide') return renderGuide(state);
    return renderPlain(state);
  } catch (err) {
    // 任何状态都不得让渲染抛错导致 REPL 崩溃
    return [`GitCue render error: ${err && err.message ? err.message : String(err)}`];
  }
}

// ───────────────────────── Ink 组件形态（ANSI 路径） ─────────────────────────

/** 取当前主题的样式表（config.theme==='contrast' → contrast，其余 default）。 */
function stylesOf(state) {
  return state.config?.theme === 'contrast' ? INK_STYLES.contrast : INK_STYLES.default;
}

/** 一行多段着色文本：segs 逐段映射为 <Text>（sgr → Ink 样式）。 */
function SegsLine({ segs, styles, width }) {
  const cut = width ? segsTruncate(segs, width) : segs;
  return h(
    Text,
    null,
    cut.map((s, i) => h(Text, { key: i, ...(s.sgr && styles[s.sgr] ? styles[s.sgr] : {}) }, s.text)),
  );
}

/** 区标题分隔行：─ <label> ───…（dim 色；填充宽按 padWidth 自算，不依赖 Ink 布局）。 */
function ZoneSeparator({ label }) {
  const head = `─ ${label} `;
  const fill = Math.max(0, BOX_W - padWidth(head));
  return h(Text, { dimColor: true }, head + '─'.repeat(fill));
}

/** 区1：标题行（GitCue ─ <cwd> (branch: <b>) / 非仓库提示）。 */
function TitleLine({ state }) {
  const TT = ttOf(state);
  return h(Text, { bold: true }, truncateW(titleText(state, TT), INNER_W));
}

/** 区2：输入行（git> 前缀 + 光标前文本 + [待填参数位] + █ 反色光标 + 光标后文本）。 */
function InputLine({ state, styles }) {
  const TT = ttOf(state);
  return h(SegsLine, { segs: inputSegs(state, TT), styles });
}

/** 区5：状态条（hintbar 可隐藏 + 动态段，1.5s 淡出读 state.now）。 */
function StatusLine({ state }) {
  const TT = ttOf(state);
  return h(SegsLine, { segs: buildStatusSegs(state, TT, INNER_W), styles: stylesOf(state) });
}

/** guide 态：≤5 行快速引导（ui.guide.1..5，两种模式同构）。 */
function GuideScreen({ state }) {
  const TT = ttOf(state);
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
    ...[1, 2, 3, 4, 5].map((n) => h(Text, { key: n }, '  ' + TT(`ui.guide.${n}`))),
  );
}

/** 主界面（input / running / output）：五区固定顺序，候选不足时收缩但区标题边界保留。 */
function MainScreen({ state }) {
  const TT = ttOf(state);
  const styles = stylesOf(state);
  const syn = buildSyntaxZone(state, TT);
  const cz = buildCandidatesZone(state, TT);
  const dz = buildDetailZone(state, TT);
  const lz = buildLogZone(state, TT);
  const synLines = syn ? [syn.segs, ...syn.anno.filter((a) => segsWidth(a) > 0)] : [];
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
    // 区1 标题
    h(TitleLine, { state }),
    // 区1.5 执行历史（内联形态：已执行命令与输出展示在窗口顶部；无历史时整区隐藏）
    ...(lz.hidden ? [] : [h(ZoneSeparator, { label: truncateW(lz.title, INNER_W) })]),
    ...lz.rows.map((row, i) => h(SegsLine, { key: `log${i}`, segs: row, styles })),
    // 区2 输入行
    h(InputLine, { state, styles }),
    // 区3 语法（标题边界恒在；内容行可有可无）
    h(ZoneSeparator, { label: TT('ui.zone.syntax') }),
    ...synLines.map((segs, i) => h(SegsLine, { key: `syn${i}`, segs, styles })),
    // 区4 候选（标题含总数与页码；Esc 收起时仅剩标题边界）
    h(ZoneSeparator, { label: truncateW(cz.title, INNER_W) }),
    ...cz.rows.map((row, i) => h(SegsLine, { key: `cand${i}`, segs: row, styles })),
    // 区5 详情（标题随选中项；无选中时仅标题边界）
    h(ZoneSeparator, { label: truncateW(dz.title, INNER_W) }),
    ...dz.rows.map((row, i) => h(SegsLine, { key: `det${i}`, segs: row, styles })),
    // 状态条分隔 + 状态条
    h(Text, { dimColor: true }, '─'.repeat(BOX_W)),
    h(StatusLine, { state }),
  );
}

/** plain 形态组件树（state.plain / theme='none' 的防御性支持；生产 plain 路径不经 Ink）。 */
function PlainScreen({ state }) {
  return h(
    Box,
    { flexDirection: 'column' },
    ...renderPlainLines(state).map((line, i) => h(Text, { key: i }, line)),
  );
}

/**
 * 根组件（ANSI 形态）：按 state.mode 分派 guide / 主界面；exited 或空 state 不渲染。
 * state.plain || config.theme==='none' 由 repl.mjs 在外层分流，本组件防御性回退 plain 行。
 * Ink 树本身不持有业务状态——state 由 controller 持有、repl.mjs 推送。
 * @param {{ state: object }} props
 */
export function GitcueApp({ state }) {
  if (!state || state.mode === 'exited') return null;
  if (state.mode === 'guide') return h(GuideScreen, { state });
  if (Boolean(state.plain) || state.config?.theme === 'none') return h(PlainScreen, { state });
  return h(MainScreen, { state });
}
