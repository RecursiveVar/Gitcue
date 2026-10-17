/**
 * REPL 控制器（`src/ui/controller.mjs`）。
 *
 * 编排与时序：input(key)（handleKey → attachView → Tab 采纳计频 →
 * 占位符 ensure → danger → 执行 → 退出清理）；get state()；draw() 触发点；providers
 * update 事件处理（running 态不重绘守卫）；guide-shown 写入（home 注入）；历史快照装载。
 *
 * 渲染与终端接线归 view/repl.mjs：
 *  - deps.view 契约：{ publish(state), suspend(), resume(state), close() }；
 *  - REPL 主循环在 repl.mjs（键监听桥 + raw mode 自管）；
 *  - 透传执行前 view.suspend()，执行完成 view.resume(st)；
 *    teardown 调 view.close()。
 *  本模块保持零第三方 import，单次模式/无头驱动不载 react/ink。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { createInitialState, handleKey, attachView, beginExec, appendExecOutput, endExec, forwardBytesOf } from './reducer.mjs';

/** 状态条动态段淡出窗口（与 appView.mjs 的 FADE_MS 一致） */
const FADE_MS = 1500;

/**
 * 创建 REPL 控制器。
 * @param {object} deps 依赖集合（view 契约见 repl.mjs 的 createReplView）
 * @returns {{ input(key: object): void, get state(): object, draw(): void }}
 */
export function createController(deps) {
  const d = deps || {};
  const now = () => (d.now ? d.now() : Date.now());

  let st = createInitialState({
    config: d.config ?? {},
    lang: d.config && d.config.lang,
    plain: Boolean(d.plain), // 可选补充依赖：装配层据 shouldUseAnsi 计算后注入
    repo: d.repo ?? (d.providers && typeof d.providers.repoInfo === 'function' ? toRepo(d.providers.repoInfo()) : undefined),
    showGuide: Boolean(d.showGuide),
    now: now(),
  });

  /** @type {NodeJS.Timeout|null} 淡出重绘定时器 */
  let fadeTimer = null;
  /** @type {NodeJS.Timeout|null} 内联执行输出流式重绘节流定时器 */
  let streamTimer = null;
  let tornDown = false;
  /** @type {(() => void)|null} 执行态临时 SIGINT 处理器（cooked 模式 Ctrl+C 中断子进程） */
  let sigintHandler = null;

  // ───────── 内部工具 ─────────

  function toRepo(info) {
    if (!info) return { isRepo: false, branch: null, cwd: '' };
    return { isRepo: Boolean(info.isRepo), branch: info.branch ?? null, cwd: info.cwd ?? '' };
  }

  function safeCall(fn) {
    try {
      return fn();
    } catch (err) {
      process.stderr.write(`gitcue: ${err && err.message ? err.message : String(err)}\n`);
      return undefined;
    }
  }

  /** 执行命令的 Token 文本数组（不含行首 'git'，供 danger 检测与缓存失效）。 */
  function tokensForExec(view, line) {
    let toks =
      view && Array.isArray(view.tokens) && view.tokens.length ? view.tokens.map((t) => t.text) : null;
    if (toks) {
      // suggest 的 tokens 不含光标处活动词（活动词不参与匹配）——
      // 行尾正在输入的词（如 `git push --force` 的 --force）必须并入，否则高危检测漏报
      if (view.active && view.active.text) toks = [...toks, view.active.text];
    } else {
      toks = String(line || '').trim().split(/\s+/).filter(Boolean);
    }
    return toks.length && toks[0] === 'git' ? toks.slice(1) : toks;
  }

  /** 候选 → 使用频率统计键 usageKey。 */
  function usageKeyOf(c) {
    if (!c) return null;
    if (c.kind === 'command') return `cmd:${c.text}`;
    if (c.kind === 'dynamic') return c.placeholderKind ? `dyn:${c.placeholderKind}:${c.text}` : null;
    if (c.kind === 'placeholder') return null; // 占位符本身不计频
    return c.patternId ? `opt:${c.patternId}` : null;
  }

  /** 新行末 Token 文本（判断 Tab 是否完整采纳了某候选）。 */
  function lastTokenText(line) {
    const parts = String(line || '').trim().split(/\s+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  /** guide → 离开引导态时写入标记文件（home 由 deps 注入，绝不读写 env/主目录）。 */
  function markGuideShown() {
    if (!d.home) return;
    safeCall(() => {
      mkdirSync(d.home, { recursive: true });
      writeFileSync(path.join(d.home, 'guide-shown'), '');
    });
  }

  /** 刷新标题区仓库信息（providers 快照只读，best-effort）。 */
  function refreshRepo() {
    if (d.providers && typeof d.providers.repoInfo === 'function') {
      const info = safeCall(() => d.providers.repoInfo());
      if (info && info.isRepo !== null && info.isRepo !== undefined) {
        const repo = toRepo(info);
        if (repo.isRepo !== st.repo.isRepo || repo.branch !== st.repo.branch) st = { ...st, repo };
      }
    }
  }

  function scheduleFade() {
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      fadeTimer = null;
      draw();
    }, FADE_MS + 100);
    if (typeof fadeTimer.unref === 'function') fadeTimer.unref();
  }

  // ───────── providers 异步边 ─────────

  if (d.providers && typeof d.providers.on === 'function') {
    d.providers.on('update', () => {
      // 动态数据/仓库信息到达：重算候选（suggest 读取最新快照）并局部刷新。
      // 内联执行期间界面常驻，刷新照常进行（历史区与空行候选互不干扰）。
      safeCall(() => {
        st = attachView(st, d.suggest(st.line, st.cursor));
        refreshRepo();
        draw();
      });
    });
  }

  // 启动时载入历史快照
  if (d.history) {
    safeCall(() => {
      if (typeof d.history.load === 'function') d.history.load();
      st = { ...st, historyList: d.history.all() };
    });
  }

  // ───────── 渲染 ─────────

  function draw() {
    st = { ...st, now: now() };
    d.view.publish(st); // 未挂载（透传执行挂起）时 view.publish 仅缓存最新 state
  }

  // ───────── 执行与统计 ─────────

  /** Tab 采纳成功 → 使用频率 +1。 */
  function bumpIfAdopted(prevState, nextState) {
    if (!d.usage || !prevState.view) return;
    if (nextState.line === prevState.line) return; // 未采纳
    const cands = prevState.view.candidates || [];
    if (!cands.length) return;
    let cand = null;
    if (cands.length === 1) {
      cand = cands[0];
    } else {
      const sel = cands[Math.min(Math.max(prevState.selected, 0), cands.length - 1)];
      // 高亮候选被完整采纳（新行末 Token 等于候选文本）时才计频
      if (sel && lastTokenText(nextState.line) === sel.text) cand = sel;
    }
    const key = usageKeyOf(cand);
    if (key) safeCall(() => d.usage.bump(key));
  }

  /** 命令执行完成后：cmd:<name> + 各 matched option 的 opt:<patternId> 计频。 */
  function bumpAfterExec(view) {
    if (!d.usage || !view || !view.isGit) return;
    if (view.commandName) safeCall(() => d.usage.bump(`cmd:${view.commandName}`));
    const seen = new Set();
    for (const m of view.marks || []) {
      if (m && m.role === 'option' && m.patternId && !seen.has(m.patternId)) {
        seen.add(m.patternId);
        safeCall(() => d.usage.bump(`opt:${m.patternId}`));
      }
    }
  }

  /** 移除执行态临时 SIGINT 处理器（幂等）。 */
  function removeSigintHandler() {
    if (sigintHandler !== null) {
      process.removeListener('SIGINT', sigintHandler);
      sigintHandler = null;
    }
  }

  /** 执行态挂载临时 SIGINT 处理器：cooked 模式下 Ctrl+C 以终端信号送达
   *  （Windows 下 Node 将 CTRL_C_EVENT 映射为 'SIGINT' 事件）。 */
  function installSigintHandler() {
    if (sigintHandler !== null) return;
    sigintHandler = () => {
      safeCall(() => {
        if (d.exec && typeof d.exec.cancel === 'function') d.exec.cancel();
        if (st.mode === 'running') st = { ...st, mode: 'input' };
        removeSigintHandler();
        d.view.resume(st); // 恢复界面与输入并推送当前帧
      });
    };
    process.on('SIGINT', sigintHandler);
  }

  /** 内联执行：子进程输出流式回调（节流重绘，约 25fps 上限，避免长输出刷屏卡顿）。 */
  function onStream(text) {
    st = appendExecOutput(st, text);
    if (streamTimer === null) {
      streamTimer = setTimeout(() => {
        streamTimer = null;
        draw();
      }, 40);
      if (typeof streamTimer.unref === 'function') streamTimer.unref();
    }
  }

  function runExec(line, viewAtEnter) {
    const inline = st.config?.exec_output !== 'passthrough';
    let res;
    try {
      if (inline) {
        // 历史区先落一条运行中条目再启动子进程（窗口常驻，无需让位）
        st = beginExec(st, line, now());
        draw();
        res = d.exec.run(line, { onData: (text) => onStream(text) });
      } else {
        res = d.exec.run(line);
      }
    } catch (err) {
      process.stderr.write(`gitcue: 执行失败: ${err && err.message ? err.message : err}\n`);
      res = Promise.resolve({ code: 1, durationMs: 0 });
    }
    Promise.resolve(res).then(
      (r) => {
        const code = r && typeof r.code === 'number' ? r.code : 0;
        const wasRunning = st.mode === 'running';
        removeSigintHandler();
        if (streamTimer !== null) {
          clearTimeout(streamTimer);
          streamTimer = null;
        }
        if (inline) st = endExec(st, code); // 历史区条目定格（含被 Ctrl+C 中断的 130）
        st = { ...st, lastExit: { code, at: now() } };
        if (wasRunning) {
          st = { ...st, mode: 'input' }; // 执行完成直接回输入态（命令已在历史区，无需按键确认）
          safeCall(() => {
            if (d.history) {
              d.history.push(line);
              st = { ...st, historyList: d.history.all() };
            }
          });
          bumpAfterExec(viewAtEnter);
          if (d.providers && typeof d.providers.invalidateAfterCommand === 'function') {
            // 失效映射以 git 子命令为键（不含行首 'git'）
            const sub = tokensForExec(viewAtEnter, line)[0];
            if (sub) safeCall(() => d.providers.invalidateAfterCommand(sub));
          }
          if (d.providers && typeof d.providers.recheckRepo === 'function') {
            safeCall(() => d.providers.recheckRepo()); // 完成/中断后重探（分支变化经 update 事件回填标题）
          }
          refreshRepo();
        }
        scheduleFade();
        if (inline) draw();
        else d.view.resume(st);
      },
      (err) => {
        process.stderr.write(`gitcue: 执行出错: ${err && err.message ? err.message : err}\n`);
        removeSigintHandler();
        if (streamTimer !== null) {
          clearTimeout(streamTimer);
          streamTimer = null;
        }
        if (inline) st = endExec(st, 1);
        if (st.mode === 'running') st = { ...st, mode: 'input' };
        st = { ...st, lastExit: { code: 1, at: now() } };
        scheduleFade();
        if (inline) draw();
        else d.view.resume(st);
      },
    );
  }

  // ───────── 退出清理 ─────────

  function teardown() {
    if (tornDown) return;
    tornDown = true;
    if (fadeTimer) clearTimeout(fadeTimer);
    if (streamTimer !== null) clearTimeout(streamTimer);
    if (d.usage && typeof d.usage.flush === 'function') safeCall(() => d.usage.flush());
    safeCall(() => d.view.close());
    if (typeof d.onExit === 'function') safeCall(() => d.onExit(st));
  }

  // ───────── 按键入口（无头驱动与真实终端共用） ─────────

  /**
   * 无头驱动入口（与真实按键路径等价：真实终端下 repl.mjs 的键监听桥同样调本函数）。
   * @param {object} key Key 事件（见 keys.mjs）
   */
  function input(key) {
    try {
      const prev = st;
      let next = handleKey(st, key);
      const changed =
        next.line !== prev.line || next.cursor !== prev.cursor || next.mode !== prev.mode;
      if (changed) next = attachView(next, d.suggest(next.line, next.cursor));

      // guide → input：写入 guide-shown 标记（一次性引导）
      if (prev.mode === 'guide' && next.mode !== 'guide') markGuideShown();

      // Tab 采纳 → 使用频率统计
      if (key && key.type === 'tab') bumpIfAdopted(prev, next);

      // Tab 命中占位符候选（未改行）→ 触发该 kind 的动态数据加载
      if (key && key.type === 'tab' && prev.view) {
        const cands = prev.view.candidates || [];
        if (cands.length) {
          const c = cands[Math.min(Math.max(prev.selected, 0), cands.length - 1)];
          if (c && c.insert === '' && c.placeholderKind && d.providers && typeof d.providers.ensure === 'function') {
            safeCall(() => d.providers.ensure(c.placeholderKind));
          }
        }
      }

      // 执行态 Ctrl+C：中断子进程（reducer 已把状态切回 input）
      if (prev.mode === 'running' && key && key.type === 'ctrl' && key.ch === 'c') {
        if (d.exec && typeof d.exec.cancel === 'function') safeCall(() => d.exec.cancel());
      }

      // 执行态（内联形态）：可转发键按解码事件重建字节写入子进程 stdin，
      // 行式交互提示（如 git add -p 的 y/n/q 应答）保持可用；本地回显由 reducer 完成
      if (
        prev.mode === 'running' &&
        next.mode === 'running' &&
        st.config?.exec_output !== 'passthrough' &&
        d.exec &&
        typeof d.exec.write === 'function'
      ) {
        const bytes = forwardBytesOf(key);
        if (bytes) safeCall(() => d.exec.write(bytes));
      }

      st = next;

      if (st.mode === 'running' && prev.mode === 'input') {
        // 执行前：高危警示，两种输出形态共用
        const viewForDanger = prev.view;
        if (d.dangerCheck) {
          const danger = safeCall(() => d.dangerCheck(tokensForExec(viewForDanger, st.runningLine))) || null;
          if (danger) st = { ...st, danger: { message: danger.message, at: now() } };
        }
        if (st.config?.exec_output === 'passthrough') {
          // 透传形态（原样透传分支）：绘制运行指示帧后让出界面与 stdin；
          // suspend 后 stdin 处于 cooked 模式，Ctrl+C 以终端 SIGINT 送达
          draw();
          installSigintHandler();
          // view.suspend 内部同步完成「卸键监听 → setRawMode(false) → pause → Ink unmount」，
          // 之后才 spawn 子进程（杜绝复原序列与子进程首字节交错）
          d.view.suspend();
        }
        // 内联形态：窗口常驻不挂起，runExec 内部先落历史区条目再启动子进程
        runExec(st.runningLine, viewForDanger);
        return;
      }
      if (st.mode === 'exited' && prev.mode !== 'exited') {
        teardown();
        return;
      }
      draw();
    } catch (err) {
      // 顶层兜底：单键异常不终止 REPL
      process.stderr.write(`gitcue: 界面处理按键出错: ${err && err.stack ? err.stack : err}\n`);
    }
  }

  return {
    input,
    draw: () => draw(),
    get state() {
      return st;
    },
  };
}
