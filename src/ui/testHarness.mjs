/**
 * 无头渲染断言辅助（`src/ui/testHarness.mjs`）。
 *
 * 仅测试路径加载（ink-testing-library 与 ink 真实 render；产品运行时不 import 本文件）。
 *
 * 契约要点：
 *  - renderAppLines：行级渲染契约的唯一入口，**直接委托 renderPlainLines（单一真源）**，
 *    与生产 plain 路径（repl.mjs 直写终端的同一函数）构造上零漂移；不经 Ink/itl 渲染
 *    （itl 的 Stdout.columns 硬编码 100，且其 string-width 与项目 padWidth 对 ─/│ 等
 *    字形宽度判定不一致，经 itl 产线无法逐字节兼容）；
 *  - renderAppFrame：ANSI 形态整帧（经 itl，每次调用独立 mount+unmount）。**仅用于形态
 *    存在性断言**（非空、含 Ink 边框字形、引导行等）——100 显示列折行，不得对超宽行
 *    内容断言；itl 固定 debug:true（单次 mount ≈100–122ms），不得用于耗时断言；
 *  - createRenderSampler：生产模式渲染耗时采样器（性能抽样式断言专用）。
 */

import { createElement as h } from 'react';
import { render as itlRender } from 'ink-testing-library';
import { render as inkRender } from 'ink';
import { PassThrough } from 'node:stream';
import { GitcueApp, renderPlainLines } from './appView.mjs';

/** 剥离 ANSI 转义序列（零依赖正则实现：CSI/OSC 与单字符转义；幂等）。
 *  顺序敏感：CSI（ESC [ …）与 OSC（ESC ] …，BEL 或 ST 终止）分支必须先于单字符转义
 *  （[@-Z\\^_] 不含 [ ]，避免把 OSC 起始符 ] 当成单字符转义终符吃掉）。 */
export function stripAnsiCodes(s) {
  return String(s ?? '').replace(
    /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1B\\)?|[@-Z\\^_])/g,
    '',
  );
}

/**
 * 行级渲染契约（验收与单测的行断言唯一入口）。
 * **直接委托 renderPlainLines(state)——单一真源**：与生产 plain 路径零漂移（tui-harness
 * 有恒等断言守卫）。guide 态返回引导行；exited 态返回 []。
 * @param {object} state UiState
 * @returns {string[]}
 */
export function renderAppLines(state) {
  return renderPlainLines(state);
}

/**
 * ANSI 形态整帧（经 itl：render(h(GitcueApp, { state })) → lastFrame()，每次调用独立
 * mount+unmount；返回值已由 itl 剥离 ANSI 转义）。
 * 限制（如实登记，禁止扩大用途）：① 100 显示列折行——不得对超宽行内容断言；
 * ② itl 固定 debug:true——不得用于耗时断言。
 * @param {object} state UiState
 * @returns {string}
 */
export function renderAppFrame(state) {
  const inst = itlRender(h(GitcueApp, { state }));
  const frame = inst.lastFrame() ?? '';
  inst.unmount();
  return frame;
}

/**
 * 生产模式渲染耗时采样器（性能抽样式断言专用）。
 * 常驻一个 Ink 实例（真实 render、哑 stdout、debug:false——与真实 REPL 每键渲染同构，
 * 实测热身后 max 1.62ms / 均值 0.64ms @ 4 行树）；sample(state) 同步 rerender 并
 * 返回耗时 ms；close() unmount 收尾。构造时丢弃首 2 次 sample（冷启动预热不计入）。
 * @returns {{ sample(state: object): number, close(): void }}
 */
export function createRenderSampler() {
  // 哑 stdout：columns=80 / isTTY=true（避免 terminal-size 子进程探测），write 丢弃（不占内存）
  const dummyOut = new PassThrough();
  dummyOut.isTTY = true;
  dummyOut.columns = 80;
  dummyOut.rows = 24;
  const noopWrite = () => true;
  dummyOut.write = noopWrite;

  const instance = inkRender(h(GitcueApp, { state: null }), {
    stdout: dummyOut,
    stdin: new PassThrough(),
    exitOnCtrlC: false,
    patchConsole: false,
    debug: false,
  });

  // 构造时丢弃首 2 次 sample（冷启动预热不计入统计）
  for (let i = 0; i < 2; i++) instance.rerender(h(GitcueApp, { state: null }));

  return {
    /** 同步 rerender + 性能计时，返回本次渲染耗时（ms；热身后的同构路径）。 */
    sample(state) {
      const t0 = performance.now();
      instance.rerender(h(GitcueApp, { state }));
      return performance.now() - t0;
    },
    /** unmount 收尾。 */
    close() {
      instance.unmount();
    },
  };
}
