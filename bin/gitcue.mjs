#!/usr/bin/env node
/**
 * GitCue CLI 入口。
 *
 * 职责：
 *  1. 参数解析分派（repl / once / help / version / validate-data / config / reset-usage）；
 *  2. 单次模式输出渲染（稳定行前缀格式）；
 *  3. REPL 启动装配（组装知识库 + 解析引擎 + 动态数据 + 界面 + 执行层）；
 *  4. 顶层错误兜底（打印错误、exit 1）。
 *
 * 安全边界：运行时代码中只有本装配层经 resolveHome(env) 读取环境决定
 * GITCUE_HOME 并向下注入；所有 git 子进程由各层模块以只读方式调用。
 * 各层依赖模块均采用动态 import：缺失时给出明确错误并退出 1（并行开发期间可诊断）。
 */

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { VERSION, buildHelpText, parseArgs } from '../src/cli/args.mjs';
import { loadConfig, resolveHome } from '../src/config.mjs';
import { t } from '../src/i18n.mjs';
import { createLogger } from '../src/log.mjs';
import { createUsage } from '../src/usage.mjs';

/** 内置知识库数据目录（bin/ 相对工程根的 data/，禁止用 cwd 定位内置资源） */
const DATA_DIR = path.join(import.meta.dirname, '..', 'data');

/** 单次模式 ANSI 配色（plain 时全部退化为原样文本） */
const ANSI = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  bright: '\x1b[1m',
};

/** 计算字符串的终端显示列宽（CJK 等宽于 2 列） */
function padWidth(s) {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0) > 0xff ? 2 : 1;
  return w;
}

/** 按显示列宽右侧补空格（至少保留 2 空格间隔，超出列宽的文本优雅溢出） */
function padEndByWidth(s, width) {
  return s + ' '.repeat(Math.max(2, width - padWidth(s)));
}

/** 参数位提示统一为 <name> 形态（兼容传裸名或带尖括号两种形态） */
function wrapParamHint(hint) {
  return hint.startsWith('<') && hint.endsWith('>') ? hint : `<${hint}>`;
}

/**
 * 渲染"匹配"行：每个已完成 Token 附状态符号（✓ 已匹配 / ⚠ 未识别 / · 透传或未收录），
 * 活动词（不参与匹配）以 ▶ 标注在末尾。
 */
function renderMatchLine(view, plain) {
  const color = (code, s) => (plain ? s : `${code}${s}${ANSI.reset}`);
  const parts = [];
  const tokens = view.tokens ?? [];
  tokens.forEach((tok, i) => {
    let mark;
    if (!view.isGit) {
      mark = '·'; // 非 git 命令：整行透传，不参与匹配
    } else if (i === 0) {
      mark = '✓'; // 'git' 本身
    } else if (i === 1 && !view.covered) {
      mark = '·'; // 未收录子命令：非错误，直接执行
    } else {
      const m = view.marks?.[i - 2]; // marks 与 tokens.slice(2) 对齐
      mark = m && m.role === 'unknown' ? '⚠' : '✓';
    }
    parts.push(`${tok.text} ${color(mark === '⚠' ? ANSI.red : mark === '·' ? ANSI.cyan : ANSI.green, mark)}`);
  });
  if (view.active && view.active.text !== '') parts.push(`${view.active.text} ${color(ANSI.cyan, '▶')}`);
  else if (view.active) parts.push(color(ANSI.cyan, '▶'));
  return parts.join('  ');
}

/**
 * 渲染单次模式输出（行前缀固定、字节稳定）。
 * @param {object} view SuggestResult（createSuggest 的输出）
 * @param {{ lang?: string, plain?: boolean, kb?: object|null }} opts
 *        kb 用于取完整骨架（KbEntry.syntaxFull）；为空时退回紧凑骨架。
 * @returns {string} 以换行结尾的纯文本（或带 ANSI 的文本）
 */
export function renderOnceText(view, { lang = 'zh-CN', plain = true, kb = null } = {}) {
  const p = (key, params) => t(lang, key, params);
  const color = (code, s) => (plain ? s : `${code}${s}${ANSI.reset}`);
  const lines = [];

  // —— 语法行：优先完整骨架 ——
  let syntax;
  if (view.phase === 'passthrough') syntax = p('once.passthrough');
  else if (view.phase === 'empty') syntax = p('once.empty');
  else if (view.covered && kb && view.commandName) {
    const entry = typeof kb.get === 'function' ? kb.get(view.commandName) : null;
    syntax = entry && entry.syntaxFull ? entry.syntaxFull : (view.skeleton?.text ?? p('ui.syntax.uncovered'));
  } else {
    syntax = view.skeleton?.text ?? p('ui.syntax.uncovered');
  }
  lines.push(`${p('once.syntax')}: ${syntax}`);

  // —— 匹配行 ——
  lines.push(`${p('once.match')}: ${renderMatchLine(view, plain)}`);

  // —— 位置行 ——
  lines.push(`${p('once.position')}: ${view.positionLabel || '—'}`);

  // —— 候选区（列宽 = min(最长文本, 24) + 2，CJK 记 2 列）——
  const candidates = view.candidates ?? [];
  lines.push(`${p('once.candidates')}(${candidates.length}):`);
  const displays = candidates.map((c) =>
    c.paramHint ? `${c.text} ${wrapParamHint(c.paramHint)}` : c.text,
  );
  const maxW = displays.length > 0 ? Math.max(...displays.map(padWidth)) : 0;
  const colWidth = Math.min(maxW, 24) + 2;
  candidates.forEach((c, i) => {
    const summary = c.summary && c.summary !== '' ? c.summary : p('ui.nosummary');
    lines.push(
      `  ${color(ANSI.bright, padEndByWidth(displays[i], colWidth))}${summary}`,
    );
  });

  // —— 提示行：纠错建议或（无）——
  const corrections = view.corrections ?? [];
  if (corrections.length === 0) {
    lines.push(`${p('once.hint')}: ${p('once.none')}`);
  } else {
    for (const c of corrections) {
      const segs = [p('once.unrecognized', { token: c.token })];
      if (Array.isArray(c.suggestions) && c.suggestions.length > 0) {
        segs.push(p('ui.didyoumean', { s: c.suggestions.join(', ') }));
      }
      lines.push(`${p('once.hint')}: ${color(ANSI.red, segs.join('  '))}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * 单次模式 --strict 判定：是否存在"未识别"信号（--strict 且有
 * 未识别 Token → 退出码 2）。判定依据：phase === 'unknown'；或纠错建议指向某个
 * 已完成 Token；或行尾活动词的前缀过滤零候选且无任何距离 ≤2 的建议（真正的
 * 未识别词）。带建议的活动词软提示是"可修复的拼写误差"，
 * 不构成 strict 失败（软提示 → false）。
 * @param {object} view SuggestResult
 * @returns {boolean}
 */
export function onceHasUnknown(view) {
  if (!view) return false;
  if (view.phase === 'unknown') return true;
  const tokens = view.tokens ?? [];
  const texts = new Set(tokens.map((tok) => tok.text));
  return (view.corrections ?? []).some(
    (c) =>
      texts.has(c.token) ||
      (c.index === -1 && (!Array.isArray(c.suggestions) || c.suggestions.length === 0)),
  );
}

/** 自定义命令目录：配置为空则用 <GITCUE_HOME>/commands */
function resolveCustomDir(config, home) {
  return config.custom_command_dir && config.custom_command_dir.trim() !== ''
    ? config.custom_command_dir
    : path.join(home, 'commands');
}

/** 知识库告警统一走日志（启动时 log + --debug 展示） */
function logKbWarnings(kb, logger) {
  if (kb && Array.isArray(kb.warnings)) {
    for (const w of kb.warnings) logger.error(w);
  }
}

/** —— 子命令：config（打印路径与当前生效配置）—— */
function runConfigCommand(env, cwd) {
  const home = resolveHome(env);
  const { config, warnings, files } = loadConfig({ env, cwd });
  const lang = config.lang;
  const p = (key, params) => t(lang, key, params);
  const out = (s) => process.stdout.write(`${s}\n`);
  const userFile = path.join(home, 'config.toml');
  const projectFile = path.join(cwd, '.gitcue.toml');
  out(p('cli.config.home', { path: home }));
  out(
    `${p('cli.config.userfile', { file: userFile })}${
      existsSync(userFile) ? '' : ` ${p('cli.config.notexists')}`
    }`,
  );
  out(
    `${p('cli.config.projectfile', { file: projectFile })}${
      existsSync(projectFile) ? '' : ` ${p('cli.config.notexists')}`
    }`,
  );
  if (files.length > 0) out(p('cli.config.loaded', { files: files.join(' ← ') }));
  out(p('cli.config.effective'));
  for (const [k, v] of Object.entries(config)) {
    out(`  ${k} = ${typeof v === 'string' ? JSON.stringify(v) : String(v)}`);
  }
  for (const w of warnings) process.stderr.write(`${p('cli.warn', { msg: w })}\n`);
}

/** —— 子命令：validate-data（校验知识库）—— */
async function runValidateData(env, logger) {
  const home = resolveHome(env);
  const { config } = loadConfig({ env });
  const customDir = resolveCustomDir(config, home);
  const { validateData } = await import('../src/kb/validate.mjs');
  const res = validateData({ dataDir: DATA_DIR, customDir });
  for (const e of res.errors) {
    process.stdout.write(`${e.file}${e.path ? ` ${e.path}` : ''}: ${e.message}\n`);
  }
  for (const w of res.warnings) {
    process.stdout.write(`${t(config.lang, 'cli.validate.warning', { msg: w })}\n`);
  }
  process.stdout.write(
    `${t(config.lang, 'cli.validate.summary', { passed: res.passed, errors: res.errors.length })}\n`,
  );
  logger.debug('validate-data 完成', { errors: res.errors.length, passed: res.passed });
  process.exitCode = res.ok ? 0 : 2;
}

/** —— 单次模式 —— */
async function runOnce(args, env, cwd, logger) {
  const started = performance.now();
  const home = resolveHome(env);
  const { config } = loadConfig({ env, cwd, cliLang: args.lang });
  const customDir = resolveCustomDir(config, home);

  const { loadKnowledgeBase } = await import('../src/kb/loader.mjs');
  const kb = loadKnowledgeBase({ dataDir: DATA_DIR, customDir, lang: config.lang });
  logKbWarnings(kb, logger);
  logger.debug('知识库加载完成', {
    commands: kb.names().length,
    costMs: Math.round((performance.now() - started) * 100) / 100,
  });

  const { createSuggest } = await import('../src/parser/suggest.mjs');
  // 单次模式降级装配：无动态候选、无频率加权、不探测 git 版本
  const { suggest } = createSuggest({ kb, providers: null, usage: null, gitVersion: null, lang: config.lang });

  const line = args.commandLine ?? '';
  const view = suggest(line, line.length);
  const plain = args.plain || !process.stdout.isTTY;
  process.stdout.write(renderOnceText(view, { lang: config.lang, plain, kb }));

  const strictFail = args.strict && onceHasUnknown(view);
  logger.debug('单次模式解析完成', {
    phase: view.phase,
    candidates: view.candidates?.length ?? 0,
    timingsMs: view.debug?.timingsMs,
  });

  if (args.exec) {
    if (line.trim() === '') {
      process.stderr.write(`${t(config.lang, 'cli.exec.empty')}\n`);
      process.exitCode = strictFail ? 2 : 0;
      return;
    }
    const { createRunner } = await import('../src/exec/runner.mjs');
    const runner = createRunner({ cwd, env, pager: config.pager });
    process.stdout.write('\n');
    const { code } = await runner.run(line);
    // 退出码：子进程退出码透传；--strict 失败优先为 2
    process.exitCode = strictFail ? 2 : code;
  } else {
    process.exitCode = strictFail ? 2 : 0;
  }
}

/** —— 交互模式 REPL 装配 —— */
async function runRepl(args, env, cwd, logger) {
  const home = resolveHome(env);
  mkdirSync(home, { recursive: true }); // 确保用户级目录存在（历史/统计/引导标记落于此）
  const { config, warnings } = loadConfig({ env, cwd, cliLang: args.lang });
  for (const w of warnings) process.stderr.write(`${t(config.lang, 'cli.warn', { msg: w })}\n`);

  const customDir = resolveCustomDir(config, home);
  const started = performance.now();
  const { loadKnowledgeBase } = await import('../src/kb/loader.mjs');
  const kb = loadKnowledgeBase({ dataDir: DATA_DIR, customDir, lang: config.lang });
  logKbWarnings(kb, logger);
  logger.debug('知识库加载完成', {
    commands: kb.names().length,
    costMs: Math.round((performance.now() - started) * 100) / 100,
  });

  // git 探测：git 缺失 → 报错退出 1
  const { createGitQuery } = await import('../src/providers/gitQuery.mjs');
  const runGit = createGitQuery({ cwd, env }).run;
  const { detectGitVersion, meetsMinimum } = await import('../src/exec/gitVersion.mjs');
  const gitVersion = await detectGitVersion(runGit);
  if (gitVersion === null) {
    process.stderr.write(`${t(config.lang, 'cli.git.missing')}\n`);
    process.exitCode = 1;
    return;
  }
  const gitOk = meetsMinimum(gitVersion); // 低版本仅提示，不崩溃
  logger.debug('git 版本探测', { gitVersion, meetsMinimum: gitOk });

  // 动态数据 / 使用频率 / 历史
  const { createProviders } = await import('../src/providers/hub.mjs');
  const providers = createProviders({
    cwd,
    runGit,
    cacheTtlMs: config.dynamic_cache_seconds * 1000,
  });
  const usage = createUsage({ file: path.join(home, 'usage.json') });
  const { createHistory } = await import('../src/history.mjs');
  const history = createHistory({
    file: path.join(home, 'history.jsonl'),
    limit: config.history_limit,
    enabled: config.history_enabled,
  });

  // 解析管线 + 执行层 + 界面
  const { createSuggest } = await import('../src/parser/suggest.mjs');
  const { suggest } = createSuggest({ kb, providers, usage, gitVersion, lang: config.lang });
  const { createRunner } = await import('../src/exec/runner.mjs');
  // exec_output：'passthrough'（默认）执行时让位终端、stdio inherit 原样直写；
  // 'inline' 输出捕获进窗口顶部历史区，启用 pipe 捕获
  const exec = createRunner({ cwd, env, pager: config.pager, capture: config.exec_output !== 'passthrough' });
  const { detectDanger } = await import('../src/exec/danger.mjs');
  // REPL 装配：Ink 视图（repl.mjs）+ 控制器（view 契约）；装配顺序不变
  const { createReplView, shouldUseAnsi } = await import('../src/ui/repl.mjs');
  const { createController } = await import('../src/ui/controller.mjs');
  const ansi = config.theme !== 'none' && shouldUseAnsi({ stdout: process.stdout, env });

  // 首次启动引导标记：由本装配层检查，controller 只接收布尔值
  const showGuide = !existsSync(path.join(home, 'guide-shown'));

  let controller;
  const view = createReplView({ onKey: (k) => controller && controller.input(k), ansi });
  controller = createController({
    suggest,
    providers,
    exec,
    history,
    usage,
    config,
    i18n: { t: (key, params) => t(config.lang, key, params) },
    view,
    gitVersion,
    dangerCheck: (tokens) => (config.danger_warning ? detectDanger(tokens) : null),
    home,
    showGuide,
    now: Date.now,
  });
  view.mount(controller.state);
  await view.waitExit();
}

/** —— 主入口：参数分派与顶层兜底 —— */
async function main() {
  const env = process.env;
  const cwd = process.cwd();
  const args = parseArgs(process.argv.slice(2));
  const logger = createLogger({ env, forceDebug: args.debug });

  if (args.errors.length > 0) {
    for (const e of args.errors) process.stderr.write(`${t('zh-CN', 'cli.fatal', { msg: e })}\n`);
    process.stderr.write(`${t('zh-CN', 'cli.usage.hint')}\n`);
    process.exitCode = 2;
    return;
  }

  switch (args.mode) {
    case 'help':
      process.stdout.write(buildHelpText(args.lang));
      return;
    case 'version':
      process.stdout.write(`gitcue ${VERSION}\n`);
      return;
    case 'reset-usage': {
      const home = resolveHome(env);
      const file = path.join(home, 'usage.json');
      createUsage({ file }).reset();
      const { config } = loadConfig({ env });
      process.stdout.write(`${t(config.lang, 'cli.usage.reset.done', { file })}\n`);
      return;
    }
    case 'config':
      runConfigCommand(env, cwd);
      return;
    case 'validate-data':
      await runValidateData(env, logger);
      return;
    case 'once':
      await runOnce(args, env, cwd, logger);
      return;
    case 'repl':
      await runRepl(args, env, cwd, logger);
      return;
    default:
      throw new Error(`未知的分发模式：${args.mode}`);
  }
}

/** 顶层错误兜底：打印错误、exit 1，绝不静默崩溃 */
function describeFatal(err) {
  const msg = err && err.message ? err.message : String(err);
  if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
    return `gitcue：功能模块未就绪（${msg}）。该功能所属模块可能尚未实现，请检查 src/ 目录。`;
  }
  return `gitcue：内部错误：${msg}`;
}

// —— 入口判定：仅在作为脚本直接执行时运行 main（测试可安全 import 本文件）——
const invokedDirectly =
  typeof import.meta.main === 'boolean'
    ? import.meta.main
    : import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (invokedDirectly) {
  main().then(
    () => {
      /* 退出码已由 process.exitCode 表达，正常返回 */
    },
    (err) => {
      process.stderr.write(`${describeFatal(err)}\n`);
      process.exitCode = 1;
    },
  );
}
