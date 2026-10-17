/**
 * 只读 git 子进程封装 —— 动态数据 Providers 的底层执行器。
 *
 * 安全：所有 git 子进程调用必须设置 GIT_TERMINAL_PROMPT=0（防止凭据提示挂起）；
 * 动态数据只调用只读 git 子命令，是否只读由调用方保证。
 *
 * 说明：不设置 GIT_CONFIG_NOSYSTEM——测试与运行环境的配置隔离统一由调用方通过
 * env 注入 GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM 指向沙箱内空文件实现。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 子进程输出缓冲上限：4MB */
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * 把 execFile 的返回值规整为字符串。
 * 指定 encoding:'utf8' 时本就是 string，此处对 Buffer 做防御性兜底。
 * @param {string | Buffer | null | undefined} value
 * @returns {string}
 */
function toText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return value.toString('utf8');
}

/**
 * 创建只读 git 查询器。
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
 *   cwd  git 执行目录（默认当前进程目录）；
 *   env  透传给子进程的环境变量（测试借此注入沙箱隔离变量），
 *        本模块仅在其上追加 GIT_TERMINAL_PROMPT=0，不改写其余条目。
 * @returns {{ run: (args: string[]) => Promise<{ code: number, stdout: string, stderr: string }> }}
 *   run 永不 reject：命令退出码与输出原样返回；git 无法启动（如未安装）时
 *   code 为 -1、stderr 为错误说明，由上层按"探测失败"降级处理。
 */
export function createGitQuery({ cwd = process.cwd(), env = process.env } = {}) {
  return {
    async run(args) {
      try {
        const { stdout, stderr } = await execFileAsync('git', args, {
          cwd,
          maxBuffer: MAX_BUFFER_BYTES,
          env: { ...env, GIT_TERMINAL_PROMPT: '0' },
          windowsHide: true,
          encoding: 'utf8',
        });
        return { code: 0, stdout: toText(stdout), stderr: toText(stderr) };
      } catch (err) {
        return {
          // 非零退出时 err.code 为退出码；进程启动失败（ENOENT 等）时为字符串 → 统一记 -1
          code: typeof err?.code === 'number' ? err.code : -1,
          stdout: toText(err?.stdout),
          stderr: toText(err?.stderr) || `git 执行失败: ${err?.message ?? '未知错误'}`,
        };
      }
    },
  };
}
