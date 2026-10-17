/**
 * 按键 reducer（`src/ui/reducer.mjs`）。
 *
 * 三个导出均为纯函数：不做 IO、不读时钟（时间一律读 state.now）、不改入参
 * （结构共享返回新对象），因此可以无头单测：按键序列驱动状态变迁并断言渲染行。
 *
 * 注意：`state.view`（SuggestResult）由 controller 在每次"行/模式变化"后经
 * attachView 挂载，reducer 只读取其 candidates / active / tokens / corrections。
 */

/**
 * 配置兜底值（与 src/config.mjs 的 `DEFAULT_CONFIG` 逐字段一致）。
 * controller/bin 装配层应传入已解析配置；此表仅保证 createInitialState
 * 在配置缺项时仍有确定行为（不 import config.mjs，避免装配层耦合）。
 */
const FALLBACK_CONFIG = Object.freeze({
  lang: 'zh-CN',
  candidate_limit: 8,
  theme: 'default',
  enter_action: 'exec',
  history_enabled: true,
  history_limit: 1000,
  danger_warning: true,
  dynamic_cache_seconds: 30,
  custom_command_dir: '',
  pager: 'cat',
  hint_bar: true,
  exec_output: 'passthrough',
  log_height: 10,
});

/** 历史区最多保留的执行条目数（防状态无界增长） */
const MAX_LOG_ENTRIES = 50;
/** 单条执行输出最多保留的字符数（保尾弃头，前缀截断标记） */
const MAX_OUTPUT_CHARS = 40_000;
const OUTPUT_TRUNC_MARK = '…（输出过长，仅保留末尾）\n';

/**
 * 构造初始 UiState。
 * @param {{ config?: object, lang?: string, plain?: boolean,
 *           repo?: { isRepo: boolean|null, branch: string|null, cwd: string },
 *           showGuide?: boolean, now?: number }} [opts]
 * @returns {object} UiState
 */
export function createInitialState({
  config = {},
  lang,
  plain = false,
  repo = { isRepo: false, branch: null, cwd: process.cwd() },
  showGuide = false,
  now = 0,
} = {}) {
  const merged = { ...FALLBACK_CONFIG, ...config };
  return {
    mode: showGuide ? 'guide' : 'input',
    line: '',
    cursor: 0,
    selected: 0,
    page: 0,
    detailOpen: false,
    dismissed: false,
    historyList: [],
    historyIndex: null,
    historyDraft: '',
    ctrlcCount: 0,
    lastExit: null,
    danger: null,
    notice: null,
    runningLine: '',
    /** 执行历史区（内联形态）：[{ cmd, output, echo, code, at }]，见 beginExec */
    execLog: [],
    /** F2：历史区展开（默认 1×，展开 3×） */
    logExpanded: false,
    view: null,
    config: merged,
    lang: lang ?? merged.lang ?? 'zh-CN',
    plain,
    repo: {
      isRepo: repo.isRepo === null ? false : Boolean(repo.isRepo),
      branch: repo.branch ?? null,
      cwd: repo.cwd ?? '',
    },
    now: now ?? 0,
  };
}

// ───────── 执行历史区（内联形态；controller 调用的纯状态变迁） ─────────

/**
 * 新建一条执行条目（Enter 执行时调用；最多保留 MAX_LOG_ENTRIES 条，旧的丢弃）。
 * @param {object} state UiState
 * @param {string} cmd 即将执行的完整命令行
 * @param {number} at 时间戳（state.now 口径，由 controller 传入）
 */
export function beginExec(state, cmd, at) {
  const entry = { cmd: String(cmd ?? ''), output: '', echo: '', code: null, at: at ?? 0 };
  const entries = [...(state.execLog || []), entry];
  const dropped = Math.max(0, entries.length - MAX_LOG_ENTRIES);
  return { ...state, execLog: dropped > 0 ? entries.slice(dropped) : entries };
}

/**
 * 追加子进程输出文本（内联模式流式回调；可含不完整行）。
 * 单条输出超 MAX_OUTPUT_CHARS 时保尾弃头并加截断标记。
 */
export function appendExecOutput(state, text) {
  const log = state.execLog || [];
  if (!log.length) return state;
  const last = log[log.length - 1];
  let output = last.output + String(text ?? '');
  if (output.length > MAX_OUTPUT_CHARS) {
    output = OUTPUT_TRUNC_MARK + output.slice(output.length - (MAX_OUTPUT_CHARS - OUTPUT_TRUNC_MARK.length));
  }
  const execLog = log.slice(0, -1).concat({ ...last, output });
  return { ...state, execLog };
}

/** 执行结束：记录退出码并清空输入回显缓冲。 */
export function endExec(state, code) {
  const log = state.execLog || [];
  if (!log.length) return state;
  const last = log[log.length - 1];
  const execLog = log.slice(0, -1).concat({ ...last, code: typeof code === 'number' ? code : 0, echo: '' });
  return { ...state, execLog };
}

/** 执行态按键 → 转发给子进程的字节（printable/enter/backspace/tab/delete/arrow；其余返回 null）。
 *  真实终端下这些键本就以等价字节序列到达，此处按解码事件重建，行为一致。 */
export function forwardBytesOf(key) {
  if (!key) return null;
  switch (key.type) {
    case 'printable':
      return key.ch;
    case 'enter':
      return '\r';
    case 'tab':
      return '\t';
    case 'backspace':
      return '\x7f';
    case 'delete':
      return '\x1b[3~';
    case 'arrow':
      return { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' }[key.dir] || null;
    default:
      return null;
  }
}

/** 执行态回显编辑：printable 追加、backspace 删末字符、enter 换行（子进程 pipe stdin
 *  无终端回显，由界面代为回显，行式交互提示（如 add -p）可见）。 */
function editEcho(state, key) {
  const log = state.execLog || [];
  if (!log.length) return state;
  const last = log[log.length - 1];
  let echo = last.echo;
  if (key.type === 'printable') echo += key.ch;
  else if (key.type === 'enter') echo += '\n';
  else if (key.type === 'backspace') echo = echo.slice(0, -1);
  else return state;
  const execLog = log.slice(0, -1).concat({ ...last, echo });
  return { ...state, execLog };
}

/** 求多条字符串的最长公共前缀（LCP）。 */
function commonPrefix(strs) {
  if (!strs.length) return '';
  let prefix = strs[0];
  for (const s of strs) {
    let i = 0;
    const n = Math.min(prefix.length, s.length);
    while (i < n && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

/** 候选同屏页大小（config.candidate_limit，至少 1）。 */
function pageSizeOf(state) {
  return Math.max(1, Number(state.config?.candidate_limit) || 8);
}

/** 非法/未知按键统一忽略；任何非 ctrl-c 键都会清零 ctrlcCount。 */
function normalize(state, key, next) {
  const isCtrlC = key && key.type === 'ctrl' && key.ch === 'c';
  if (isCtrlC) return next === state ? { ...state } : next;
  if (next === state && state.ctrlcCount === 0) return state;
  return { ...next, ctrlcCount: 0 };
}

/** 在光标处插入文本（活动词为空 / 空行场景），并解除候选浮层关闭态。 */
function insertAtCursor(state, text) {
  const { line, cursor } = state;
  return {
    ...state,
    line: line.slice(0, cursor) + text + line.slice(cursor),
    cursor: cursor + text.length,
    dismissed: false,
  };
}

/** 用 newText 替换行内 [start,end) 区间（活动词或 unknown Token 的替换补全）。 */
function replaceSpan(state, start, end, newText) {
  const line = state.line;
  return {
    ...state,
    line: line.slice(0, start) + newText + line.slice(end),
    cursor: start + newText.length,
    dismissed: false,
  };
}

/** Token 级替换：newText 以空格结尾且被替换区间后紧跟空格时吞并后者（避免双空格）。 */
function replaceToken(state, span, newText) {
  let end = span.end;
  if (newText.endsWith(' ') && state.line[end] === ' ') end += 1;
  return replaceSpan(state, span.start, end, newText);
}

/**
 * Tab 补全算法：
 *  1) correction：用 insert 替换活动/unknown Token；
 *  2) placeholder（insert === ''）：不改行（展开请求由 controller 检测后 ensure 动态数据）；
 *  3) 单候选：插入候选文本 + 尾随空格（paramHint 只作渲染提示，不插入实际字符）；
 *  4) 多候选且活动词非空：先补 LCP；LCP 无进展时采纳当前高亮候选
 *     （以 selected 高亮项为默认采纳对象）；
 *  5) 活动词为空：采纳高亮候选；
 *  6) 无候选：无操作。
 */
function applyTab(state) {
  const view = state.view;
  const cands = (view && view.candidates) || [];
  if (!cands.length) return state;
  const selIdx = Math.min(Math.max(state.selected, 0), cands.length - 1);
  const cand = cands[selIdx];
  const active = (view && view.active) || null;

  // 1) 纠错候选：替换目标 Token
  if (cand.kind === 'correction') {
    const span = correctionSpan(view, active);
    if (!span) return { ...state, dismissed: false };
    const text = typeof cand.insert === 'string' && cand.insert !== '' ? cand.insert : cand.text;
    return replaceToken(state, span, text + ' ');
  }
  // 2) 占位符候选：不改行（动态候选展开由 controller 触发）
  if (cand.insert === '') return { ...state, dismissed: false };
  // 3) 唯一候选：整词补全 + 尾随空格
  if (cands.length === 1) {
    if (active && active.text) return replaceToken(state, active, cand.text + ' ');
    return insertAtCursor(state, cand.text + ' ');
  }
  // 4) 多候选
  if (active && active.text) {
    const lcp = commonPrefix(cands.map((c) => c.text));
    if (lcp.length > active.text.length) return replaceSpan(state, active.start, active.end, lcp);
    if (cand.text.startsWith(active.text)) {
      return replaceToken(state, active, cand.text + ' ');
    }
    return { ...state, dismissed: false };
  }
  // 5) 活动词为空：采纳高亮候选
  return insertAtCursor(state, cand.text + ' ');
}

/**
 * 确定纠错候选的替换目标：优先活动词；否则取 corrections[0] 指向的已完成 Token
 * （index 与 tokens 对齐，SuggestResult 契约；文本不一致时回退按文本查找）。
 */
function correctionSpan(view, active) {
  if (active) return active;
  const c0 = view && view.corrections && view.corrections[0];
  if (!c0) return null;
  const tokens = (view && view.tokens) || [];
  let tok = tokens[c0.index];
  if (!tok || tok.text !== c0.token) {
    tok = tokens.find((t) => t && t.text === c0.token && t.text !== 'git') || null;
  }
  return tok;
}

/** 历史回溯：↑ 前进（更旧），首次进入时保存当前草稿。 */
function historyPrev(state) {
  const list = state.historyList;
  if (!list.length) return state;
  const idx = state.historyIndex === null ? 0 : Math.min(state.historyIndex + 1, list.length - 1);
  const draft = state.historyIndex === null ? state.line : state.historyDraft;
  return {
    ...state,
    historyIndex: idx,
    historyDraft: draft,
    line: list[idx],
    cursor: list[idx].length,
  };
}

/** 历史回溯：↓ 后退（更新），越过最近一条时恢复草稿并退出回溯。 */
function historyNext(state) {
  if (state.historyIndex === null) return state;
  const idx = state.historyIndex - 1;
  if (idx < 0) {
    return {
      ...state,
      line: state.historyDraft,
      cursor: state.historyDraft.length,
      historyIndex: null,
      historyDraft: '',
    };
  }
  return { ...state, historyIndex: idx, line: state.historyList[idx], cursor: state.historyList[idx].length };
}

/** guide / output 态任意键回到 input；printable 键同时把字符插入行（防吞键）。 */
function resumeInput(state, key) {
  const base = { ...state, mode: 'input' };
  if (key && key.type === 'printable') return insertPrintable(base, key.ch);
  return base;
}

/** 在光标处插入一个可打印字符。 */
function insertPrintable(state, ch) {
  const { line, cursor } = state;
  return {
    ...state,
    line: line.slice(0, cursor) + ch + line.slice(cursor),
    cursor: cursor + ch.length,
    dismissed: false,
  };
}

/** input 态按键分发。 */
function inInput(state, key) {
  const next = inInputDispatch(state, key);
  // 历史回溯中行内容被编辑（打字/删除/Tab 采纳等任何改行内容的键；↑↓ 回溯本身除外）
  // → 退出回溯态：此后 ↑↓ 回归"有候选选候选"语义，不再被劫持为历史浏览
  //   （编辑命令行产生候选后，↑↓ 必须用于选择补全选项；需再次回溯时回到空行按 ↑）
  if (
    next !== state &&
    state.historyIndex !== null &&
    !(key && key.type === 'arrow' && (key.dir === 'up' || key.dir === 'down')) &&
    next.line !== state.line
  ) {
    return { ...next, historyIndex: null, historyDraft: '' };
  }
  return next;
}

function inInputDispatch(state, key) {
  const t = key ? key.type : '';
  switch (t) {
    case 'printable':
      return insertPrintable(state, key.ch);

    case 'enter': {
      if (state.line === '') return state;
      // enter_action='complete'：有高亮候选且活动词非空 → 先补全不执行
      if (state.config?.enter_action === 'complete') {
        const cands = (state.view && state.view.candidates) || [];
        const active = state.view && state.view.active;
        if (cands.length && active && active.text) return applyTab(state);
      }
      // 命令移交 runningLine 展示，输入行复位为空（执行完 ↑ 可回溯历史）
      return {
        ...state,
        mode: 'running',
        runningLine: state.line,
        line: '',
        cursor: 0,
        selected: 0,
        page: 0,
        historyIndex: null,
        historyDraft: '',
      };
    }

    case 'tab':
      return applyTab(state);

    case 'backspace': {
      if (state.cursor > 0) {
        return {
          ...state,
          line: state.line.slice(0, state.cursor - 1) + state.line.slice(state.cursor),
          cursor: state.cursor - 1,
        };
      }
      if (state.line === '') return { ...state, danger: null, notice: null }; // 行空时清提示
      return state;
    }

    case 'delete': {
      const { line, cursor } = state;
      if (cursor < line.length) {
        return { ...state, line: line.slice(0, cursor) + line.slice(cursor + 1) };
      }
      return state;
    }

    case 'arrow': {
      if (key.dir === 'left') return { ...state, cursor: Math.max(0, state.cursor - 1) };
      if (key.dir === 'right') return { ...state, cursor: Math.min(state.line.length, state.cursor + 1) };
      // 历史回溯进行中（historyIndex 非空）：↑↓ 持续浏览（「第二次以后 ↑ 可
      // 回溯」）——即使回溯出的行产生了候选也不切换为候选高亮，直至行内容被编辑退出
      // 回溯态（见 inInput 的收尾规则）或 ↓ 越过最近一条恢复草稿。
      // 注：此分支必须先于候选高亮判定，否则回溯出的命令行一旦带候选，第二次 ↑ 会被
      // 高亮移动抢占，回溯被截断。
      if (state.historyIndex !== null) {
        return key.dir === 'up' ? historyPrev(state) : historyNext(state);
      }
      const cands = (state.view && state.view.candidates) || [];
      // 有候选且未关闭浮层 → 移动高亮（跨页自动翻页）
      if (cands.length && !state.dismissed) {
        const sel =
          key.dir === 'down'
            ? Math.min(state.selected + 1, cands.length - 1)
            : Math.max(state.selected - 1, 0);
        const limit = pageSizeOf(state);
        return { ...state, selected: sel, page: Math.floor(sel / limit) };
      }
      // 空行且无候选（或已关闭浮层）时 ↑ 进入回溯
      if (state.line === '' && (cands.length === 0 || state.dismissed)) {
        return key.dir === 'up' ? historyPrev(state) : historyNext(state);
      }
      return state;
    }

    case 'page': {
      const cands = (state.view && state.view.candidates) || [];
      const limit = pageSizeOf(state);
      const pages = Math.max(1, Math.ceil(cands.length / limit));
      const np = Math.max(0, Math.min(pages - 1, state.page + (key.dir === 'down' ? 1 : -1)));
      const sel = Math.max(0, Math.min(cands.length - 1, np * limit));
      return { ...state, page: np, selected: sel };
    }

    case 'home':
      return { ...state, cursor: 0 };

    case 'end':
      return { ...state, cursor: state.line.length };

    case 'function':
      if (key.n === 1) return { ...state, detailOpen: !state.detailOpen };
      // F2：历史区展开/收起（默认 1× ↔ 3×）
      if (key.n === 2) return { ...state, logExpanded: !state.logExpanded };
      return state;

    case 'ctrl': {
      switch (key.ch) {
        case 'a':
          return { ...state, cursor: 0 };
        case 'e':
          return { ...state, cursor: state.line.length };
        case 'u':
          return {
            ...state,
            line: '',
            cursor: 0,
            selected: 0,
            page: 0,
            dismissed: false,
            historyIndex: null,
            historyDraft: '',
          };
        case 'w': {
          const { line, cursor } = state;
          let i = cursor;
          while (i > 0 && line[i - 1] === ' ') i--; // 跳过光标前空白
          while (i > 0 && line[i - 1] !== ' ') i--; // 退到词首
          if (i === cursor) return state;
          return { ...state, line: line.slice(0, i) + line.slice(cursor), cursor: i };
        }
        case 'q':
          return { ...state, mode: 'exited' };
        case '?':
          return { ...state, detailOpen: !state.detailOpen }; // Ctrl+? 与 F1 同义
        case 'c': {
          const count = state.ctrlcCount + 1;
          if (count >= 2) return { ...state, ctrlcCount: count, mode: 'exited' };
          // 第一次：清空当前输入（取消当前输入）
          return {
            ...state,
            ctrlcCount: count,
            line: '',
            cursor: 0,
            historyIndex: null,
            historyDraft: '',
          };
        }
        default:
          return state; // 'space' 等在解码层已被丢弃，此分支仅兜底
      }
    }

    case 'escape': {
      if (!state.dismissed) return { ...state, dismissed: true };
      // 第二次 Esc：清空输入行并复位
      return {
        ...state,
        line: '',
        cursor: 0,
        selected: 0,
        page: 0,
        detailOpen: false,
        dismissed: false,
        historyIndex: null,
        historyDraft: '',
      };
    }

    default:
      return state; // 未知键忽略
  }
}

/**
 * 按键 reducer（纯函数）。
 * @param {object} state 当前 UiState（不会被修改）
 * @param {object} key Key 事件（见 keys.mjs 的 Key typedef）
 * @returns {object} 新 UiState
 */
export function handleKey(state, key) {
  switch (state.mode) {
    case 'exited':
      return state;
    case 'guide':
    case 'output':
      return normalize(state, key, resumeInput(state, key));
    case 'running': {
      // 执行态（内联形态）：Ctrl+C 中断子进程并返回输入态（cancel 由 controller 调
      // exec.cancel）；可转发键编辑回显缓冲（字节转发由 controller 依据 forwardBytesOf
      // 完成）；其余按键忽略
      if (key && key.type === 'ctrl' && key.ch === 'c') return { ...state, mode: 'input' };
      return editEcho(state, key);
    }
    case 'input':
    default:
      return normalize(state, key, inInput(state, key));
  }
}

/**
 * 挂载最新 suggest 结果并钳制 selected/page（controller 在行/模式变化后调用）。
 * 高亮下标钳制到候选数内；分页号跟随高亮项所在页，保证高亮始终可见。
 * @param {object} state 当前 UiState
 * @param {object|null} view SuggestResult（可为 null）
 * @returns {object} 新 UiState
 */
export function attachView(state, view) {
  const cands = (view && view.candidates) || [];
  const limit = pageSizeOf(state);
  const selected = cands.length ? Math.min(Math.max(state.selected, 0), cands.length - 1) : 0;
  const page = cands.length ? Math.floor(selected / limit) : 0;
  return { ...state, view, selected, page };
}
