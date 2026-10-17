/**
 * 知识库加载/合并/编译。
 *
 * 职责：读取内置 data/ 目录与自定义目录下的 JSON 条目，做 schemaVersion 兼容判定，
 * 调用 compilePatterns 在"加载时一次完成"编译，并用 renderSkeleton 预生成
 * 完整骨架 syntaxFull。
 *
 * 加载失败策略：某文件 JSON 解析失败/结构非法/版本不兼容 →
 * 跳过该命令 + warnings 记录（不崩溃，运行时该命令视为未收录）；自定义文件同样跳过。
 * 自定义同名命令覆盖内置条目。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { compilePatterns } from '../parser/machine.mjs';
import { renderSkeleton } from '../parser/skeleton.mjs';

/** 本加载器支持的 schema 版本（major 必须一致；minor 向前兼容一档） */
export const SUPPORTED_SCHEMA = { major: 1, minor: 0, maxForwardMinor: 1 };

/**
 * 解析 '1.0' 形式的 schemaVersion 为 [major, minor]；非法返回 null。
 * @param {unknown} v
 * @returns {[number, number]|null}
 */
function parseSchemaVersion(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d+)\.(\d+)$/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/**
 * schemaVersion 兼容判定。
 * @returns {true|string} 兼容返回 true；不兼容返回告警文案
 */
function checkSchemaVersion(v) {
  const parsed = parseSchemaVersion(v);
  if (!parsed) return `schemaVersion「${String(v)}」非法，应为形如 1.0 的字符串`;
  const [major, minor] = parsed;
  if (major !== SUPPORTED_SCHEMA.major || minor > SUPPORTED_SCHEMA.minor + SUPPORTED_SCHEMA.maxForwardMinor) {
    return 'schema 大版本不兼容，请升级 GitCue';
  }
  return true;
}

/**
 * 把单个 JSON 条目规整为 KbEntry（不校验业务规则——那是 validate.mjs 的职责；
 * 此处只做防御性兜底，保证任何输入都不会让加载崩溃）。
 * @param {object} raw JSON.parse 结果
 * @param {string} file 来源文件（告警定位用）
 * @returns {{entry: object|null, warning: string|null}}
 */
function toEntry(raw, file) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { entry: null, warning: `${file}: 条目必须是 JSON 对象，已跳过` };
  }
  const ok = checkSchemaVersion(raw.schemaVersion);
  if (ok !== true) return { entry: null, warning: `${file}: ${ok}，已跳过` };

  const name = typeof raw.command === 'string' ? raw.command.trim() : '';
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
    return { entry: null, warning: `${file}: command「${name}」非法（须匹配 [a-z][a-z0-9-]*），已跳过` };
  }
  const grammar = Array.isArray(raw.grammar) ? raw.grammar : [];
  if (grammar.length === 0) {
    return { entry: null, warning: `${file}: grammar 为空，已跳过` };
  }

  let compiled;
  try {
    compiled = compilePatterns(name, grammar);
  } catch (err) {
    return { entry: null, warning: `${file}: grammar 编译失败（${err && err.message ? err.message : err}），已跳过` };
  }
  const syntaxFull = renderSkeleton({ commandName: name, compiled }).text;

  return {
    entry: {
      name,
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      popularity: Number.isInteger(raw.popularity) ? raw.popularity : 3,
      category: typeof raw.category === 'string' ? raw.category : 'porcelain',
      grammar: grammar.map((p) => ({ ...p })), // 浅拷贝，隔离调用方对 JSON 的意外改动
      compiled,
      syntaxFull,
      examples: Array.isArray(raw.examples)
        ? raw.examples.filter((e) => e && typeof e.cmd === 'string').map((e) => ({ cmd: e.cmd, note: e.note ?? '' }))
        : [],
      notes: Array.isArray(raw.notes) ? raw.notes.filter((n) => typeof n === 'string') : [],
    },
    warning: null,
  };
}

/**
 * 列出目录下全部 .json 文件（目录不存在返回 []；自定义目录允许不存在）。
 * @param {string|null} dir
 * @returns {string[]}
 */
function listJsonFiles(dir) {
  if (!dir) return [];
  let st;
  try {
    st = statSync(dir);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * 内置数据根目录 → 条目目录：兼容 dataDir 指向 <root>/data（内含 commands/ 子目录）
 * 或直接指向条目目录两种形态（接口漂移防御，两种都被接受）。
 * @param {string} dataDir
 * @returns {string}
 */
function resolveCommandsDir(dataDir) {
  const commandsSub = path.join(dataDir, 'commands');
  try {
    if (statSync(commandsSub).isDirectory()) return commandsSub;
  } catch {
    /* 无 commands 子目录：视 dataDir 本身为条目目录 */
  }
  return dataDir;
}

/**
 * 加载并合并知识库（内置 + 自定义覆盖）。
 * @param {{ dataDir: string, customDir?: string|null, lang?: string }} opts
 *   dataDir 内置数据根（<root>/data 或条目目录均可）；
 *   customDir 自定义命令目录（不存在时静默忽略）；
 *   lang 预留（骨架与文案语言由渲染层决定，加载期语言无关）。
 * @returns {{
 *   schemaVersion: string,
 *   commands: Map<string, object>,
 *   warnings: string[],
 *   get(name: string): object|undefined,
 *   names(): string[],
 * }} KbDb
 */
export function loadKnowledgeBase({ dataDir, customDir = null, lang = 'zh-CN' } = {}) {
  if (!dataDir || typeof dataDir !== 'string') {
    throw new Error('loadKnowledgeBase 需要 dataDir 参数');
  }
  const warnings = [];
  const commands = new Map();
  let passed = 0;

  /** 加载一个目录下的全部条目文件（后加载者覆盖同名，实现自定义覆盖内置） */
  const loadDir = (dir, { requireNameMatch }) => {
    for (const file of listJsonFiles(dir)) {
      let raw;
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        warnings.push(`${file}: JSON 解析失败（${err && err.message ? err.message : err}），已跳过`);
        continue;
      }
      if (requireNameMatch && raw && typeof raw.command === 'string' && raw.command !== path.basename(file, '.json')) {
        // 内置文件要求 command 与文件名一致（validate.mjs 同规则；加载期同样防御）
        warnings.push(`${file}: command「${raw.command}」与文件名不一致，已跳过`);
        continue;
      }
      const { entry, warning } = toEntry(raw, file);
      if (warning) {
        warnings.push(warning);
        continue;
      }
      commands.set(entry.name, entry);
      passed += 1;
    }
  };

  loadDir(resolveCommandsDir(dataDir), { requireNameMatch: true });
  loadDir(customDir, { requireNameMatch: false }); // 自定义条目以 command 字段为准

  if (passed === 0) warnings.push(`知识库为空：${dataDir} 下没有可用条目`);

  return {
    schemaVersion: `${SUPPORTED_SCHEMA.major}.${SUPPORTED_SCHEMA.minor}`,
    commands,
    warnings,
    /** @param {string} name */
    get(name) {
      return commands.get(name);
    },
    /** @returns {string[]} 全部命令名（命令候选用） */
    names() {
      return [...commands.keys()];
    },
  };
}
