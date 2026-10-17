/**
 * 界面文案语言包。
 *
 * 语义：zh-CN 为基准语言（全量键）；en-US 覆盖界面框架文案（知识库说明文案本版仍为中文）。
 * 缺键回退 zh-CN，再缺返回键名本身，绝不抛错。
 */

/** zh-CN 全量文案 */
const ZH_CN = {
  // —— 五区与通用 ——
  'ui.title': 'GitCue',
  'ui.prompt': 'git> ',
  'ui.zone.syntax': '语法',
  'ui.zone.candidates': '候选',
  'ui.zone.detail': '详情',
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
  // —— 首次启动快速引导（≤5 行）——
  'ui.guide.1': 'GitCue：输入 git 命令，实时获得语法与候选提示',
  'ui.guide.2': 'Tab 补全 │ ↑↓ 选择 │ Enter 执行 │ F1 详情',
  'ui.guide.3': '↑（空行）回溯历史 │ Esc 清空 │ Ctrl+C×2 或 Ctrl+Q 退出',
  'ui.guide.4': '输入非 git 命令将直接执行',
  'ui.guide.5': '按任意键继续',
  // —— 杂项 ——
  'ui.since': '（需 git ≥ {v}）',
  'ui.warn.enum': '非枚举值',
  // —— 高危命令警示（danger 规则表文案）——
  'danger.push_force': '⚠ 强制推送将覆盖远端历史',
  'danger.reset_hard': '⚠ --hard 将丢弃未提交改动',
  'danger.clean_fd': '⚠ 将删除未跟踪的文件与目录',
  'danger.branch_D': '⚠ 将强制删除分支',
  // —— 单次模式行前缀与兜底（行前缀固定）——
  'once.syntax': '语法',
  'once.match': '匹配',
  'once.position': '位置',
  'once.candidates': '候选',
  'once.hint': '提示',
  'once.none': '（无）',
  'once.unrecognized': '⚠ 未识别: {token}',
  'once.passthrough': '（非 git 命令，直接执行）',
  'once.empty': '（空输入）',
  // —— CLI 子命令输出 ——
  'cli.usage.hint': '运行 gitcue --help 查看用法。',
  'cli.usage.reset.done': '已清除使用频率统计：{file}',
  'cli.config.home': 'GITCUE_HOME: {path}',
  'cli.config.userfile': '用户级配置文件: {file}',
  'cli.config.projectfile': '项目级配置文件: {file}',
  'cli.config.notexists': '（不存在，可创建）',
  'cli.config.loaded': '已加载: {files}',
  'cli.config.effective': '当前生效配置:',
  'cli.validate.warning': '告警: {msg}',
  'cli.validate.summary': '校验完成：{passed} 个条目通过，{errors} 个错误',
  'cli.exec.empty': '空命令，--exec 未执行',
  'cli.git.missing': '未检测到可用的 git，请先安装 git 后再使用 GitCue。',
  'cli.warn': '告警：{msg}',
  'cli.fatal': 'gitcue：{msg}',
};

/** en-US 界面框架文案（同键翻译） */
const EN_US = {
  'ui.title': 'GitCue',
  'ui.prompt': 'git> ',
  'ui.zone.syntax': 'Syntax',
  'ui.zone.candidates': 'Candidates',
  'ui.zone.detail': 'Detail',
  'ui.syntax.guide': 'type a subcommand, ↓ to browse all',
  'ui.syntax.uncovered': 'git <command> [args...] (not covered, will run directly)',
  'ui.loading': 'Loading…',
  'ui.notrepo': '(not a git repository)',
  'ui.didyoumean': 'Did you mean: {s}? (Tab to accept)',
  'ui.nosummary': '(no description)',
  'ui.exit.ok': '✔ exit {code}',
  'ui.exit.fail': '✘ exit {code}',
  'ui.running': '…running',
  'ui.hintbar': 'Tab complete │ ↑↓ select │ F1 detail │ Enter run │ Esc clear │ Ctrl+Q quit',
  'ui.guide.1': 'GitCue: type git commands and get syntax & candidate hints live',
  'ui.guide.2': 'Tab complete │ ↑↓ select │ Enter run │ F1 detail',
  'ui.guide.3': '↑ on empty line: history │ Esc clear │ Ctrl+C twice or Ctrl+Q to quit',
  'ui.guide.4': 'Non-git commands are executed as-is',
  'ui.guide.5': 'Press any key to continue',
  'ui.since': '(needs git ≥ {v})',
  'ui.warn.enum': 'not an enum value',
  'danger.push_force': '⚠ force push will overwrite remote history',
  'danger.reset_hard': '⚠ --hard discards uncommitted changes',
  'danger.clean_fd': '⚠ will delete untracked files and directories',
  'danger.branch_D': '⚠ will force-delete the branch',
  'once.syntax': 'Syntax',
  'once.match': 'Match',
  'once.position': 'Position',
  'once.candidates': 'Candidates',
  'once.hint': 'Hint',
  'once.none': '(none)',
  'once.unrecognized': '⚠ unrecognized: {token}',
  'once.passthrough': '(not a git command, will run as-is)',
  'once.empty': '(empty input)',
  'cli.usage.hint': 'Run gitcue --help for usage.',
  'cli.usage.reset.done': 'Usage statistics cleared: {file}',
  'cli.config.home': 'GITCUE_HOME: {path}',
  'cli.config.userfile': 'User config file: {file}',
  'cli.config.projectfile': 'Project config file: {file}',
  'cli.config.notexists': '(missing, can be created)',
  'cli.config.loaded': 'Loaded: {files}',
  'cli.config.effective': 'Effective config:',
  'cli.validate.warning': 'warning: {msg}',
  'cli.validate.summary': 'Validation done: {passed} passed, {errors} error(s)',
  'cli.exec.empty': 'empty command; --exec skipped',
  'cli.git.missing': 'git not found; please install git before using GitCue.',
  'cli.warn': 'warning: {msg}',
  'cli.fatal': 'gitcue: {msg}',
};

/** 语言表（框架层面可扩展后续语言） */
export const MESSAGES = {
  'zh-CN': ZH_CN,
  'en-US': EN_US,
};

/** 支持的语言列表（与 MESSAGES 键一致） */
export const SUPPORTED_I18N_LANGS = Object.keys(MESSAGES);

/**
 * 取文案；缺键回退 zh-CN，再缺返回键名本身（不抛错）。params 做 {x} 插值。
 * @param {string} lang 语言
 * @param {string} key 文案键
 * @param {Record<string, string|number>} params 插值参数（缺失的占位符原样保留）
 * @returns {string}
 */
export function t(lang, key, params = {}) {
  const table = MESSAGES[lang] ?? MESSAGES['zh-CN'];
  let text = table[key] ?? MESSAGES['zh-CN'][key] ?? key;
  if (params && typeof params === 'object') {
    text = text.replace(/\{([A-Za-z0-9_]+)\}/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m,
    );
  }
  return text;
}
