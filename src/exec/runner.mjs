/**
 * 命令执行器。
 *
 * 两种输出形态（config.exec_output）：
 *  - passthrough（capture=false，默认）：spawn + stdio 三向 inherit，子进程输出（含颜色、
 *    提示）直接写终端（原样透传；REPL 执行时由上层先卸载界面让位）；
 *  - inline（capture=true）：stdout/stderr 改为 pipe 并按到达顺序合并为文本流，
 *    经 onData 回调交给上层渲染进窗口顶部历史区；stdin 同为 pipe，上层可经 write()
 *    把用户按键转发给子进程（行式交互提示仍可用；终端回显由上层负责）。
 *
 * 环境注入分页器与防挂起变量：GIT_PAGER/PAGER = pager（默认 'cat'，避免 REPL 内嵌
 * 分页器接管屏幕），GIT_TERMINAL_PROMPT=0（防止凭据提示挂起）。
 *
 * 退出码约定：正常退出透传；被 cancel()/信号终止 → 130（Ctrl+C 惯例码）。
 */

import { spawn } from 'node:child_process';

/**
 * 创建命令执行器。
 * @param {{ cwd?: string, env?: object, pager?: string, capture?: boolean }} opts
 *   cwd 执行目录；env 子进程环境（在其上追加分页器/防挂起变量，不改写其余条目）；
 *   pager 分页器命令（默认 'cat'）；capture=true 启用内联捕获模式。
 * @returns {{
 *   run(commandLine: string, opts?: { onData?: (text: string) => void }): Promise<{ code: number, durationMs: number }>,
 *   write(chunk: string | Uint8Array): boolean,
 *   cancel(): boolean,
 *   active(): boolean,
 * }}
 */
export function createRunner({ cwd = process.cwd(), env = process.env, pager = 'cat', capture = false } = {}) {
  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  /** @type {boolean} 当前子进程是否被 cancel 终止（退出码改判 130） */
  let cancelled = false;

  return {
    /**
     * 执行一条完整命令行（shell 语义）。
     * @param {string} commandLine
     * @param {{ onData?: (text: string) => void }} [runOpts] 内联模式的输出流回调
     *   （stdout/stderr 合并、按到达顺序；不含 passthrough 模式）。
     * @returns {Promise<{ code: number, durationMs: number }>}
     */
    run(commandLine, runOpts) {
      if (child) {
        // 同一执行器串行使用（REPL 每时刻至多一条命令在跑）；并发调用视为编程错误
        return Promise.reject(new Error('runner 已有命令在执行'));
      }
      const startedAt = Date.now();
      const onData = runOpts && typeof runOpts.onData === 'function' ? runOpts.onData : null;
      cancelled = false;
      return new Promise((resolve, reject) => {
        try {
          child = spawn(String(commandLine), {
            shell: true,
            cwd,
            stdio: capture ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit'],
            env: {
              ...env,
              GIT_PAGER: pager,
              PAGER: pager,
              GIT_TERMINAL_PROMPT: '0',
            },
          });
        } catch (err) {
          child = null;
          reject(err);
          return;
        }
        if (capture && onData) {
          for (const stream of [child.stdout, child.stderr]) {
            if (!stream) continue;
            stream.setEncoding('utf8');
            stream.on('data', (text) => {
              if (child && !child.killed) onData(String(text));
            });
          }
        }
        /** @param {number|null} code @param {NodeJS.Signals|null} signal */
        const finish = (code, signal) => {
          child = null;
          const durationMs = Date.now() - startedAt;
          if (cancelled || (signal !== null && signal !== undefined)) resolve({ code: 130, durationMs });
          else resolve({ code: code ?? 0, durationMs });
        };
        child.on('error', (err) => {
          // shell 本身启动失败（如 shell:false 路径不存在；shell:true 下罕见）
          child = null;
          reject(err);
        });
        child.on('close', finish);
      });
    },

    /**
     * 内联模式：把用户按键字节写入子进程 stdin（行式交互提示用）。
     * passthrough 模式或子进程已结束/无 stdin → false（调用方忽略）。
     */
    write(chunk) {
      if (!child || child.killed || !child.stdin || !child.stdin.writable) return false;
      try {
        child.stdin.write(chunk);
        return true;
      } catch {
        return false; // EPIPE 等：子进程刚退出，忽略
      }
    },

    /** 终止当前子进程：win32 用 taskkill 树杀；POSIX 发 SIGINT。true=已发送终止。 */
    cancel() {
      if (!child || child.killed) return false;
      cancelled = true;
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          child.kill('SIGINT');
        }
        return true;
      } catch {
        return false;
      }
    },

    /** 是否有子进程在执行。 */
    active() {
      return child !== null;
    },
  };
}
