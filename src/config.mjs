/**
 * 配置加载。
 *
 * 合并顺序：DEFAULT_CONFIG ← <GITCUE_HOME>/config.toml ← <cwd>/.gitcue.toml ← cli 覆盖(lang)。
 * 非法项（未知键 / 类型不符 / 越界）一律告警并回退默认值。
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 默认配置（冻结对象；键表即合法配置项集合） */
export const DEFAULT_CONFIG = Object.freeze({
  lang: 'zh-CN',             // 'zh-CN' | 'en-US'
  candidate_limit: 8,        // 候选同屏条数
  theme: 'default',          // 'default' | 'contrast' | 'none'（none=强制纯文本）
  enter_action: 'exec',      // 'exec' | 'complete'
  history_enabled: true,
  history_limit: 1000,
  danger_warning: true,
  dynamic_cache_seconds: 30, // 动态缓存 TTL
  custom_command_dir: '',    // 空 = <GITCUE_HOME>/commands
  pager: 'cat',
  hint_bar: true,            // 底部按键提示条
  exec_output: 'passthrough', // 'passthrough'（默认）：执行时让出终端、子进程 stdio inherit
                              //   原样直写终端（与不用 gitcue 直接敲 git 的观感一致，保留颜色
                              //   与完全交互）；'inline'：输出捕获进窗口顶部历史区（全屏形态，
                              //   单窗口常驻偏好者可用配置改回）
  log_height: 10,            // 历史区默认显示行数（F2 展开为 3 倍）
});

/** 各配置项的取值校验器：合法返回规范化值，非法返回 null */
const VALIDATORS = {
  lang: (v) => (typeof v === 'string' && ['zh-CN', 'en-US'].includes(v) ? v : null),
  theme: (v) => (typeof v === 'string' && ['default', 'contrast', 'none'].includes(v) ? v : null),
  enter_action: (v) => (typeof v === 'string' && ['exec', 'complete'].includes(v) ? v : null),
  exec_output: (v) => (typeof v === 'string' && ['inline', 'passthrough'].includes(v) ? v : null),
  custom_command_dir: (v) => (typeof v === 'string' ? v : null),
  pager: (v) => (typeof v === 'string' ? v : null),
  history_enabled: (v) => (typeof v === 'boolean' ? v : null),
  danger_warning: (v) => (typeof v === 'boolean' ? v : null),
  hint_bar: (v) => (typeof v === 'boolean' ? v : null),
  candidate_limit: intAtLeast(1),
  history_limit: intAtLeast(1),
  dynamic_cache_seconds: intAtLeast(0),
  log_height: (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 50 ? v : null),
};

/** 整数且 ≥ min 的校验器工厂 */
function intAtLeast(min) {
  return (v) => (typeof v === 'number' && Number.isInteger(v) && v >= min ? v : null);
}

/**
 * GITCUE_HOME 解析：env.GITCUE_HOME || ~/.gitcue。
 * 说明：默认落到真实用户主目录是产品语义（允许）；本项目所有测试必须显式设置
 * GITCUE_HOME 指向 .sandbox/ 内目录（安全边界）。
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveHome(env = process.env) {
  const p = env && env.GITCUE_HOME;
  if (typeof p === 'string' && p !== '') return p;
  return path.join(os.homedir(), '.gitcue');
}

/** 去掉行内注释（# 仅在双引号字符串外生效） */
function stripComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\') i++; // 跳过转义的下一字符
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * 解析标量值：双引号字符串（支持 \" 与 \\ 转义）/ true / false / 十进制整数。
 * @param {string} raw 已 trim 的值文本
 * @returns {{ok:true, value:string|number|boolean}|{ok:false}}
 */
function parseScalar(raw) {
  if (raw === 'true') return { ok: true, value: true };
  if (raw === 'false') return { ok: true, value: false };
  if (/^-?\d+$/.test(raw)) return { ok: true, value: Number(raw) };
  if (!raw.startsWith('"')) return { ok: false };
  let out = '';
  for (let i = 1; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\') {
      const next = raw[i + 1];
      // 仅支持 \" 与 \\，其余转义视为非法
      if (next === '"' || next === '\\') {
        out += next;
        i++;
        continue;
      }
      return { ok: false };
    }
    if (ch === '"') {
      // 闭引号必须是最后一个字符
      return i === raw.length - 1 ? { ok: true, value: out } : { ok: false };
    }
    out += ch;
  }
  return { ok: false }; // 未闭合
}

/**
 * 解析 mini-TOML 文本（仅 `key = 标量` 行，# 注释）。
 * @param {string} text
 * @returns {{ values: Record<string, string|number|boolean>, errors: string[] }}
 */
export function parseToml(text) {
  const values = {};
  const errors = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (line === '') continue;
    const m = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!m) {
      errors.push(`第 ${i + 1} 行：无法解析 "${line}"`);
      continue;
    }
    const [, key, rawVal] = m;
    const parsed = parseScalar(rawVal.trim());
    if (!parsed.ok) {
      errors.push(`第 ${i + 1} 行：${key} 的值无法解析 "${rawVal.trim()}"`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      errors.push(`第 ${i + 1} 行：重复的配置项 ${key}`);
      continue;
    }
    values[key] = parsed.value;
  }
  return { values, errors };
}

/** 值的可读描述（用于告警文案） */
function describe(v) {
  return typeof v === 'string' ? `"${v}"` : String(v);
}

/** 把一层解析出的 values 应用到 config 上，非法项写 warnings 并保持默认 */
function applyValues(config, values, srcLabel, warnings) {
  for (const [key, value] of Object.entries(values)) {
    const validator = VALIDATORS[key];
    if (!validator) {
      warnings.push(`${srcLabel}：未知配置项 "${key}"，已忽略`);
      continue;
    }
    const normalized = validator(value);
    if (normalized === null) {
      warnings.push(
        `${srcLabel}：配置项 "${key}" 的值 ${describe(value)} 非法，已回退默认值 ${describe(config[key])}`,
      );
      continue;
    }
    config[key] = normalized;
  }
}

/**
 * 加载配置：DEFAULT_CONFIG ← GITCUE_HOME/config.toml ← <cwd>/.gitcue.toml ← cli 覆盖(lang)。
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, cliLang?: string|null }} opts
 * @returns {{ config: typeof DEFAULT_CONFIG, warnings: string[], files: string[] }}
 *          files 为实际读取并应用的配置文件路径（用户级在前、项目级在后）。
 */
export function loadConfig({ env = process.env, cwd = process.cwd(), cliLang = null } = {}) {
  const warnings = [];
  const files = [];
  const config = { ...DEFAULT_CONFIG };
  const home = resolveHome(env);
  const candidates = [path.join(home, 'config.toml'), path.join(cwd, '.gitcue.toml')];
  for (const file of candidates) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // 文件不存在 → 跳过该层
    }
    files.push(file);
    const { values, errors } = parseToml(text);
    for (const e of errors) warnings.push(`${file}：${e}`);
    applyValues(config, values, file, warnings);
  }
  // CLI --lang 覆盖（parseArgs 已保证取值合法，此处再防御一次）
  if (cliLang === 'zh-CN' || cliLang === 'en-US') config.lang = cliLang;
  return { config, warnings, files };
}
