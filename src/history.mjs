/**
 * 会话与持久化历史。
 *
 * 文件 <GITCUE_HOME>/history.jsonl，每行 {"t":<ms>,"cmd":"..."}。
 * 规则：连续重复不入库；上限 limit（超限重写裁剪最旧）；enabled=false 时
 * 不读写文件、仅会话内记忆。all() 合并持久化+会话，最近在前、去连续重，
 * 供 reducer 的 ↑↓ 回溯（historyIndex=0 为最近一条）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 创建历史记录器。
 * @param {{ file?: string, limit?: number, enabled?: boolean, now?: () => number }} opts
 * @returns {{ load(): void, sessionView(): string[], all(): string[], push(cmd: string): void }}
 */
export function createHistory({ file = null, limit = 1000, enabled = true, now = Date.now } = {}) {
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 1000;
  /** @type {{t:number, cmd:string}[]} 文件序（最旧在前）；enabled=false 时仅会话 */
  let persisted = [];
  /** @type {{t:number, cmd:string}[]} 本会话新增（最旧在前） */
  const session = [];

  /** 重写持久化文件（目录不存在则创建；写失败静默——历史不可用不应影响 REPL） */
  const persist = () => {
    if (!file || !enabled) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const lines = persisted
        .slice(-cap)
        .map((e) => JSON.stringify({ t: e.t, cmd: e.cmd }))
        .join('\n');
      writeFileSync(file, lines.length > 0 ? `${lines}\n` : '', 'utf8');
    } catch {
      /* best-effort */
    }
  };

  return {
    /** 从文件载入持久化历史（损坏行跳过；重复调用以文件为准重置）。 */
    load() {
      persisted = [];
      if (!file || !enabled) return;
      try {
        if (!existsSync(file)) return;
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          const s = line.trim();
          if (s === '') continue;
          try {
            const e = JSON.parse(s);
            if (e && typeof e.cmd === 'string' && e.cmd.length > 0) {
              persisted.push({ t: Number.isFinite(e.t) ? e.t : 0, cmd: e.cmd });
            }
          } catch {
            /* 损坏行跳过 */
          }
        }
      } catch {
        /* 读失败按空历史处理 */
      }
    },

    /** 仅本会话新增的命令（时间序，最旧在前）。 */
    sessionView() {
      return session.map((e) => e.cmd);
    },

    /** 合并持久化+会话：最近在前、去连续重复（连续相同只留最近一次）。 */
    all() {
      const merged = [...persisted, ...session];
      const out = [];
      for (let i = merged.length - 1; i >= 0; i -= 1) {
        const cmd = merged[i].cmd;
        if (out.length === 0 || out[out.length - 1] !== cmd) out.push(cmd);
      }
      return out;
    },

    /**
     * 记录一条命令：连续重复不入库；超上限裁剪最旧并重写文件。
     * @param {string} cmd
     */
    push(cmd) {
      const line = String(cmd ?? '');
      if (line.trim() === '') return;
      const last = persisted.length > 0 ? persisted[persisted.length - 1].cmd : null;
      const lastSession = session.length > 0 ? session[session.length - 1].cmd : null;
      // 连续重复：与"文件尾或会话尾"相同即跳过（load 后未 push 时看文件尾）
      if (line === lastSession || (lastSession === null && line === last)) return;
      session.push({ t: now(), cmd: line });
      if (!file || !enabled) {
        if (session.length > cap) session.splice(0, session.length - cap); // 会话内同样守上限
        return;
      }
      {
        persisted = [...persisted, ...session.splice(0)]; // 会话项落盘后并入持久化视图
        if (persisted.length > cap) persisted = persisted.slice(-cap);
        persist();
      }
    },
  };
}
