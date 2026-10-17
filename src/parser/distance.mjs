// src/parser/distance.mjs —— Levenshtein 编辑距离（叶子库，零内部依赖）
// 纠错建议使用经典 DP 编辑距离，长度差超过阈值直接剪枝。

/**
 * 计算两字符串的 Levenshtein 编辑距离（插入/删除/替换，各计 1）。
 * 经典动态规划实现，按单行滚动数组压缩空间。
 *
 * @param {string} a 源串
 * @param {string} b 目标串
 * @param {number} [maxDistance] 剪枝阈值（默认 2）：距离必定超过该值时提前返回 maxDistance+1，
 *   不再给出精确值。长度差已超限时直接返回 maxDistance+1（零计算）。
 * @returns {number} 实际距离；若超过 maxDistance 则返回 maxDistance+1
 */
export function editDistance(a, b, maxDistance = 2) {
  // 按码点切分，保证中文等多字节字符按"一个字符"计
  const s = [...a];
  const t = [...b];
  const la = s.length;
  const lb = t.length;
  if (Math.abs(la - lb) > maxDistance) {
    return maxDistance + 1;
  }
  if (la === 0) return lb;
  if (lb === 0) return la;

  // prev/j 为相邻两行 DP 值；rowMin 用于提前剪枝
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j += 1) prev[j] = j;

  for (let i = 1; i <= la; i += 1) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxDistance) {
      return maxDistance + 1; // 该行最小值已超限，距离必然超限
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  const result = prev[lb];
  return result > maxDistance ? maxDistance + 1 : result;
}
