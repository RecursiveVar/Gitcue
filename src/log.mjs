/**
 * 日志。
 *
 * 规则：级别 off < error < info < debug；env.GITCUE_LOG 控制初始级别，forceDebug 覆盖为 debug；
 * 默认关闭；输出只走 stderr，绝不污染 stdout（stdout 仅用于建议输出与透传结果）。
 * 说明：write 调用点动态查找 process.stderr.write，测试可临时替换以捕获输出。
 */

/** 级别权重 */
const LEVELS = { off: 0, error: 1, info: 2, debug: 3 };
const LEVEL_NAMES = ['off', 'error', 'info', 'debug'];

/** 序列化附加数据（循环引用等异常场景退化为 String，绝不抛错） */
function safeStringify(data) {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

/**
 * 创建日志器。
 * @param {{ env?: NodeJS.ProcessEnv, forceDebug?: boolean }} opts
 * @returns {{ level: string, debug(msg: string, data?: unknown): void, info(msg: string): void, error(msg: string): void }}
 *          级别不足时对应方法为空操作。
 */
export function createLogger({ env = process.env, forceDebug = false } = {}) {
  const raw = String((env && env.GITCUE_LOG) ?? '')
    .trim()
    .toLowerCase();
  let level = Object.prototype.hasOwnProperty.call(LEVELS, raw) ? LEVELS[raw] : LEVELS.off;
  if (forceDebug) level = LEVELS.debug;

  const write = (lv, msg, data) => {
    let line = `[gitcue:${lv}] ${msg}`;
    if (data !== undefined) line += ` ${safeStringify(data)}`;
    process.stderr.write(`${line}\n`);
  };

  return {
    level: LEVEL_NAMES[level],
    debug(msg, data) {
      if (level >= LEVELS.debug) write('debug', msg, data);
    },
    info(msg) {
      if (level >= LEVELS.info) write('info', msg);
    },
    error(msg) {
      if (level >= LEVELS.error) write('error', msg);
    },
  };
}
