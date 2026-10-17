/**
 * REPL 终端装配层（`src/ui/repl.mjs`）。
 *
 * 职责：
 *  - createReplView：Ink 实例装配、键监听桥（keys.mjs 直挂 stdin，不用 useInput）、
 *    执行透传的界面交替（suspend/resume）；
 *  - shouldUseAnsi：ANSI 能力探测（不支持 ANSI 时降级纯文本模式的判定）；
 *  - raw mode 由本层自管（ink 8 无 useInput 消费者时不会自行开启 raw mode——
 *    mount/suspend/resume/close 四时点显式设置，否则真实终端 cooked 行缓冲、无头测不出）。
 *
 * 两条渲染路径：ansi=true 走 Ink 组件树（差分重绘由 Ink 内部承担）；
 * ansi=false 直写 renderPlainLines 全量纯文本（零转义序列，conhost/非 TTY 降级）。
 */

import process from 'node:process';
import { PassThrough } from 'node:stream';
import { createElement as h, useState } from 'react';
import { render as inkRender, useApp } from 'ink';
import { createKeyDecoder } from './keys.mjs';
import { GitcueApp, renderPlainLines } from './appView.mjs';

/** plain 路径行渲染（= appView.renderPlainLines；重新导出便于 bin 装配使用） */
export { renderPlainLines } from './appView.mjs';

/** 孤立 ESC 的 flush 等待（keys.mjs flush 的空闲结算窗口） */
const ESC_FLUSH_MS = 50;
/** 非 TTY/无 columns 时提供给 Ink 的假终端宽度（避免 terminal-size 子进程探测） */
const DUMMY_COLUMNS = 80;
const DUMMY_ROWS = 24;
/** 透传回显中危险警示的淡出窗口（与 appView.mjs 的 FADE_MS 一致） */
const ECHO_FADE_MS = 1500;
/** 透传回显危险行配色（仅 ANSI 路径着色） */
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

/**
 * 透传执行的原生回显块（suspend 擦除窗口后写入，留在终端回滚缓冲里，形如原生 shell
 * 历史）：`$ <命令行>` 一行，命中高危警示（1.5s 淡出口径内）时追加一行警示文案
 * （ANSI 路径红字）。非运行态（无命令行可回显）返回 null。
 * @param {object} state 最新 UiState（mode=running 时取 runningLine/danger）
 * @param {() => number} nowMs 时钟（与 controller 的 state.danger.at 同源口径）
 * @param {boolean} ansi 是否 ANSI 路径（决定警示行着色）
 * @returns {string|null} 以换行结尾的回显文本；无可回显内容返回 null
 */
function passthroughEchoOf(state, nowMs, ansi) {
  if (!state || state.mode !== 'running' || !state.runningLine) return null;
  const lines = [`$ ${String(state.runningLine)}`];
  if (state.danger && nowMs() - state.danger.at < ECHO_FADE_MS) {
    const msg = String(state.danger.message);
    lines.push(ansi ? `${ANSI_RED}${msg}${ANSI_RESET}` : msg);
  }
  return lines.map((l) => `${l}\n`).join('');
}

/**
 * ANSI 能力探测（不支持 ANSI 时降级纯文本模式的判定）：
 * 非 TTY / NO_COLOR / TERM=dumb / Windows 传统 conhost（无 WT_SESSION、TERM、
 * ConEmuANSI、ANSICON 且非 mintty）→ false（纯文本降级）。
 * @param {{ stdout?: { isTTY?: boolean }, env?: object }} [opts]
 * @returns {boolean}
 */
export function shouldUseAnsi({ stdout, env = process.env } = {}) {
  if (!stdout || stdout.isTTY !== true) return false;
  if (env.NO_COLOR) return false; // https://no-color.org：存在且非空时禁用
  if (env.TERM === 'dumb') return false;
  if (process.platform === 'win32') {
    const mintty = env.TERM_PROGRAM === 'mintty';
    if (!env.WT_SESSION && !env.TERM && !env.ConEmuANSI && !env.ANSICON && !mintty) return false;
  }
  return true;
}

/**
 * 非 TTY stdout 或 columns 不可用时，以 Proxy 包装显式提供 columns/rows
 * （避免 Ink 经 terminal-size 包 spawn 子进程探测列宽，实测省约 270ms）。
 * 其余属性与方法原样透传（函数绑定到原流）。
 */
function wrapStdoutWithColumns(stdout) {
  if (stdout.isTTY === true && typeof stdout.columns === 'number' && stdout.columns > 0) return stdout;
  return new Proxy(stdout, {
    get(target, prop, receiver) {
      if (prop === 'columns') return DUMMY_COLUMNS;
      if (prop === 'rows') return DUMMY_ROWS;
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/**
 * 创建 REPL 终端装配视图。
 * @param {{ onKey: (key: object) => void,   // 按键回调（bin 装配处绑定 controller.input）
 *           ansi: boolean,                  // shouldUseAnsi 结果
 *           stdout?: object, stdin?: object, now?: () => number }} opts
 * @returns {{ mount(state: object): void, publish(state: object): void, suspend(): void,
 *             resume(state: object): void, close(): void, waitExit(): Promise<void> }}
 */
export function createReplView({ onKey, ansi, stdout = process.stdout, stdin = process.stdin, now = Date.now }) {
  /** 提供给 Ink 的 stdout（columns 包装一次定稿，保证 instances Map 键稳定） */
  const inkStdout = wrapStdoutWithColumns(stdout);

  let mounted = false; // mount 与 suspend/close 之间为 true
  let closed = false;
  let inkInstance = null; // Ink 渲染实例（ANSI 路径）
  let holder = null; // { state, set, suspendTerminal, waitUntilRenderFlush } React 外部状态桥（ANSI 路径）
  let suspendedHandle = null; // Ink suspendTerminal 句柄 Promise（透传执行期间终端交给子进程；Ink 保持挂载）
  let latest = null; // suspend 期间缓存的最新 state（未挂载时不得 setState）
  let keyDecoder = null;
  let dataListener = null;
  let flushTimer = null;
  let blinkTimer = null; // 输入态光标闪烁定时器（仅 ANSI 路径）
  let exitResolve = null;
  const exitPromise = new Promise((resolve) => {
    exitResolve = resolve;
  });

  // ───────── 终端尺寸注入与光标闪烁（渲染层自治，不进 controller 状态） ─────────

  /** 读当前终端尺寸（真实 TTY 的 rows/columns 随 resize 变化；非 TTY 走包装层的固定值）。 */
  function termInfo() {
    return { rows: Number(inkStdout.rows) || 0, columns: Number(inkStdout.columns) || 0 };
  }

  /** 给 state 附加 term 尺寸（浅拷贝；历史区据此按终端剩余高度收缩预算，防帧顶滚出视口）。 */
  function withTerm(state) {
    if (!state || state.term) return state;
    return { ...state, term: termInfo() };
  }

  /**
   * 输入态光标闪烁：约 530ms 交替 █（醒目块）↔ ▏（细条，仍标示位置）。
   * 仅 ANSI 路径（Ink 差分重绘只更新变化行，代价低）；plain 路径无重绘能力、恒显 █。
   * 闪烁只翻转渲染态的 cursorBlink 字段，不回写 controller；controller 推送新帧时自然复位。
   */
  function startBlink() {
    if (blinkTimer || !ansi || closed) return;
    blinkTimer = setInterval(() => {
      if (!mounted || closed || !latest || latest.mode !== 'input') return;
      if (holder && holder.box && holder.box.set) {
        holder.box.set({ ...latest, cursorBlink: !latest.cursorBlink });
      }
    }, 530);
    if (typeof blinkTimer.unref === 'function') blinkTimer.unref();
  }

  function stopBlink() {
    if (blinkTimer) {
      clearInterval(blinkTimer);
      blinkTimer = null;
    }
  }

  // ───────── raw mode 自管 ─────────

  function setRaw(enabled) {
    try {
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(enabled);
    } catch {
      /* 流可能已销毁：幂等设置无害，失败忽略 */
    }
  }

  // ───────── 键监听桥 ─────────

  function onData(buf) {
    const keys = keyDecoder.feed(buf);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      for (const k of keyDecoder.flush()) {
        onKey(k);
        if (closed) break;
      }
    }, ESC_FLUSH_MS);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
    for (const k of keys) {
      onKey(k);
      if (closed) break;
    }
  }

  function attachKeyListener() {
    if (!keyDecoder || dataListener) return;
    dataListener = onData;
    stdin.on('data', dataListener);
  }

  function detachKeyListener() {
    if (flushTimer) {
      // 取消待触发的孤立 ESC flush，避免卸载后补入一个按键干扰子进程/执行态
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (dataListener) {
      stdin.removeListener('data', dataListener);
      dataListener = null;
    }
  }

  // ───────── ANSI / plain 两条渲染路径 ─────────

  /** 构造根组件（外部 state 桥：publish 推 state → setState 触发 Ink 差分重渲染；
   *  同时捕获 useApp 的 suspendTerminal/waitUntilRenderFlush 供透传执行交替使用） */
  function makeRoot(initialState) {
    const box = { state: initialState, set: null, suspendTerminal: null, waitUntilRenderFlush: null };
    function Root() {
      const app = useApp();
      box.suspendTerminal = app.suspendTerminal;
      box.waitUntilRenderFlush = app.waitUntilRenderFlush;
      const [st, setSt] = useState(box.state);
      box.set = setSt;
      return h(GitcueApp, { state: st });
    }
    return { box, Root };
  }

  function renderInk() {
    holder = makeRoot(latest);
    // 三项挂载参数均必要：exitOnCtrlC:false 防 Ink 抢占 Ctrl+C
    // （Ctrl+C×2 退出语义）；哑 stdin 使非 TTY 下 Ink 不触碰真 stdin；patchConsole:false 不拦截 console
    inkInstance = inkRender(h(holder.Root), {
      stdout: inkStdout,
      stdin: stdin.isTTY ? stdin : new PassThrough(),
      exitOnCtrlC: false,
      patchConsole: false,
    });
  }

  /** plain 路径：直写全量纯文本（零转义序列） */
  function writePlain(state) {
    const lines = renderPlainLines(state);
    if (lines.length) stdout.write(lines.join('\n') + '\n');
  }

  function doMount(state) {
    latest = withTerm(state);
    // raw mode 自管先于键监听（cooked 模式下逐键不实时到达）
    setRaw(true);
    try {
      stdin.resume();
    } catch {
      /* 非 TTY / 已销毁：忽略 */
    }
    keyDecoder = createKeyDecoder();
    attachKeyListener();
    if (ansi) {
      renderInk();
      startBlink();
    } else {
      writePlain(latest);
    }
    mounted = true;
  }

  return {
    /** 挂载界面与输入桥（REPL 启动）。 */
    mount(state) {
      if (closed || mounted) return;
      doMount(state);
    },

    /** 状态变化后推送一帧（未挂载/挂起时仅缓存最新 state，resume 消费）。 */
    publish(state) {
      latest = withTerm(state);
      if (!mounted || closed) return;
      if (ansi) {
        if (holder && holder.box && holder.box.set) holder.box.set(latest);
      } else {
        writePlain(latest);
      }
    },

    /**
     * 执行态让出：① 卸键监听 ② setRawMode(false)
     * （cooked 模式，Ctrl+C 以终端信号送达执行态 SIGINT 处理器）③ stdin.pause()（按键
     * 留给 inherit 同一 stdin 的交互式子进程）④ 窗口整块擦除 + 原生回显。
     * 全部同步完成后 controller 才 spawn 子进程，杜绝复原序列与子进程首字节交错。
     *
     * 单窗口语义（ANSI 路径）：经 Ink 原生 suspendTerminal（同步完成「flush 挂起渲染 →
     * 按帧精确擦除当前窗口 → 光标复原」，Ink 保持挂载）把终端交给子进程，随后写入
     * `$ <命令行>`（含高危警示）原生回显——回滚缓冲里留下的只有原生形态的命令与输出，
     * 不留旧窗口残帧；resume 经 endSuspend 在输出下方全量重绘，任意时刻屏幕上只有
     * 一个活动窗口。plain 路径无重绘能力，仅以空行分隔并写出回显。
     */
    suspend() {
      if (!mounted || closed) return;
      mounted = false;
      stopBlink();
      detachKeyListener();
      setRaw(false);
      try {
        stdin.pause(); // 父进程停止读取，按键留给子进程（忠实交互）
      } catch {
        /* 忽略 */
      }
      const echo = passthroughEchoOf(latest, now, ansi);
      if (ansi && inkInstance) {
        if (holder && holder.box && typeof holder.box.suspendTerminal === 'function') {
          // beginSuspend 在本次调用内同步完成（async 函数首个 await 之前全同步）
          try {
            suspendedHandle = holder.box.suspendTerminal();
          } catch {
            suspendedHandle = null;
          }
        }
        if (suspendedHandle === null) {
          // 兜底：拿不到挂起句柄（低版本 Ink/异常）→ 退回卸载路径（已有帧留于回滚缓冲）
          inkInstance.unmount();
          inkInstance = null;
          holder = null;
        }
      } else if (!ansi) {
        stdout.write('\n'); // plain 路径：输出空行分隔界面与回显/子进程输出
      }
      if (echo !== null) stdout.write(echo);
    },

    /** 执行结束/中断后恢复界面与输入：挂起路径经 endSuspend 在子进程输出之下全量重绘
     *  （先把最新状态提交进 Ink——挂起期间渲染被丢弃、提交保留）；兜底路径小树重建
     *  开销可忽略（生产模式 mount ≈ 23ms）。raw/键监听的恢复同步完成。 */
    resume(state) {
      if (closed) return;
      if (typeof state !== 'undefined') latest = withTerm(state);
      if (mounted) {
        this.publish(latest);
        return;
      }
      setRaw(true);
      try {
        stdin.resume();
      } catch {
        /* 忽略 */
      }
      keyDecoder = keyDecoder || createKeyDecoder();
      attachKeyListener();
      if (ansi && suspendedHandle !== null) {
        mounted = true;
        startBlink();
        const box = holder && holder.box;
        void (async () => {
          if (box && box.set) box.set(latest); // 最新帧（挂起期间的 publish 只进缓存）
          // 等提交落地（挂起中 onRender 丢弃绘制但解析提交）；限时兜底防流异常时重绘被永久搁置
          try {
            await Promise.race([
              Promise.resolve(box.waitUntilRenderFlush?.()),
              new Promise((r) => setTimeout(r, 200)),
            ]);
          } catch {
            /* 忽略 */
          }
          const handle = suspendedHandle === null ? null : await suspendedHandle.catch(() => null);
          suspendedHandle = null;
          if (handle) {
            try {
              await handle.resume(); // endSuspend：收回输入 + 复位帧账目 + 全量重绘当前提交
            } catch {
              /* 忽略：重绘失败不阻塞交互 */
            }
          }
        })();
        return;
      }
      if (ansi) {
        renderInk();
        startBlink();
      } else {
        writePlain(latest);
      }
      mounted = true;
    },

    /** 退出清理：卸键监听、Ink unmount、raw mode 复位；waitExit 随之 resolve。 */
    close() {
      if (closed) return;
      closed = true;
      mounted = false;
      stopBlink();
      detachKeyListener();
      setRaw(false);
      try {
        stdin.pause();
        // 管道/TTY stdin 句柄在被引用时会使事件循环保持存活（实测：pipe 下仅 pause 进程
        // 不会退出）——退出路径必须 unref 释放句柄，Ctrl+Q/Ctrl+C×2 后进程才能自然退出
        if (typeof stdin.unref === 'function') stdin.unref();
      } catch {
        /* 忽略 */
      }
      if (suspendedHandle !== null) {
        // 挂起中退出（理论不可达：执行态无退出键；防御兜底）：异步 endSuspend 复位挂起态，
        // 其重绘会被 unmount 的 isUnmounting/isUnmounted 抑制
        const p = suspendedHandle;
        suspendedHandle = null;
        Promise.resolve(p)
          .then((h) => h.resume())
          .catch(() => {});
      }
      if (ansi && inkInstance) {
        inkInstance.unmount(); // Ink 自身：清帧、光标复原（其 raw mode 无属主，不与自管冲突）
        inkInstance = null;
      }
      holder = null;
      if (exitResolve) exitResolve();
    },

    /** resolve 于 close()（bin 装配 onExit 链）。 */
    waitExit() {
      return exitPromise;
    },
  };
}
