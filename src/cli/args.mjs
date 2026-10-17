/**
 * CLI 参数解析与帮助文本。
 *
 * 约定：本文件为纯函数模块，不做任何 IO，便于无头单测。
 */

/** CLI 版本常量（与 package.json version 一致） */
export const VERSION = '0.1.0';

/** 支持的界面语言（zh-CN 默认 + en-US） */
export const SUPPORTED_LANGS = ['zh-CN', 'en-US'];

/**
 * 解析命令行参数。
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {{
 *   mode: 'repl'|'once'|'help'|'version'|'validate-data'|'config'|'reset-usage',
 *   commandLine: string|null,   // 首个非 flag 位置参数
 *   exec: boolean,              // --exec
 *   plain: boolean,             // --plain
 *   strict: boolean,            // --strict
 *   lang: string|null,          // --lang zh-CN|en-US
 *   debug: boolean,             // --debug
 *   errors: string[]            // 非空时为用法错误，打印后 exit 2
 * }}
 */
export function parseArgs(argv) {
  const result = {
    mode: 'repl',
    commandLine: null,
    exec: false,
    plain: false,
    strict: false,
    lang: null,
    debug: false,
    errors: [],
  };
  const positionals = [];
  let sawHelp = false;
  let sawVersion = false;
  let sawResetUsage = false;
  let noMoreFlags = false; // "--" 之后全部按位置参数处理（CLI 惯例）

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (noMoreFlags) {
      positionals.push(a);
      continue;
    }
    if (a === '--') {
      noMoreFlags = true;
      continue;
    }
    switch (a) {
      case '--exec':
        result.exec = true;
        break;
      case '--plain':
        result.plain = true;
        break;
      case '--strict':
        result.strict = true;
        break;
      case '--debug':
        result.debug = true;
        break;
      case '--help':
      case '-h':
        sawHelp = true;
        break;
      case '--version':
      case '-V':
        sawVersion = true;
        break;
      case '--reset-usage':
        sawResetUsage = true;
        break;
      case '--lang': {
        const v = argv[++i];
        if (v === undefined) {
          result.errors.push('--lang 需要紧跟一个值（zh-CN 或 en-US）');
        } else if (!SUPPORTED_LANGS.includes(v)) {
          result.errors.push(`--lang 的值必须是 zh-CN 或 en-US，收到 "${v}"`);
        } else {
          result.lang = v;
        }
        break;
      }
      default:
        // 以 "-" 开头且非单个 "-" 的都是未知 flag；命令行应作为单个带引号参数传入
        if (a.startsWith('-') && a.length > 1) {
          result.errors.push(`未知参数 "${a}"`);
        } else {
          positionals.push(a);
        }
    }
  }

  if (positionals.length > 1) {
    result.errors.push(
      `最多接受 1 个位置参数，收到 ${positionals.length} 个："${positionals.join('" "')}"`,
    );
  }

  // 模式裁决优先级：用法错误（由调用方处理）> help > version > 位置参数子模式 > reset-usage > repl
  if (sawHelp) {
    result.mode = 'help';
  } else if (sawVersion) {
    result.mode = 'version';
  } else if (positionals.length >= 1) {
    const p = positionals[0];
    if (p === 'validate-data') {
      result.mode = 'validate-data';
    } else if (p === 'config') {
      result.mode = 'config';
    } else {
      result.mode = 'once';
      result.commandLine = p;
    }
  } else if (sawResetUsage) {
    result.mode = 'reset-usage';
  } else {
    result.mode = 'repl';
  }

  return result;
}

/** 帮助文本（zh-CN，参数表 + 快捷键表摘要） */
const HELP_ZH = `gitcue ${VERSION} —— Git 命令行智能提示工具

用法:
  gitcue                          交互模式（REPL，主模式）：实时语法与候选提示
  gitcue "<命令行>"                单次模式：解析并输出建议文本，不执行
  gitcue "<命令行>" --exec         输出建议后执行该命令，输出与退出码透传
  gitcue validate-data            校验知识库数据文件（贡献者使用）
  gitcue config                   显示配置文件路径与当前生效配置
  gitcue --reset-usage            清除使用频率统计文件

选项:
  --plain                 关闭 ANSI 颜色（stdout 非终端时自动关闭）
  --strict                存在未识别 Token 时退出码为 2
  --lang <zh-CN|en-US>    界面语言，覆盖配置文件（默认 zh-CN）
  --debug                 在 stderr 输出解析轨迹与各阶段耗时
  --help, -h              显示本帮助
  --version, -V           显示版本

快捷键（交互模式）:
  Tab 补全 │ ↑↓ 选择 │ Enter 执行 │ F1 详情 │ Esc 清空 │ Ctrl+Q 退出
  ↑（空行）回溯历史 │ Ctrl+C×2 退出 │ Ctrl+U 清行 │ Ctrl+W 删词 │ PgUp/PgDn 翻页

配置:
  用户级 <GITCUE_HOME>/config.toml（默认 ~/.gitcue/config.toml），
  项目级 .gitcue.toml 覆盖用户级；可用 GITCUE_HOME 环境变量重定位。
  运行 gitcue config 查看路径与当前生效值。
`;

/** 帮助文本（en-US，界面框架文案，知识库说明仍回退中文） */
const HELP_EN = `gitcue ${VERSION} -- smart hints for Git commands

Usage:
  gitcue                          interactive REPL (primary mode)
  gitcue "<command line>"         one-shot mode: parse and print hints, do not run
  gitcue "<command line>" --exec  print hints, then run the command (exit code passed through)
  gitcue validate-data            validate knowledge-base data files (for contributors)
  gitcue config                   show config file paths and effective values
  gitcue --reset-usage            clear the usage-frequency statistics file

Options:
  --plain                 disable ANSI colors (auto when stdout is not a TTY)
  --strict                exit with code 2 when unknown tokens are present
  --lang <zh-CN|en-US>    UI language, overrides the config file (default zh-CN)
  --debug                 print parsing traces and timings to stderr
  --help, -h              show this help
  --version, -V           show version

Keys (interactive mode):
  Tab complete │ Up/Down select │ Enter run │ F1 detail │ Esc clear │ Ctrl+Q quit
  Up on empty line: history │ Ctrl+C twice: quit │ Ctrl+U clear line │ Ctrl+W delete word │ PgUp/PgDn page

Configuration:
  User-level <GITCUE_HOME>/config.toml (default ~/.gitcue/config.toml),
  overridden by project-level .gitcue.toml; relocate via the GITCUE_HOME env var.
  Run gitcue config to see paths and effective values.
`;

/**
 * 构造 --help 输出文本。
 * @param {string|null} lang 界面语言（null 视为 zh-CN）
 * @returns {string}
 */
export function buildHelpText(lang = 'zh-CN') {
  return lang === 'en-US' ? HELP_EN : HELP_ZH;
}
