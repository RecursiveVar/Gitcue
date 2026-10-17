/**
 * 知识库数据校验。
 *
 * gitcue validate-data 的实现。与 test/data-*.test.mjs 中的自包含校验互为等价实现
 * （后者是数据入库门禁，本模块是运行时命令）。二者规则若需调整，应同步修改。
 *
 * 返回值绝不抛异常：任何文件级/条目级问题都记入 errors，由调用方决定退出码。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Param.kind 合法枚举 */
const PARAM_KINDS = new Set(['branch', 'tag', 'remote', 'commit', 'stash', 'pathspec', 'enum', 'text']);
/** 选项 key/别名格式 */
const OPTION_KEY_RE = /^(-[a-zA-Z0-9]|--[a-z0-9][a-z0-9-]*)$/;
/** literal key 格式 */
const LITERAL_KEY_RE = /^[a-z][a-z0-9-]*$/;
/** 命令名格式 */
const COMMAND_NAME_RE = /^[a-z][a-z0-9-]*$/;
/** since 版本格式 */
const SINCE_RE = /^\d+\.\d+$/;

/** Unicode 码点数 */
const cps = (s) => [...String(s)].length;
/** 按 。！？； 粗计句数 */
const sentences = (s) => [...String(s)].filter((ch) => '。！？；'.includes(ch)).length;

/**
 * 递归收集 grammar 中的全部 pattern 及其作用域（literal 路径数组）。
 * literal 匹配后只在 then 内匹配，命名冲突按作用域判定。
 * @param {object[]|undefined} grammar
 * @param {string[]} scope
 */
function collectPatterns(grammar, scope = []) {
  const out = [];
  for (const p of grammar ?? []) {
    out.push({ p, scope });
    if (p && p.type === 'literal' && Array.isArray(p.then)) {
      out.push(...collectPatterns(p.then, [...scope, p.key]));
    } else if (p && p.type === 'group' && Array.isArray(p.members)) {
      out.push(...collectPatterns(p.members, scope));
    }
  }
  return out;
}

/** 展开 pattern 的显式占名集合（key ∪ aliases）。 */
const namesOf = (p) => [p.key, ...(Array.isArray(p.aliases) ? p.aliases : [])];

/**
 * 占名展开：长选项 --x 生成隐式否定 --no-x（仅当未被显式认领）。
 * @param {object} p pattern
 * @param {Set<string>} claimed 条目内全部显式占名（option/literal 的 key ∪ aliases）
 * @returns {string[]}
 */
function expandedNames(p, claimed) {
  const forms = namesOf(p);
  if (p.type !== 'option') return [...forms];
  const out = [...forms];
  for (const f of forms) {
    if (typeof f === 'string' && f.startsWith('--')) {
      const neg = `--no-${f.slice(2)}`;
      if (!claimed.has(neg)) out.push(neg); // 显式优先：被认领则不生成
    }
  }
  return out;
}

/**
 * 校验单个条目文件（结构规则 + 占名展开后的两两不相交 + repeatable positional 提示）。
 * @param {string} file 文件路径（错误定位）
 * @param {string} baseName 不含扩展名的文件名（内置目录用于 command 一致性判定）
 * @param {boolean} requireNameMatch 内置目录要求 command 与文件名一致
 * @param {{errors: object[], warnings: string[]}} sink
 * @returns {boolean} 该条目是否零错误（计入 passed）
 */
function checkEntry(file, baseName, requireNameMatch, sink) {
  const err = (p, message) => sink.errors.push({ file, path: p, message });
  const warn = (message) => sink.warnings.push(`${file}: ${message}`);

  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    err('', `JSON 解析失败：${e && e.message ? e.message : e}`);
    return false;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err('', '条目必须是 JSON 对象');
    return false;
  }

  // —— schemaVersion 兼容 ——
  const sv = raw.schemaVersion;
  if (typeof sv !== 'string' || !/^\d+\.\d+$/.test(sv)) {
    err('schemaVersion', `应为形如 1.0 的字符串，实际 ${JSON.stringify(sv)}`);
    return false;
  }
  const [major, minor] = sv.split('.').map(Number);
  if (major !== 1 || minor > 1) {
    err('schemaVersion', `schema 大版本不兼容（当前 ${sv}，支持 1.0/向前兼容 1.1）`);
    return false;
  }

  // —— command 命名与文件名一致性 ——
  const name = raw.command;
  if (typeof name !== 'string' || !COMMAND_NAME_RE.test(name) || name.length === 0) {
    err('command', `命令名非法：${JSON.stringify(name)}`);
    return false;
  }
  if (requireNameMatch && name !== baseName) {
    err('command', `内置文件 command「${name}」与文件名「${baseName}」不一致`);
    return false;
  }

  // —— 条目级字段 ——
  if (!Number.isInteger(raw.popularity) || raw.popularity < 1 || raw.popularity > 5) {
    err('popularity', `应为 1–5 整数，实际 ${JSON.stringify(raw.popularity)}`);
  }
  if (typeof raw.summary !== 'string' || raw.summary.length === 0) {
    err('summary', '必填且为非空字符串');
  } else if (cps(raw.summary) > 40) {
    err('summary', `超过 40 码点（实际 ${cps(raw.summary)}）`);
  }
  if (raw.detail !== undefined && typeof raw.detail !== 'string') {
    err('detail', '应为字符串');
  }

  // —— grammar ——
  if (!Array.isArray(raw.grammar) || raw.grammar.length === 0) {
    err('grammar', '必须为非空数组');
    return false; // 结构性缺失：直接判不通过
  }

  /** 校验 Param */
  const checkParam = (param, where) => {
    if (typeof param !== 'object' || param === null || Array.isArray(param)) {
      err(`${where}.param`, '必须为对象');
      return;
    }
    if (!PARAM_KINDS.has(param.kind)) {
      err(`${where}.param.kind`, `kind 枚举非法（${JSON.stringify(param.kind)}）`);
      return;
    }
    if (typeof param.name !== 'string' || param.name.length === 0) {
      err(`${where}.param.name`, '必须为非空字符串');
    }
    if (param.kind === 'enum') {
      if (!Array.isArray(param.enum) || param.enum.length === 0) {
        err(`${where}.param.enum`, 'kind:"enum" 时 enum 须为非空数组');
      } else {
        if (new Set(param.enum).size !== param.enum.length) {
          err(`${where}.param.enum`, 'enum 值不得重复');
        }
        for (const v of param.enum) {
          if (typeof v !== 'string' || v.length === 0) err(`${where}.param.enum`, 'enum 值须为非空字符串');
        }
      }
    } else if (param.enum !== undefined) {
      err(`${where}.param.enum`, '仅 kind:"enum" 允许 enum 字段');
    }
  };

  // 逐 pattern 校验（含 literal.then / group.members 递归；scope 用于冲突按作用域判定）
  const all = collectPatterns(raw.grammar);
  for (const { p, scope } of all) {
    const where = `grammar${scope.length ? `[${scope.map((s) => `:${s}`).join('')}]` : ''}`;
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      err(where, 'pattern 必须是对象');
      continue;
    }
    const label = `${where}(${p.type ?? '?'}${p.key ? ` ${p.key}` : ''})`;

    if (p.type === 'group') {
        // group 仅有 type/mode/optional/members 四个字段，无 popularity/summary 等质量字段
      if (p.mode !== 'mutex' && p.mode !== 'repeat') err(`${label}.mode`, '应为 mutex|repeat');
      if (!Array.isArray(p.members) || p.members.length === 0) {
        err(`${label}.members`, '须为非空数组');
      } else if (p.members.some((m) => m && m.type === 'group')) {
        err(`${label}.members`, 'group 成员不得再嵌 group');
      }
      continue;
    }

    if (p.popularity !== undefined && (!Number.isInteger(p.popularity) || p.popularity < 1 || p.popularity > 5)) {
      err(`${label}.popularity`, `应为 1–5 整数，实际 ${JSON.stringify(p.popularity)}`);
    }
    if (typeof p.summary !== 'string' || p.summary.length === 0) {
      err(`${label}.summary`, '必填且为非空字符串');
    } else if (cps(p.summary) > 40) {
      err(`${label}.summary`, `超过 40 码点（实际 ${cps(p.summary)}）`);
    }
    if (p.detail !== undefined) {
      if (typeof p.detail !== 'string') err(`${label}.detail`, '应为字符串');
      else if (sentences(p.detail) > 3) err(`${label}.detail`, `超过 3 句（实际 ${sentences(p.detail)}）`);
    }
    if (p.example !== undefined && (typeof p.example !== 'string' || p.example.length === 0)) {
      err(`${label}.example`, '应为非空字符串');
    }
    if (p.since !== undefined && !(typeof p.since === 'string' && SINCE_RE.test(p.since))) {
      err(`${label}.since`, `应形如 2.35，实际 ${JSON.stringify(p.since)}`);
    }

    switch (p.type) {
      case 'option': {
        if (typeof p.key !== 'string' || !OPTION_KEY_RE.test(p.key)) {
          err(`${label}.key`, `选项 key 格式非法（${JSON.stringify(p.key)}）`);
        }
        const aliases = p.aliases ?? [];
        if (!Array.isArray(aliases)) {
          err(`${label}.aliases`, '应为数组');
        } else {
          if (new Set(aliases).size !== aliases.length) err(`${label}.aliases`, '别名不得重复');
          for (const a of aliases) {
            if (typeof a !== 'string' || !OPTION_KEY_RE.test(a)) err(`${label}.aliases`, `别名 ${JSON.stringify(a)} 格式非法`);
            if (a === p.key) err(`${label}.aliases`, '别名不得等于 key');
          }
        }
        if (p.param !== undefined && p.param !== null) checkParam(p.param, label);
        if (p.mutex !== undefined && p.mutex !== null && (typeof p.mutex !== 'string' || p.mutex.length === 0)) {
          err(`${label}.mutex`, '互斥组 ID 应为非空字符串');
        }
        break;
      }
      case 'positional': {
        if (p.key !== undefined) err(`${label}.key`, 'positional 不应有 key 字段');
        checkParam(p.param, label); // positional 必须有 param（checkParam 对缺失同样报错）
        break;
      }
      case 'literal': {
        if (typeof p.key !== 'string' || !LITERAL_KEY_RE.test(p.key)) {
          err(`${label}.key`, `literal key 格式非法（${JSON.stringify(p.key)}）`);
        }
        if (p.then !== undefined && !Array.isArray(p.then)) err(`${label}.then`, '应为数组');
        break;
      }
      case 'group':
        break; // 已在循环开头校验（group 无质量字段）
      default:
        err(label, `未知 pattern type「${JSON.stringify(p.type)}」`);
    }
  }

  // —— 占名展开后的两两不相交（按作用域）——
  const claimed = new Set(); // 条目内全部显式占名（显式优先判定）
  for (const { p } of all) {
    if (p && (p.type === 'option' || p.type === 'literal')) {
      for (const n of namesOf(p)) if (typeof n === 'string') claimed.add(n);
    }
  }
  const byScope = new Map(); // scopeKey → Map<form, label>
  for (const { p, scope } of all) {
    if (!p || (p.type !== 'option' && p.type !== 'literal')) continue;
    const scopeKey = scope.join('/') || '(root)';
    if (!byScope.has(scopeKey)) byScope.set(scopeKey, new Map());
    const owner = byScope.get(scopeKey);
    const label = `${p.type}${p.key ? ` ${p.key}` : ''}（scope: ${scopeKey}）`;
    for (const form of expandedNames(p, claimed)) {
      if (owner.has(form)) err('grammar', `占名「${form}」同时属于 ${owner.get(form)} 与 ${label}`);
      else owner.set(form, label);
    }
  }

  // —— repeatable positional 之后仍声明 positional → 信息性 warning（便于人工复核）——
  const walkOrdered = (patterns, where) => {
    let seenRepeatable = false;
    for (let i = 0; i < (patterns ?? []).length; i += 1) {
      const p = patterns[i];
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'positional') {
        if (seenRepeatable && p.repeatable !== true) {
          warn(`${where}[${i}]：repeatable positional 之后仍声明非 repeatable positional（请复核建模意图）`);
        }
        if (p.repeatable === true) seenRepeatable = true;
      } else if (p.type === 'group' && Array.isArray(p.members)) {
        walkOrdered(p.members, `${where}[${i}].members`);
      }
      // literal.then 是独立作用域，其内部序列单独判定
      if (p.type === 'literal' && Array.isArray(p.then)) walkOrdered(p.then, `${where}[${i}].then`);
    }
  };
  walkOrdered(raw.grammar, 'grammar');

  return sink.errors.length === 0;
}

/**
 * 校验知识库数据（gitcue validate-data 的实现）。
 * @param {{ dataDir: string, customDir?: string|null }} opts
 * @returns {{ ok: boolean, errors: [{file: string, path: string, message: string}], warnings: string[], passed: number }}
 */
export function validateData({ dataDir, customDir = null } = {}) {
  const errors = [];
  const warnings = [];
  let passed = 0;

  /** @type {(dir: string|null, requireNameMatch: boolean) => void} */
  const validateDir = (dir, requireNameMatch) => {
    if (!dir) return;
    let files = [];
    try {
      if (statSync(dir).isDirectory()) {
        files = readdirSync(dir)
          .filter((f) => f.toLowerCase().endsWith('.json'))
          .sort()
          .map((f) => path.join(dir, f));
      } else {
        warnings.push(`目录不存在或不是目录：${dir}`);
        return;
      }
    } catch {
      return; // 目录不存在：自定义目录合法状态，静默跳过
    }
    for (const file of files) {
      const sink = { errors: [], warnings: [] };
      const ok = checkEntry(file, path.basename(file, '.json'), requireNameMatch, sink);
      errors.push(...sink.errors);
      warnings.push(...sink.warnings);
      if (ok) passed += 1;
    }
  };

  // 内置目录：dataDir 可能指向 <root>/data（内含 commands/）或条目目录本身（与 loader 一致）
  let builtinDir = dataDir;
  try {
    if (statSync(path.join(dataDir, 'commands')).isDirectory()) builtinDir = path.join(dataDir, 'commands');
  } catch {
    /* 保持 dataDir 本身 */
  }
  validateDir(builtinDir, true);
  validateDir(customDir, false);

  return { ok: errors.length === 0, errors, warnings, passed };
}
