/**
 * 使用频率统计。
 *
 * 文件：<GITCUE_HOME>/usage.json，格式 {"version":1,"counts":{"cmd:rebase":3,…}}。
 * usageKey 规则：'cmd:<命令名>' | 'opt:<patternId>' | 'dyn:<kind>:<值>'（由调用方构造）。
 * 行为：bump 内存+1 并防抖 2s 落盘（定时器 unref，不阻塞进程退出）；flush 立即落盘；
 *      reset 清空内存并删除文件（gitcue --reset-usage）。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 防抖落盘延迟（毫秒） */
const FLUSH_DEBOUNCE_MS = 2000;

/**
 * 创建使用频率统计器。
 * @param {{ file: string, now?: () => number }} opts
 *        now 为时钟注入位，当前实现不依赖时间戳（预留）。
 * @returns {{
 *   count(key: string): number,
 *   bump(key: string): void,
 *   flush(): void,
 *   reset(): void,
 *   all(): Record<string, number>,
 * }}
 */
export function createUsage({ file, now = Date.now }) {
  void now; // 时钟注入位预留（见上）
  const counts = new Map();
  let timer = null;

  // 启动时读取既有统计（文件不存在/损坏 → 视为空统计，不抛错）
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.version === 1 &&
      parsed.counts &&
      typeof parsed.counts === 'object'
    ) {
      for (const [k, v] of Object.entries(parsed.counts)) {
        if (typeof k === 'string' && typeof v === 'number' && Number.isFinite(v) && v > 0) {
          counts.set(k, Math.floor(v));
        }
      }
    }
  } catch {
    /* 无文件或非法 JSON：空统计起步 */
  }

  /** 立即落盘（键按字典序排序，保证同状态输出字节稳定） */
  function persist() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const sorted = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const obj = {};
    for (const [k, v] of sorted) obj[k] = v;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ version: 1, counts: obj }, null, 2)}\n`, 'utf8');
  }

  return {
    /** 查询某 usageKey 的累计次数（默认 0） */
    count(key) {
      return counts.get(key) ?? 0;
    },
    /** 计数 +1，并重置防抖定时器（尾沿 2s 后落盘；定时器路径吞掉 IO 异常，避免崩溃） */
    bump(key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          persist();
        } catch {
          /* 落盘失败：内存计数保留，等待下次 bump/flush 重试 */
        }
      }, FLUSH_DEBOUNCE_MS);
      if (typeof timer.unref === 'function') timer.unref();
    },
    /** 立即落盘 */
    flush() {
      persist();
    },
    /** 清空统计并删除文件 */
    reset() {
      counts.clear();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        rmSync(file, { force: true });
      } catch {
        /* 删除失败（如占用）忽略：内存已清空 */
      }
    },
    /** 全量计数快照 */
    all() {
      return Object.fromEntries(counts);
    },
  };
}
