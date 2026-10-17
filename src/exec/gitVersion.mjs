/**
 * git 版本探测与比较。
 *
 * REPL 启动时探测一次（最低 2.30，低版本仅提示不崩溃）；
 * 单次模式不依赖 git（动态候选 disabled）。
 */

/**
 * 探测本机 git 版本。
 * @param {(args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} runGit
 *   只读 git 查询器（src/providers/gitQuery.mjs 的 run；永不 reject）
 * @returns {Promise<string|null>} 'git --version' 输出原样（如 '2.55.0.windows.1'）；失败返回 null
 */
export async function detectGitVersion(runGit) {
  try {
    const r = await runGit(['--version']);
    if (r.code !== 0) return null;
    const out = String(r.stdout ?? '').trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * 取主次版本 [major, minor]；解析失败返回 null。
 * @param {string|null|undefined} version detectGitVersion 的返回值
 * @returns {[number, number]|null}
 */
export function majorMinor(version) {
  if (typeof version !== 'string') return null;
  const m = /(\d+)\.(\d+)/.exec(version); // '2.55.0.windows.1' → [2,55]
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/**
 * 比较主次版本：a<b 负 / 相等 0 / a>b 正。
 * @param {[number, number]} a
 * @param {[number, number]} b
 */
export function compareMajorMinor(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
}

/**
 * 是否满足最低版本（默认 '2.30'）。无法解析时返回 true（宽松降级，不阻塞使用）。
 * @param {string|null|undefined} version
 * @param {string} minimum
 */
export function meetsMinimum(version, minimum = '2.30') {
  const v = majorMinor(version);
  const min = majorMinor(minimum);
  if (!v || !min) return true;
  return compareMajorMinor(v, min) >= 0;
}
