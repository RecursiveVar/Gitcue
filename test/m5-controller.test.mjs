/**
 * REPL 控制器单元测试（无头 input() 驱动端到端）。
 * 覆盖：按键→候选→Tab→Enter(fake exec)→状态条 exit→历史→退出；danger 注入显示；
 * guide-shown 写入注入的 home 目录（.sandbox/m5/home/<用例名>/，绝不写真实主目录）；
 * providers update 重绘、占位符 Tab 触发 ensure、usage 统计、缓存失效映射；
 * view 契约（publish/suspend/resume/close）与执行透传交替时序。
 * 帧断言以 renderAppLines(捕获的 state) 复原行级文本；
 * stdin 生命周期契约（raw mode/监听挂卸）归 repl.mjs，见 tui-repl。
 *
 * 安全自检：before 钩子断言 GITCUE_HOME 指向 .sandbox/m5 内目录。
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { createController } from '../src/ui/controller.mjs';
import { renderAppLines } from '../src/ui/testHarness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SB = path.join(ROOT, '.sandbox', 'm5');

/** 用例级隔离的 home 目录 */
function caseHome(name) {
  const h = path.join(SB, 'home', name);
  rmSync(h, { recursive: true, force: true });
  mkdirSync(h, { recursive: true });
  return h;
}

before(() => {
  // 安全边界自检：所有用户级数据路径必须位于 .sandbox/m5 内
  process.env.GITCUE_HOME = path.join(SB, 'home');
  const resolved = path.resolve(process.env.GITCUE_HOME);
  assert.ok(
    resolved === path.resolve(SB, 'home') && resolved.startsWith(path.join(ROOT, '.sandbox')),
    `GITCUE_HOME 必须指向 .sandbox/m5/home（当前：${resolved}）`,
  );
});

// ───────── fake 依赖 ─────────

/** 记录 publish/suspend/resume/close 的视图（帧捕获语义） */
function fakeView() {
  const calls = { publishes: [], suspends: 0, resumes: [], close: 0 };
  return {
    calls,
    view: {
      publish(state) {
        calls.publishes.push(state);
      },
      suspend() {
        calls.suspends++;
      },
      resume(state) {
        calls.resumes.push(state);
      },
      close() {
        calls.close++;
      },
    },
  };
}

/** 已发布/恢复帧的行级复原 */
function publishedLines(calls) {
  return [...calls.publishes, ...calls.resumes].flatMap((s) => renderAppLines(s));
}

/** 手动结算的执行器（记录内联形态的 onData 流式回调与 write 转发） */
function fakeExec() {
  const calls = { runs: [], onDatas: [], writes: [], cancels: 0, resolvers: [] };
  return {
    calls,
    exec: {
      run(cmd, opts) {
        calls.runs.push(cmd);
        if (opts && typeof opts.onData === 'function') calls.onDatas.push(opts.onData);
        return new Promise((res) => calls.resolvers.push(res));
      },
      write(chunk) {
        calls.writes.push(chunk);
        return true;
      },
      cancel() {
        calls.cancels++;
        const r = calls.resolvers.shift();
        if (r) r({ code: 130, durationMs: 5 });
        return true;
      },
      active() {
        return calls.resolvers.length > 0;
      },
    },
  };
}

function fakeUsage() {
  const calls = { bumps: [], flushed: 0 };
  return {
    calls,
    usage: {
      count: () => 0,
      bump(k) {
        calls.bumps.push(k);
      },
      flush() {
        calls.flushed++;
      },
    },
  };
}

function fakeProviders(snapshot = { isRepo: true, branch: 'main', cwd: 'D:\\demo' }) {
  const calls = { ensures: [], invalidations: [], rechecks: 0, listeners: {} };
  return {
    calls,
    providers: {
      on(ev, cb) {
        calls.listeners[ev] = cb;
      },
      ensure(kind) {
        calls.ensures.push(kind);
      },
      invalidateAfterCommand(sub) {
        calls.invalidations.push(sub);
      },
      recheckRepo() {
        calls.rechecks++;
      },
      repoInfo: () => ({ ...snapshot, checkedAt: 1 }),
    },
  };
}

function fakeHistory() {
  const list = [];
  return {
    list,
    history: {
      load() {},
      all() {
        return [...list];
      },
      push(cmd) {
        if (list[0] !== cmd) list.unshift(cmd);
      },
    },
  };
}

/**
 * 假 suggest：按行内容构造最小 SuggestResult（命令前缀过滤 + git 路由近似）。
 * @param {object} [extra] 附加覆盖（如固定 candidates）
 */
function makeSuggest(extra = {}) {
  const calls = [];
  const suggest = (line, cursor) => {
    calls.push({ line, cursor });
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    const activeText = /(\S*)$/.exec(line)[1];
    const isGit = tokens[0] === 'git';
    const commandName = isGit ? (tokens[1] && tokens[1] !== activeText ? tokens[1] : null) : null;
    const base = {
      isGit,
      covered: true,
      phase: 'command',
      tokens: [],
      active: activeText ? { text: activeText, start: line.length - activeText.length, end: line.length, quoted: false } : null,
      marks: [],
      commandName,
      skeleton: { text: '', marks: [], cursor: null },
      positionLabel: '',
      candidates: [],
      corrections: [],
      debug: { timingsMs: {} },
    };
    if (!extra.candidates) {
      // 近似真实 suggest：仅 git 前缀行有命令候选（空行/非 git 无候选，↑ 走历史回溯）
      const all = ['rebase', 'remote', 'restore'].map((n) => ({
        text: n,
        summary: `说明${n}`,
        kind: 'command',
        patternId: null,
        paramHint: null,
        popularity: 3,
        usage: 0,
        since: null,
        insert: null,
      }));
      base.candidates = isGit ? all.filter((c) => c.text.startsWith(activeText)) : [];
    }
    return { ...base, ...extra };
  };
  return { suggest, calls };
}

function typeText(ctl, text) {
  for (const ch of text) ctl.input({ type: 'printable', ch });
}

/** 等待 exec 完成回调链（微任务 + 宏任务各一拍） */
async function settle() {
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

function baseDeps(over = {}) {
  const vw = fakeView();
  const ex = fakeExec();
  const us = fakeUsage();
  const pr = fakeProviders();
  const hi = fakeHistory();
  const sg = makeSuggest(over.suggestExtra ?? {});
  const deps = {
    suggest: sg.suggest,
    providers: pr.providers,
    exec: ex.exec,
    history: hi.history,
    usage: us.usage,
    // 本文件多数用例专测内联形态（execLog/回显/字节转发），显式钉住，不受默认值影响
    config: { exec_output: 'inline', ...over.config },
    i18n: { t: (k) => k },
    view: vw.view,
    gitVersion: null,
    dangerCheck: over.dangerCheck ?? null,
    home: over.home ?? caseHome('default'),
    showGuide: false,
    now: over.now ?? (() => 1000),
    onExit: over.onExit,
  };
  const ctl = createController(deps);
  return { ctl, deps, vw, ex, us, pr, hi, sg };
}

describe('m5-controller 无头端到端', () => {
  it('按键 → suggest 以最新行/光标调用 → attachView → publish', () => {
    const { ctl, sg, vw } = baseDeps();
    typeText(ctl, 'git reb');
    assert.equal(ctl.state.line, 'git reb');
    assert.deepEqual(sg.calls[sg.calls.length - 1], { line: 'git reb', cursor: 7 });
    assert.ok(ctl.state.view.candidates.some((c) => c.text === 'rebase'));
    assert.ok(vw.calls.publishes.length >= 3, '每次按键都应推送状态');
  });

  it('验收场景 1 等价：git reb + Tab → git rebase（含尾随空格）+ usage 计频', () => {
    const { ctl, us } = baseDeps();
    typeText(ctl, 'git reb');
    ctl.input({ type: 'tab' });
    assert.equal(ctl.state.line, 'git rebase ');
    assert.deepEqual(us.calls.bumps, ['cmd:rebase']);
  });

  it('Enter：原文交给 exec（内联形态：窗口常驻、输出进历史区、完成即回输入态）（验收 5 无头版）', async () => {
    const { ctl, ex, vw, hi } = baseDeps();
    typeText(ctl, 'git status');
    ctl.input({ type: 'enter' });
    assert.equal(ctl.state.mode, 'running');
    assert.equal(ctl.state.runningLine, 'git status');
    assert.deepEqual(ex.calls.runs, ['git status']); // 原样透传，无改写
    assert.equal(vw.calls.suspends, 0, '内联形态：窗口常驻不挂起');
    assert.equal(ctl.state.execLog.length, 1, '历史区先落运行中条目');
    assert.equal(ctl.state.execLog[0].code, null);
    assert.equal(ctl.state.execLog[0].cmd, 'git status');
    // 子进程输出流式进历史区
    assert.equal(ex.calls.onDatas.length, 1, '内联形态向 exec 传递 onData 流式回调');
    ex.calls.onDatas[0]('On branch main\n');
    ex.calls.resolvers.at(-1)({ code: 0, durationMs: 3 });
    await settle();
    assert.equal(ctl.state.mode, 'input', '完成直接回输入态（命令在历史区，无需按键确认）');
    assert.equal(ctl.state.line, '', '输入行已清空，可立即输入下一条');
    assert.deepEqual(ctl.state.lastExit, { code: 0, at: 1000 });
    assert.deepEqual(hi.list, ['git status']);
    assert.equal(vw.calls.resumes.length, 0, '内联形态无需 resume');
    const entry = ctl.state.execLog[0];
    assert.equal(entry.code, 0);
    assert.ok(entry.output.includes('On branch main'), '输出已捕获入历史区条目');
    assert.ok(publishedLines(vw.calls).some((l) => l.includes('✔ exit 0')), '完成帧含退出码');
    assert.ok(publishedLines(vw.calls).some((l) => l.includes('$ git status')), '历史区渲染命令行');
    assert.ok(publishedLines(vw.calls).some((l) => l.includes('On branch main')), '历史区渲染捕获输出');
  });

  it('内联执行态按键：可转发键重建字节写入子进程 stdin，本地回显入历史区（行式交互提示可用）', async () => {
    const { ctl, ex } = baseDeps();
    typeText(ctl, 'git add -p');
    ctl.input({ type: 'enter' });
    ctl.input({ type: 'printable', ch: 'y' });
    assert.deepEqual(ex.calls.writes, ['y']);
    assert.equal(ctl.state.execLog.at(-1).echo, 'y');
    ctl.input({ type: 'enter' });
    assert.deepEqual(ex.calls.writes, ['y', '\r']);
    assert.equal(ctl.state.execLog.at(-1).echo, 'y\n');
    ctl.input({ type: 'backspace' });
    assert.deepEqual(ex.calls.writes, ['y', '\r', '\x7f']);
    assert.equal(ctl.state.execLog.at(-1).echo, 'y');
    ex.calls.resolvers.at(-1)({ code: 0, durationMs: 1 });
    await settle();
    assert.equal(ctl.state.execLog.at(-1).echo, '', '完成后清空回显缓冲');
    assert.equal(ctl.state.execLog.at(-1).code, 0);
  });

  it('透传形态（exec_output=passthrough）：执行前警示帧 publish 在 suspend 之前，完成后 resume', async () => {
    const order = [];
    const ex = fakeExec();
    const hi = fakeHistory();
    const sg = makeSuggest();
    const ctl = createController({
      suggest: sg.suggest,
      providers: null,
      exec: ex.exec,
      history: hi.history,
      usage: null,
      config: { exec_output: 'passthrough' },
      i18n: { t: (k) => k },
      view: {
        publish: () => order.push('publish'),
        suspend: () => order.push('suspend'),
        resume: () => order.push('resume'),
        close: () => order.push('close'),
      },
      gitVersion: null,
      dangerCheck: null,
      home: caseHome('order'),
      showGuide: false,
      now: () => 1000,
    });
    typeText(ctl, 'git status');
    order.length = 0;
    ctl.input({ type: 'enter' });
    assert.deepEqual(order.slice(0, 2), ['publish', 'suspend'], '执行前先推警示帧再让出界面');
    ex.calls.resolvers.at(-1)({ code: 0, durationMs: 1 });
    await settle();
    assert.ok(order.includes('resume'), '执行完成后恢复界面');
  });

  it('执行完成后 usage 计频 cmd:<name> + matched options，并按子命令失效缓存', async () => {
    const sg = makeSuggest();
    const wrapped = (line, cursor) => {
      const v = sg.suggest(line, cursor);
      v.marks = [{ patternId: 'rebase:opt:-i', role: 'option' }, { patternId: 'rebase:opt:-i', role: 'option' }, { patternId: 'rebase:pos:<branch>', role: 'positional' }];
      return v;
    };
    const vw = fakeView();
    const ex = fakeExec();
    const us = fakeUsage();
    const pr = fakeProviders();
    const hi = fakeHistory();
    const ctl = createController({
      suggest: wrapped,
      providers: pr.providers,
      exec: ex.exec,
      history: hi.history,
      usage: us.usage,
      config: {},
      i18n: { t: (k) => k },
      view: vw.view,
      gitVersion: null,
      dangerCheck: null,
      home: caseHome('usage-bump'),
      showGuide: false,
      now: () => 1000,
    });
    typeText(ctl, 'git rebase -i main');
    ctl.input({ type: 'enter' });
    ex.calls.resolvers.at(-1)({ code: 0, durationMs: 1 });
    await settle();
    assert.ok(us.calls.bumps.includes('cmd:rebase'));
    assert.ok(us.calls.bumps.includes('opt:rebase:opt:-i'));
    assert.equal(us.calls.bumps.filter((k) => k === 'opt:rebase:opt:-i').length, 1, '重复 patternId 去重');
    assert.ok(!us.calls.bumps.includes('opt:rebase:pos:<branch>'), 'positional 不计 opt 频');
    assert.deepEqual(pr.calls.invalidations, ['rebase']);
    assert.equal(pr.calls.rechecks, 1);
  });

  it('高危命令：执行前 danger 注入并渲染警示', async () => {
    const { ctl, vw, ex } = baseDeps({
      dangerCheck: (tokens) => (tokens[0] === 'push' ? { message: '⚠ 强制推送将覆盖远端历史' } : null),
    });
    typeText(ctl, 'git push --force');
    ctl.input({ type: 'enter' });
    assert.equal(ctl.state.danger.message, '⚠ 强制推送将覆盖远端历史');
    // 执行前的强制 publish 帧包含警示
    assert.ok(publishedLines(vw.calls).some((l) => l.includes('⚠ 强制推送将覆盖远端历史')));
    ex.calls.resolvers.at(-1)({ code: 0, durationMs: 1 });
    await settle();
    assert.equal(ctl.state.mode, 'input');
  });

  it('高危命令：行尾活动词计入 danger 检测（真实 suggest 的 tokens 不含活动词，修复漏报）', async () => {
    // 模拟真实 suggest 形态：tokens 只含已完成词，行尾 --force 在 active 里
    const vw = fakeView();
    const ex = fakeExec();
    const sg = makeSuggest();
    const realShapeSuggest = (line) => {
      const v = sg.suggest(line);
      const tokens = line.trim().split(/\s+/).filter(Boolean);
      const activeText = /(\S*)$/.exec(line)[1];
      return {
        ...v,
        tokens: (activeText ? tokens.slice(0, -1) : tokens).map((t) => ({ text: t })),
        active: activeText ? { text: activeText, start: line.length - activeText.length, end: line.length, quoted: false } : null,
      };
    };
    const ctl = createController({
      suggest: realShapeSuggest,
      providers: null,
      exec: ex.exec,
      history: null,
      usage: null,
      config: { exec_output: 'passthrough' },
      i18n: { t: (k) => k },
      view: vw.view,
      gitVersion: null,
      dangerCheck: (tokens) =>
        tokens[0] === 'push' && (tokens[1] === '--force' || tokens[1] === '-f')
          ? { message: '⚠ 强制推送将覆盖远端历史' }
          : null,
      home: caseHome('danger-active-word'),
      showGuide: false,
      now: () => 1000,
    });
    typeText(ctl, 'git push --force');
    ctl.input({ type: 'enter' });
    assert.equal(ctl.state.danger && ctl.state.danger.message, '⚠ 强制推送将覆盖远端历史', '活动词 --force 必须参与高危检测');
    // 收尾：结算挂起的 exec 并等回调清理（SIGINT 处理器随之移除，避免跨用例泄漏）
    ex.calls.resolvers.at(-1)({ code: 128, durationMs: 1 });
    await settle();
  });

  it('running 态 Ctrl+C（按键路径）：cancel 中断子进程并回输入态，退出码 130 上屏', async () => {
    const { ctl, ex, vw } = baseDeps();
    typeText(ctl, 'git push');
    ctl.input({ type: 'enter' });
    ctl.input({ type: 'ctrl', ch: 'c' });
    assert.equal(ctl.state.mode, 'input');
    assert.equal(ex.calls.cancels, 1);
    await settle();
    assert.equal(ctl.state.mode, 'input'); // 不进 output
    assert.equal(ctl.state.lastExit.code, 130);
    assert.ok(publishedLines(vw.calls).some((l) => l.includes('✘ exit 130')), '中断后状态条显示退出码 130');
  });

  it('验收场景 7 等价：执行 A、B 后 ↑↑↓ 回溯并再次执行 B', async () => {
    const { ctl, ex } = baseDeps();
    typeText(ctl, 'git status');
    ctl.input({ type: 'enter' });
    ex.calls.resolvers.at(-1)({ code: 0, durationMs: 1 });
    await settle();
    typeText(ctl, 'git log');
    ctl.input({ type: 'enter' });
    ex.calls.resolvers.at(-1)({ code: 0, durationMs: 1 });
    await settle();
    assert.deepEqual(ctl.state.historyList, ['git log', 'git status']);
    assert.equal(ctl.state.mode, 'input', '完成后已在输入态（命令进历史区，输入行为空）');
    assert.equal(ctl.state.line, '', '执行后输入行自动清空');
    // 空行无候选：↑ 直接进入历史回溯
    ctl.input({ type: 'arrow', dir: 'up' });
    assert.equal(ctl.state.line, 'git log');
    ctl.input({ type: 'arrow', dir: 'up' });
    assert.equal(ctl.state.line, 'git status');
    ctl.input({ type: 'arrow', dir: 'down' });
    assert.equal(ctl.state.line, 'git log');
    ctl.input({ type: 'enter' });
    assert.equal(ex.calls.runs[ex.calls.runs.length - 1], 'git log');
    // 收尾：结算最后这个挂起的 exec 并等回调清理（SIGINT 处理器随之移除，避免跨用例泄漏）
    ex.calls.resolvers.at(-1)({ code: 0, durationMs: 1 });
    await settle();
  });

  it('占位符 Tab：不改行并触发 providers.ensure(kind)（展开请求）', () => {
    const { ctl, pr } = baseDeps({
      suggestExtra: {
        candidates: [{ text: '<remote>', summary: '远程名', kind: 'placeholder', placeholderKind: 'remote', insert: '', patternId: null }],
      },
    });
    typeText(ctl, 'git push ');
    ctl.input({ type: 'tab' });
    assert.equal(ctl.state.line, 'git push ');
    assert.deepEqual(pr.calls.ensures, ['remote']);
  });

  it('providers update 事件：重挂视图并重推状态（动态数据到达的局部刷新）', () => {
    const { ctl, pr, sg, vw } = baseDeps();
    const pubsBefore = vw.calls.publishes.length;
    const suggestsBefore = sg.calls.length;
    pr.calls.listeners.update();
    assert.equal(sg.calls.length, suggestsBefore + 1);
    assert.ok(vw.calls.publishes.length > pubsBefore);
    assert.equal(ctl.state.mode, 'input');
  });

  it('guide：首键离开引导并写入 <home>/guide-shown（沙箱内）', () => {
    const home = caseHome('guide');
    const vw = fakeView();
    const ex = fakeExec();
    const sg = makeSuggest();
    const ctl = createController({
      suggest: sg.suggest,
      providers: null,
      exec: ex.exec,
      history: null,
      usage: null,
      config: {},
      i18n: { t: (k) => k },
      view: vw.view,
      gitVersion: null,
      dangerCheck: null,
      home,
      showGuide: true,
      now: () => 1000,
    });
    assert.equal(ctl.state.mode, 'guide');
    ctl.input({ type: 'printable', ch: 'g' });
    assert.equal(ctl.state.mode, 'input');
    assert.equal(ctl.state.line, 'g');
    const marker = path.join(home, 'guide-shown');
    assert.ok(existsSync(marker), `guide-shown 应写入注入的 home：${marker}`);
    assert.ok(marker.startsWith(path.join(SB, 'home')), '标记文件必须位于 .sandbox/m5/home 内');
  });

  it('退出：Ctrl+Q → usage.flush / view.close / onExit 各一次（start() resolve 断言）', () => {
    let exitState = null;
    const { ctl, us, vw } = baseDeps({ onExit: (s) => (exitState = s) });
    ctl.input({ type: 'ctrl', ch: 'q' });
    assert.equal(ctl.state.mode, 'exited');
    assert.equal(us.calls.flushed, 1);
    assert.equal(vw.calls.close, 1);
    assert.equal(exitState.mode, 'exited', 'onExit 收到 exited 态（bin 装配的 onExit 链）');
    // 再按任意键无副作用
    ctl.input({ type: 'printable', ch: 'x' });
    assert.equal(vw.calls.close, 1);
    assert.equal(us.calls.flushed, 1);
  });

  it('Ctrl+C×2 退出 REPL', () => {
    const { ctl } = baseDeps();
    typeText(ctl, 'git st');
    ctl.input({ type: 'ctrl', ch: 'c' });
    assert.equal(ctl.state.mode, 'input');
    assert.equal(ctl.state.line, '');
    ctl.input({ type: 'ctrl', ch: 'c' });
    assert.equal(ctl.state.mode, 'exited');
  });

  it('未收录命令 Enter 直接透传，不产生错误（验收 11 无头版）', async () => {
    const { ctl, ex } = baseDeps();
    typeText(ctl, 'git mytool');
    ctl.input({ type: 'enter' });
    assert.deepEqual(ex.calls.runs, ['git mytool']);
    ex.calls.resolvers.at(-1)({ code: 1, durationMs: 1 });
    await settle();
    assert.equal(ctl.state.lastExit.code, 1);
    const ctlState = ctl.state;
    assert.equal(ctlState.mode, 'input');
    assert.equal(ctlState.execLog.at(-1).code, 1, '历史区条目记录非零退出码');
  });

  it('suggest 抛错不影响 REPL 存活（顶层兜底）', () => {
    const vw = fakeView();
    const ctl = createController({
      suggest: () => {
        throw new Error('boom');
      },
      providers: null,
      exec: fakeExec().exec,
      history: null,
      usage: null,
      config: {},
      i18n: { t: (k) => k },
      view: vw.view,
      gitVersion: null,
      dangerCheck: null,
      home: caseHome('suggest-throw'),
      showGuide: false,
      now: () => 1000,
    });
    ctl.input({ type: 'printable', ch: 'g' });
    assert.equal(ctl.state.mode, 'input');
  });

  // ───────── 执行态 SIGINT（cooked 模式 Ctrl+C 信号路径） ─────────

  it('执行态 Ctrl+C 以 SIGINT 送达（透传形态）：中断子进程并返回输入态；处理器挂载/移除各一次', async () => {
    const { ctl, ex, vw } = baseDeps({ config: { exec_output: 'passthrough' } });
    const sigintBefore = process.listenerCount('SIGINT');
    typeText(ctl, 'git push');
    ctl.input({ type: 'enter' });
    assert.equal(ctl.state.mode, 'running');
    assert.equal(process.listenerCount('SIGINT'), sigintBefore + 1, '执行态应挂载临时 SIGINT 处理器');
    process.emit('SIGINT'); // cooked 模式下 Ctrl+C 的进程信号形态（suspend 已恢复 cooked）
    assert.equal(ex.calls.cancels, 1, 'SIGINT 应中断子进程（exec.cancel）');
    assert.equal(ctl.state.mode, 'input', 'SIGINT 后应返回输入态');
    assert.equal(process.listenerCount('SIGINT'), sigintBefore, '中断后应移除临时 SIGINT 处理器');
    assert.ok(vw.calls.resumes.length >= 1, '中断后应恢复界面与输入');
    await settle();
    assert.equal(ctl.state.lastExit.code, 130, '被中断命令退出码 130');
  });

  it('执行出错（exec promise reject）：回输入态并显示 exit 1，历史区条目定格（界面恢复）', async () => {
    const exec = {
      run() {
        return Promise.reject(new Error('spawn ENOENT'));
      },
      cancel() {
        return true;
      },
    };
    const vw = fakeView();
    const sg = makeSuggest();
    const ctl = createController({
      suggest: sg.suggest,
      providers: null,
      exec,
      history: null,
      usage: null,
      config: { exec_output: 'inline' },
      i18n: { t: (k) => k },
      view: vw.view,
      gitVersion: null,
      dangerCheck: null,
      home: caseHome('exec-reject'),
      showGuide: false,
      now: () => 1000,
    });
    typeText(ctl, 'git status');
    ctl.input({ type: 'enter' });
    await settle();
    assert.equal(ctl.state.mode, 'input');
    assert.equal(ctl.state.lastExit.code, 1);
    assert.equal(ctl.state.execLog.at(-1).code, 1, '历史区条目定格失败码');
    assert.ok(vw.calls.publishes.length >= 1, '界面持续发布（常驻窗口）');
  });

  it('无头路径：input 直驱不触碰 view 之外的终端（内联形态全程 publish、零 suspend/resume）', async () => {
    const { ctl, vw, ex } = baseDeps();
    typeText(ctl, 'git status');
    ctl.input({ type: 'enter' });
    assert.equal(ctl.state.mode, 'running');
    assert.equal(vw.calls.suspends, 0, '内联形态不让出界面');
    assert.ok(vw.calls.publishes.length >= 1, '执行帧照常发布');
    ex.calls.resolvers.at(-1)({ code: 0, durationMs: 1 });
    await settle();
    assert.equal(ctl.state.mode, 'input');
    assert.equal(vw.calls.resumes.length, 0, '全程无 resume');
  });
});
