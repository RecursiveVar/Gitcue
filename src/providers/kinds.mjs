/**
 * 六种占位符 kind 的动态候选采集定义。
 *
 * 文案口径：一行说明 ≤ 40 个 Unicode 码点，中文优先。
 * popularity 口径：当前分支=5、HEAD=5、HEAD~n=5−n 取整后 clamp 1–5、其余静态值=3。
 *
 * 本模块为纯函数库：不执行任何子进程、不读写文件系统（子进程由 hub.mjs 经注入的
 * runGit 执行，输出字符串传给 parse）。
 */

/**
 * @typedef {Object} DynItem 动态候选项
 * @property {string} value     补全插入值（如 'origin'、'main'、'stash@{0}'）
 * @property {string} label     展示文本（当前与 value 一致，保留字段便于后续扩展）
 * @property {string} summary   一行中文说明（≤ 40 码点）
 * @property {number} popularity 排序常用度 1–5
 * @property {string} kind      所属占位符 kind
 */

/**
 * @typedef {Object} KindQuery 一种 kind 的采集定义
 * @property {string} kind            kind 名
 * @property {string} label           kind 中文名（调试与兜底展示用）
 * @property {string[][]} argsList    只读 git 子命令参数表（每项一次调用，输出按序传给 parse）
 * @property {number|null} limit      候选数量上限（null = 不设独立上限）
 * @property {boolean} derived        true 表示无独立 git 调用、由其他 kind 快照派生（commit）
 * @property {string[]|null} derivedFrom 派生来源 kind 列表
 * @property {((outputs: string[], ctx: { currentBranch: string | null }) => DynItem[]) | null} parse
 *           解析函数：outputs 与 argsList 一一对应的 stdout；ctx 携带当前分支名（可为 null）
 */

/** 全部占位符 kind */
export const KINDS = ['branch', 'tag', 'remote', 'commit', 'stash', 'pathspec'];

/** 各 kind 候选数量上限（commit 无独立上限，由 branch/tag 上限自然约束） */
const LIMIT_BRANCH = 2000;
const LIMIT_TAG = 1000;
const LIMIT_REMOTE = 100;
const LIMIT_STASH = 100;
const LIMIT_PATHSPEC = 500;

/** HEAD~n 固定候选的最大回溯代数（HEAD~1..HEAD~9） */
const HEAD_BACK_MAX = 9;

/** 文本编码器/解码器（git 八进制转义路径还原用，Node 全局内置） */
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

/**
 * 构造一个 DynItem（value 与 label 一致的便捷工厂）。
 * @param {string} kind
 * @param {string} value
 * @param {string} summary
 * @param {number} popularity
 * @returns {DynItem}
 */
function makeItem(kind, value, summary, popularity) {
  return { value, label: value, summary, popularity, kind };
}

/**
 * 把多行 stdout 切分为非空行数组（兼容 CRLF，逐行去首尾空白）。
 * 适用于行内容不含有效首尾空白的输出（分支/标签/远程/贮藏名）。
 * @param {string} stdout
 * @returns {string[]}
 */
function splitLines(stdout) {
  if (!stdout) return [];
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * 把多行 stdout 切分为非空原始行（仅去 CRLF，不动首尾空白）。
 * porcelain 行的首字符是暂存区状态列、可能为空格，绝不能 trim（pathspec 专用）。
 * @param {string} stdout
 * @returns {string[]}
 */
function rawLines(stdout) {
  if (!stdout) return [];
  return stdout.split(/\r?\n/).filter((line) => line.length > 0);
}

/**
 * 还原 git 带引号的路径（core.quotePath 默认开启时，非 ASCII 与特殊字符路径
 * 形如 "\346\226\207.txt"：外层双引号 + C 风格转义，八进制为 UTF-8 字节序列）。
 * 非引号包裹的输入原样返回。
 * @param {string} raw
 * @returns {string}
 */
function unquoteGitPath(raw) {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const inner = raw.slice(1, -1);
  const bytes = [];
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1];
      // 命名转义（git 仅输出 \n \t \" \\ 四种）
      if (next === 'n') { bytes.push(0x0a); i += 2; continue; }
      if (next === 't') { bytes.push(0x09); i += 2; continue; }
      if (next === '"') { bytes.push(0x22); i += 2; continue; }
      if (next === '\\') { bytes.push(0x5c); i += 2; continue; }
      // 八进制转义：连续 3 位八进制表示一个字节
      const oct = inner.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(oct)) { bytes.push(parseInt(oct, 8)); i += 4; continue; }
      // 未知转义：按原字符处理
      bytes.push(ch.charCodeAt(0)); i += 1; continue;
    }
    // 普通字符按 UTF-8 字节追加
    for (const b of textEncoder.encode(ch)) bytes.push(b);
    i += 1;
  }
  return textDecoder.decode(new Uint8Array(bytes));
}

/**
 * git status --porcelain 的 XY 状态码 → 中文标记（已修改/未跟踪/已暂存；
 * 补充已删除与合并冲突以保证如实展示）。
 * @param {string} x 暂存区状态列
 * @param {string} y 工作区状态列
 * @returns {string}
 */
function porcelainSummary(x, y) {
  if (x === '?') return '未跟踪';
  // 合并冲突形态：UU/AA/DD/AU/UA/DU/UD
  const unmerged =
    x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
  if (unmerged) return '合并冲突';
  const staged = x !== ' ';
  const changed = y !== ' ';
  const deleted = x === 'D' || y === 'D';
  if (deleted) {
    if (staged && changed) return '已删除（暂存与工作区）';
    return staged ? '已暂存删除' : '已删除';
  }
  if (staged && changed) return '已暂存+已修改';
  if (staged) return '已暂存';
  if (changed) return '已修改';
  return '已跟踪';
}

/**
 * branch：`git for-each-ref refs/heads refs/remotes --format=%(refname:short)`
 * 当前分支 popularity=5 且说明"当前分支"，其余=3。
 * @type {KindQuery['parse']}
 */
function parseBranch(outputs, ctx) {
  const items = [];
  const seen = new Set();
  for (const line of splitLines(outputs[0] ?? '')) {
    const value = line;
    if (seen.has(value)) continue;
    seen.add(value);
    const isCurrent = ctx.currentBranch != null && value === ctx.currentBranch;
    items.push(makeItem('branch', value, isCurrent ? '当前分支' : '分支', isCurrent ? 5 : 3));
  }
  return items.slice(0, LIMIT_BRANCH);
}

/**
 * tag：`git for-each-ref refs/tags --format=%(refname:short)`
 * @type {KindQuery['parse']}
 */
function parseTag(outputs) {
  const items = [];
  const seen = new Set();
  for (const value of splitLines(outputs[0] ?? '')) {
    if (seen.has(value)) continue;
    seen.add(value);
    items.push(makeItem('tag', value, '标签', 3));
  }
  return items.slice(0, LIMIT_TAG);
}

/**
 * remote：`git remote`
 * @type {KindQuery['parse']}
 */
function parseRemote(outputs) {
  const items = [];
  const seen = new Set();
  for (const value of splitLines(outputs[0] ?? '')) {
    if (seen.has(value)) continue;
    seen.add(value);
    items.push(makeItem('remote', value, '远程仓库', 3));
  }
  return items.slice(0, LIMIT_REMOTE);
}

/**
 * stash：`git stash list --format=%gd`（输出形如 stash@{0}）
 * 说明：stash@{0} 为"最新贮藏"，其余按序号标注。
 * @type {KindQuery['parse']}
 */
function parseStash(outputs) {
  const items = [];
  const seen = new Set();
  for (const value of splitLines(outputs[0] ?? '')) {
    if (seen.has(value)) continue;
    seen.add(value);
    const m = /stash@\{(\d+)\}$/.exec(value);
    const index = m ? Number(m[1]) : null;
    const summary = index === 0 ? '最新贮藏' : index == null ? '贮藏' : `第 ${index + 1} 个贮藏`;
    items.push(makeItem('stash', value, summary, 3));
  }
  return items.slice(0, LIMIT_STASH);
}

/**
 * pathspec：`git status --porcelain`（带状态标记）∪ `git ls-files`（已跟踪），去重。
 * porcelain 条目优先（与用户当前意图更相关），重命名条目取新路径。
 * @type {KindQuery['parse']}
 */
function parsePathspec(outputs) {
  const map = new Map();
  for (const raw of rawLines(outputs[0] ?? '')) {
    // porcelain 行格式：XY<空格>path（X/Y 各一字符，至少 '?? x' 4 字符；X 可为空格）
    if (raw.length < 4) continue;
    let p = raw.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ').pop(); // 重命名取新路径
    p = unquoteGitPath(p);
    if (!p) continue;
    map.set(p, makeItem('pathspec', p, porcelainSummary(raw[0], raw[1]), 3));
  }
  for (const raw of rawLines(outputs[1] ?? '')) {
    const p = unquoteGitPath(raw);
    if (p && !map.has(p)) map.set(p, makeItem('pathspec', p, '已跟踪', 3));
  }
  return [...map.values()].slice(0, LIMIT_PATHSPEC);
}

/**
 * commit：派生 kind（无独立 git 调用）——
 * 固定值 HEAD, HEAD~1..HEAD~9 + branch 快照 + tag 快照，按 value 去重。
 * popularity：HEAD=5；HEAD~n = clamp(5−n, 1, 5)；branch/tag 项沿用各自 popularity。
 * @param {DynItem[]} branchItems branch kind 的快照项
 * @param {DynItem[]} tagItems tag kind 的快照项
 * @returns {DynItem[]}
 */
export function buildCommitItems(branchItems, tagItems) {
  const out = [];
  const seen = new Set();
  /** @param {DynItem} it */
  const push = (it) => {
    if (seen.has(it.value)) return;
    seen.add(it.value);
    out.push(it);
  };
  push(makeItem('commit', 'HEAD', '当前提交', 5));
  for (let n = 1; n <= HEAD_BACK_MAX; n += 1) {
    const popularity = Math.max(1, Math.min(5, 5 - n));
    push(makeItem('commit', `HEAD~${n}`, `HEAD 往前 ${n} 个提交`, popularity));
  }
  for (const it of branchItems) push({ ...it, kind: 'commit' });
  for (const it of tagItems) push({ ...it, kind: 'commit' });
  return out;
}

/**
 * 每 kind 的采集定义。
 * @type {Record<string, KindQuery>}
 */
export const KIND_QUERIES = {
  branch: {
    kind: 'branch',
    label: '分支',
    argsList: [['for-each-ref', 'refs/heads', 'refs/remotes', '--format=%(refname:short)']],
    limit: LIMIT_BRANCH,
    derived: false,
    derivedFrom: null,
    parse: parseBranch,
  },
  tag: {
    kind: 'tag',
    label: '标签',
    argsList: [['for-each-ref', 'refs/tags', '--format=%(refname:short)']],
    limit: LIMIT_TAG,
    derived: false,
    derivedFrom: null,
    parse: parseTag,
  },
  remote: {
    kind: 'remote',
    label: '远程',
    argsList: [['remote']],
    limit: LIMIT_REMOTE,
    derived: false,
    derivedFrom: null,
    parse: parseRemote,
  },
  stash: {
    kind: 'stash',
    label: '贮藏',
    argsList: [['stash', 'list', '--format=%gd']],
    limit: LIMIT_STASH,
    derived: false,
    derivedFrom: null,
    parse: parseStash,
  },
  pathspec: {
    kind: 'pathspec',
    label: '路径',
    // 两条命令：porcelain（带状态标记）在前，ls-files（已跟踪全集）在后
    argsList: [['status', '--porcelain'], ['ls-files']],
    limit: LIMIT_PATHSPEC,
    derived: false,
    derivedFrom: null,
    parse: parsePathspec,
  },
  commit: {
    kind: 'commit',
    label: '提交',
    argsList: [],
    limit: null,
    derived: true,
    derivedFrom: ['branch', 'tag'],
    parse: null, // 派生 kind：由 hub 调 buildCommitItems 组装，无独立解析
  },
};
