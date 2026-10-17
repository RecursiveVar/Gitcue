/**
 * repl 终端装配层单元测试。
 *
 * 覆盖：
 *  - shouldUseAnsi 判定矩阵；
 *  - createReplView 的 raw mode 契约（无头盲区的契约级补偿）：
 *    注入带 setRawMode 桩（记录调用序列）与 isTTY:true 的假 stdin，断言
 *    mount→setRawMode(true)、suspend→setRawMode(false)+pause、
 *    resume→setRawMode(true)+resume、close→setRawMode(false)；
 *  - suspend/resume 的键监听挂/卸与 pause 语义、suspend 期间 publish 仅缓存；
 *  - exitOnCtrlC:false / patchConsole:false 传参（源码级静态断言 + Ctrl+C 行为断言）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import process from 'node:process';
import { createReplView, shouldUseAnsi, renderPlainLines as replReExport } from '../src/ui/repl.mjs';
import { renderPlainLines } from '../src/ui/appView.mjs';
import { createInitialState } from '../src/ui/reducer.mjs';

// ───────────────── shouldUseAnsi（判定矩阵） ─────────────────

describe('tui-repl shouldUseAnsi（降级探测）', () => {
  const TTY = { isTTY: true };
  const NO_TTY = { isTTY: false };

  it('非 TTY → false', () => {
    assert.equal(shouldUseAnsi({ stdout: NO_TTY, env: {} }), false);
  });
  it('TTY 且无禁用环境 → true（POSIX 形态环境）', () => {
    // 本机为 win32：给 TERM 模拟 Git Bash/mintty 形态
    assert.equal(shouldUseAnsi({ stdout: TTY, env: { TERM: 'xterm-256color' } }), true);
  });
  it('NO_COLOR 存在且非空 → false（空串按 no-color.org 规范不禁用）', () => {
    assert.equal(shouldUseAnsi({ stdout: TTY, env: { TERM: 'xterm', NO_COLOR: '1' } }), false);
    assert.equal(shouldUseAnsi({ stdout: TTY, env: { TERM: 'xterm', NO_COLOR: '' } }), true);
  });
  it('TERM=dumb → false', () => {
    assert.equal(shouldUseAnsi({ stdout: TTY, env: { TERM: 'dumb' } }), false);
  });
  it('Windows 传统 conhost（无 WT_SESSION/TERM/ConEmuANSI/ANSICON）→ false', () => {
    assert.equal(shouldUseAnsi({ stdout: TTY, env: {} }), false);
    assert.equal(shouldUseAnsi({ stdout: TTY, env: { TERM_PROGRAM: 'vscode' } }), false);
  });
  it('Windows 下带任一现代终端标记 → true', () => {
    assert.equal(shouldUseAnsi({ stdout: TTY, env: { WT_SESSION: '1' } }), true);
    assert.equal(shouldUseAnsi({ stdout: TTY, env: { ConEmuANSI: 'ON' } }), true);
    assert.equal(shouldUseAnsi({ stdout: TTY, env: { ANSICON: '1' } }), true);
    assert.equal(shouldUseAnsi({ stdout: TTY, env: { TERM_PROGRAM: 'mintty' } }), true);
  });
  it('repl.mjs 重新导出 renderPlainLines（bin 装配便利）', () => {
    assert.equal(replReExport, renderPlainLines);
  });
});

// ───────────────── 测试替身 ─────────────────

/** 记录 setRawMode/pause/resume/unref 与 data 监听增删的假 stdin（isTTY:true） */
function fakeStdin() {
  const calls = { rawModes: [], paused: 0, resumed: 0, unrefed: 0 };
  const listeners = new Set();
  const stdin = {
    isTTY: true,
    setRawMode(v) {
      calls.rawModes.push(v);
    },
    pause() {
      calls.paused += 1;
    },
    resume() {
      calls.resumed += 1;
    },
    unref() {
      calls.unrefed += 1;
    },
    on(ev, fn) {
      if (ev === 'data') listeners.add(fn);
      return stdin;
    },
    removeListener(ev, fn) {
      if (ev === 'data') listeners.delete(fn);
      return stdin;
    },
    listenerCount: (ev) => (ev === 'data' ? listeners.size : 0),
    /** 模拟终端字节送达（仅当前已挂载的监听器收到；无监听器 = 留给共享 stdin 的子进程） */
    emitData(buf) {
      for (const fn of [...listeners]) fn(typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf);
    },
  };
  return { stdin, calls };
}

/** 记录写入的假 stdout（itl 同款形态：EventEmitter + write + isTTY + columns；
 *  write 支持 callback——Ink waitUntilRenderFlush 依赖 write('', cb) 回调） */
function fakeStdout() {
  const out = new EventEmitter();
  out.isTTY = true;
  out.columns = 80;
  out.rows = 24;
  out.chunks = [];
  out.write = (s, cb) => {
    out.chunks.push(s);
    if (typeof cb === 'function') cb();
    return true;
  };
  return out;
}

function st(line, extra = {}) {
  return {
    ...createInitialState({ repo: { isRepo: true, branch: 'main', cwd: 'D:\\demo' }, now: 1000 }),
    line,
    cursor: line.length,
    view: {
      isGit: true,
      covered: true,
      phase: 'command',
      commandName: 'rebase',
      tokens: [],
      active: null,
      marks: [],
      corrections: [],
      positionLabel: '',
      skeleton: { text: '', marks: [], cursor: null },
      candidates: [],
      debug: { timingsMs: {} },
    },
    ...extra,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────── raw mode 契约（无头盲区的契约级补偿） ─────────────────

describe('tui-repl createReplView raw mode 与键监听契约（ANSI 路径）', () => {
  it('mount → setRawMode(true) + resume + 挂 data 监听；close → setRawMode(false) + pause + 卸监听', () => {
    const fs = fakeStdin();
    const out = fakeStdout();
    const view = createReplView({ onKey: () => {}, ansi: true, stdout: out, stdin: fs.stdin });
    view.mount(st('git'));
    assert.equal(fs.calls.rawModes.at(-1), true, 'mount 后应进入 raw 模式');
    assert.ok(fs.calls.resumed >= 1, 'mount 后应 resume stdin');
    assert.equal(fs.stdin.listenerCount('data'), 1, 'mount 后应挂载 data 监听');
    view.close();
    assert.equal(fs.calls.rawModes.at(-1), false, 'close 后应退出 raw 模式');
    assert.ok(fs.calls.paused >= 1, 'close 后应 pause stdin');
    assert.ok(fs.calls.unrefed >= 1, 'close 后应 unref stdin（管道/TTY 句柄引用会使进程无法退出）');
    assert.equal(fs.stdin.listenerCount('data'), 0, 'close 后应卸载 data 监听');
  });

  it('suspend → setRawMode(false) + pause + 卸监听；resume → setRawMode(true) + resume + 重挂监听', () => {
    const fs = fakeStdin();
    const out = fakeStdout();
    const view = createReplView({ onKey: () => {}, ansi: true, stdout: out, stdin: fs.stdin });
    view.mount(st('git'));
    fs.calls.rawModes.length = 0;
    view.suspend();
    assert.equal(fs.calls.rawModes.at(-1), false, 'suspend 后应恢复 cooked 模式（子进程获得常规终端）');
    assert.ok(fs.calls.paused >= 1, 'suspend 后父进程应暂停读取 stdin（按键留给子进程）');
    assert.equal(fs.stdin.listenerCount('data'), 0, 'suspend 后应移除 data 监听');
    fs.calls.rawModes.length = 0;
    view.resume(st('git st'));
    assert.equal(fs.calls.rawModes.at(-1), true, 'resume 后应恢复 raw 模式');
    assert.ok(fs.calls.resumed >= 2, 'resume 后应 resume stdin');
    assert.equal(fs.stdin.listenerCount('data'), 1, 'resume 后应重新挂载 data 监听');
    view.close();
  });

  it('键监听桥：stdin 字节 → keys.mjs 解码 → onKey', () => {
    const fs = fakeStdin();
    const out = fakeStdout();
    const keys = [];
    const view = createReplView({ onKey: (k) => keys.push(k), ansi: true, stdout: out, stdin: fs.stdin });
    view.mount(st('git'));
    fs.stdin.emitData('a');
    fs.stdin.emitData('\r');
    fs.stdin.emitData('\x1b[A'); // ↑
    fs.stdin.emitData('\t');
    assert.deepEqual(keys, [
      { type: 'printable', ch: 'a' },
      { type: 'enter' },
      { type: 'arrow', dir: 'up' },
      { type: 'tab' },
    ]);
    view.close();
  });

  it('suspend 期间按键不进入父进程管线（监听已卸载）', async () => {
    const fs = fakeStdin();
    const out = fakeStdout();
    const keys = [];
    const view = createReplView({ onKey: (k) => keys.push(k), ansi: true, stdout: out, stdin: fs.stdin });
    view.mount(st('git'));
    view.suspend();
    fs.stdin.emitData('y');
    await sleep(5);
    assert.equal(keys.length, 0, 'suspend 后字节应留给子进程，父进程不解码');
    view.close();
  });

  it('孤立 ESC：50ms 空闲 flush 结算为 escape 键', async () => {
    const fs = fakeStdin();
    const out = fakeStdout();
    const keys = [];
    const view = createReplView({ onKey: (k) => keys.push(k), ansi: true, stdout: out, stdin: fs.stdin });
    view.mount(st('git'));
    fs.stdin.emitData('\x1b'); // 单按 Esc 只发送一个字节
    assert.equal(keys.length, 0, 'ESC 前缀需等待是否为序列前缀');
    await sleep(80);
    assert.deepEqual(keys, [{ type: 'escape' }], '50ms 空闲后结算为孤立 escape');
    view.close();
  });

  it('Ctrl+C 以按键事件送达 onKey（exitOnCtrlC:false 不被 Ink 抢占）', () => {
    const fs = fakeStdin();
    const out = fakeStdout();
    const keys = [];
    const view = createReplView({ onKey: (k) => keys.push(k), ansi: true, stdout: out, stdin: fs.stdin });
    view.mount(st('git'));
    fs.stdin.emitData('\x03');
    assert.deepEqual(keys, [{ type: 'ctrl', ch: 'c' }], 'Ctrl+C 应走键管线（第一次清行语义），而非 Ink 直杀进程');
    // 之后视图仍可用（未被 Ink 自行 unmount）
    view.publish(st('git s'));
    view.suspend();
    view.resume(st('git st'));
    view.close();
  });
});

// ───────────────── plain 路径与 publish 缓存语义 ─────────────────

describe('tui-repl plain 路径与 publish 缓存', () => {
  it('mount/publish 直写 renderPlainLines 全量纯文本；无转义序列', () => {
    const out = fakeStdout();
    const view = createReplView({ onKey: () => {}, ansi: false, stdout: out, stdin: fakeStdin().stdin });
    const s1 = st('git reb');
    view.mount(s1);
    view.publish(st('git reba'));
    view.close();
    const text = out.chunks.join('');
    assert.ok(text.includes('输入: git reb▏'));
    assert.ok(text.includes('输入: git reba▏'));
    assert.ok(!text.includes('\x1b'), 'plain 路径零转义序列');
  });

  it('suspend 输出空行分隔；suspend 期间 publish 仅缓存不输出；resume 消费', () => {
    const out = fakeStdout();
    const view = createReplView({ onKey: () => {}, ansi: false, stdout: out, stdin: fakeStdin().stdin });
    view.mount(st('git'));
    out.chunks.length = 0;
    view.suspend();
    assert.deepEqual(out.chunks, ['\n'], 'plain suspend 输出一个空行分隔');
    view.publish(st('git suspended-state')); // suspend 期间到达：仅缓存（未挂载不得 setState）
    assert.equal(out.chunks.length, 1, 'suspend 期间 publish 不产生输出');
    view.resume(st('git resumed-state')); // resume 消费（显式传入的最新 state 胜出）
    const text = out.chunks.join('');
    assert.ok(text.includes('输入: git resumed-state▏'), 'resume 后渲染 resume 参数（最新 state）');
    assert.ok(!text.includes('git suspended-state'), '缓存的中间态被更新覆盖（只保留最新）');
    view.close();
  });

  it('resume() 无参时消费 suspend 期间缓存的最新 state', () => {
    const out = fakeStdout();
    const view = createReplView({ onKey: () => {}, ansi: false, stdout: out, stdin: fakeStdin().stdin });
    view.mount(st('git'));
    view.suspend();
    view.publish(st('git cached-latest'));
    view.resume(); // 无参：消费缓存
    assert.ok(out.chunks.join('').includes('输入: git cached-latest▏'));
    view.close();
  });

  it('透传回显（plain）：运行态 suspend 写出「$ 命令行」原生回显（含高危警示行）', () => {
    const out = fakeStdout();
    const view = createReplView({ onKey: () => {}, ansi: false, stdout: out, stdin: fakeStdin().stdin, now: () => 5000 });
    view.mount(st('git'));
    view.publish({
      ...st(''),
      mode: 'running',
      runningLine: 'git push --force',
      danger: { message: '⚠ 强制推送将覆盖远端历史', at: 4000 },
    });
    out.chunks.length = 0;
    view.suspend();
    const text = out.chunks.join('');
    assert.ok(text.includes('\n$ git push --force\n'), `应写出原生回显行，实际 ${JSON.stringify(text.slice(-120))}`);
    assert.ok(text.includes('⚠ 强制推送将覆盖远端历史'), '淡出口径内的危险警示应随回显保留（plain 不着色）');
    assert.ok(!text.includes('\x1b['), 'plain 路径警示行不带 ANSI 转义');
    view.resume(st('git'));
    view.close();
  });

  it('透传回显：非运行态 suspend 不写回显（保持原空行分隔）；过期警示不随回显保留', () => {
    const out = fakeStdout();
    const view = createReplView({ onKey: () => {}, ansi: false, stdout: out, stdin: fakeStdin().stdin, now: () => 5000 });
    view.mount(st('git'));
    view.publish({ ...st(''), mode: 'running', runningLine: 'git status', danger: { message: '⚠ 旧警示', at: 1000 } });
    out.chunks.length = 0;
    view.suspend(); // danger.at 距 now 4000ms > 1500ms 淡出窗口
    const text = out.chunks.join('');
    assert.ok(text.includes('$ git status\n'), '命令行回显保留');
    assert.ok(!text.includes('旧警示'), '过期警示不随回显保留');
    assert.ok(!text.includes('$ git status\n$'), '无警示时回显仅一行');
    view.resume(st('git'));
    // 非运行态：无 runningLine 可回显
    const out2 = fakeStdout();
    const view2 = createReplView({ onKey: () => {}, ansi: false, stdout: out2, stdin: fakeStdin().stdin });
    view2.mount(st('git'));
    out2.chunks.length = 0;
    view2.suspend();
    assert.deepEqual(out2.chunks, ['\n'], '非运行态 suspend 保持原空行分隔（无回显）');
    view2.close();
  });

  it('close 后 publish/mount/resume 均为无操作；waitExit 已 resolve', async () => {
    const out = fakeStdout();
    const view = createReplView({ onKey: () => {}, ansi: false, stdout: out, stdin: fakeStdin().stdin });
    view.mount(st('git'));
    view.close();
    const before = out.chunks.length;
    view.publish(st('git after-close'));
    view.mount(st('git again'));
    view.resume(st('git again2'));
    view.suspend();
    assert.equal(out.chunks.length, before, 'close 后不再有任何输出');
    await view.waitExit(); // 已 resolve（不挂起即通过）
    assert.ok(true);
  });

  it('waitExit 在 close() 前 pending，close() 后 resolve', async () => {
    const out = fakeStdout();
    const view = createReplView({ onKey: () => {}, ansi: false, stdout: out, stdin: fakeStdin().stdin });
    view.mount(st('git'));
    let exited = false;
    const p = view.waitExit().then(() => {
      exited = true;
    });
    await sleep(10);
    assert.equal(exited, false, 'close 前 waitExit 不 resolve');
    view.close();
    await p;
    assert.equal(exited, true);
  });
});

// ───────────────── 挂载参数静态断言（exitOnCtrlC/patchConsole） ─────────────────

describe('tui-repl Ink 挂载参数（静态契约）', () => {
  it('render 调用显式传 exitOnCtrlC:false 与 patchConsole:false（源码级断言）', () => {
    const src = readFileSync(path.join(import.meta.dirname, '..', 'src', 'ui', 'repl.mjs'), 'utf8');
    assert.match(src, /exitOnCtrlC:\s*false/, '必须显式 exitOnCtrlC:false（防 Ink 抢占 Ctrl+C）');
    assert.match(src, /patchConsole:\s*false/, '必须显式 patchConsole:false');
    assert.match(src, /stdin:\s*stdin\.isTTY\s*\?\s*stdin\s*:\s*new PassThrough\(\)/, '非 TTY 时以哑流喂 Ink（不触真 stdin）');
  });

  it('mount 后 stdout 收到 Ink 帧（真实 render 管线打通）', () => {
    const out = fakeStdout();
    const view = createReplView({ onKey: () => {}, ansi: true, stdout: out, stdin: fakeStdin().stdin });
    view.mount(st('git reb'));
    view.close();
    const text = out.chunks.join('');
    assert.ok(text.length > 0, 'Ink 应向注入的 stdout 写帧');
    assert.ok(text.includes('GitCue'), '帧内容含标题');
  });

  it('透传回显（ANSI）：运行态 suspend 经 Ink suspendTerminal 写出带色回显；resume 恢复 raw/监听', async () => {
    const fs = fakeStdin();
    const out = fakeStdout();
    const view = createReplView({ onKey: () => {}, ansi: true, stdout: out, stdin: fs.stdin, now: () => 5000 });
    view.mount(st('git'));
    view.publish({
      ...st(''),
      mode: 'running',
      runningLine: 'git reset --hard',
      danger: { message: '⚠ 危险命令', at: 4000 },
    });
    out.chunks.length = 0;
    view.suspend();
    const text = out.chunks.join('');
    assert.ok(text.includes('$ git reset --hard\n'), `应写出原生回显行，实际尾段 ${JSON.stringify(text.slice(-160))}`);
    assert.ok(text.includes('\x1b[31m⚠ 危险命令\x1b[0m'), 'ANSI 路径警示行红字');
    fs.calls.rawModes.length = 0;
    view.resume(st('git'));
    assert.equal(fs.calls.rawModes.at(-1), true, 'resume 后应恢复 raw 模式');
    assert.equal(fs.stdin.listenerCount('data'), 1, 'resume 后应重新挂载 data 监听');
    await sleep(150); // endSuspend 全量重绘（异步）完成
    view.close();
    assert.ok(out.chunks.join('').includes('GitCue'), 'resume 后窗口应重新绘出（单窗口回到屏幕）');
  });
});

// 防止 import process 未使用告警的显式引用（shouldUseAnsi 内部使用 process.platform）
assert.ok(typeof process.platform === 'string');

// ───────────────── 输入态光标闪烁（渲染层自治定时器，仅 ANSI 路径） ─────────────────

describe('tui-repl 光标闪烁与终端尺寸注入', () => {
  it('ANSI 路径输入态：约 530ms 交替 █/▏ 两种光标形态；close 后定时器停止', async () => {
    const { stdin } = fakeStdin();
    const out = fakeStdout();
    const view = createReplView({ onKey: () => {}, ansi: true, stdout: out, stdin });
    view.mount(st('', { mode: 'input' }));
    const text = () => out.chunks.join('');
    const t0 = Date.now();
    while (!text().includes('▏') && Date.now() - t0 < 4000) {
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.ok(text().includes('█'), '初始应渲染醒目光标块 █');
    assert.ok(text().includes('▏'), `约 530ms 后应出现细条形态 ▏（闪烁），实际输出尾段 ${JSON.stringify(text().slice(-160))}`);
    view.close();
    const lenAtClose = text().length;
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(text().length, lenAtClose, 'close 后闪烁定时器应停止，不再写帧');
  });

  it('plain 路径不启动闪烁定时器（无重绘能力，恒显 ▏ 细条）', async () => {
    const { stdin } = fakeStdin();
    const out = fakeStdout();
    const view = createReplView({ onKey: () => {}, ansi: false, stdout: out, stdin });
    view.mount(st('', { mode: 'input' }));
    const before = out.chunks.length;
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(out.chunks.length, before, 'plain 路径不应有定时器驱动的额外写帧');
    view.close();
  });

  it('publish 注入 term 尺寸：小 rows 终端下渲染帧的历史区按预算收缩（可观察行为）', () => {
    const { stdin } = fakeStdin();
    const out = fakeStdout();
    out.rows = 21; // 历史区预算 = 21 - 16 = 5 行
    const view = createReplView({ onKey: () => {}, ansi: false, stdout: out, stdin });
    const base = st('', { mode: 'input' });
    const tall = {
      ...base,
      config: { ...base.config, log_height: 10 },
      execLog: [
        {
          cmd: 'git log --oneline',
          output: Array.from({ length: 14 }, (_, i) => `commit-${i}`).join('\n') + '\n',
          echo: '',
          code: 0,
          at: 1000,
        },
      ],
    };
    view.mount(tall);
    const frame = out.chunks.join('');
    const lines = frame.split('\n');
    const contentLines = lines.filter((l) => l.includes('commit-') || l.includes('$ git log'));
    const markerLines = lines.filter((l) => l.includes('已省略'));
    // 预算 5：内容行（命令行+输出）≤5，另可有一行省略标记；更早内容（含命令行）被裁
    assert.ok(
      contentLines.length <= 5,
      `小终端（rows=21）历史区内容应 ≤5 行，实际 ${contentLines.length}：${JSON.stringify(contentLines)}`,
    );
    assert.equal(markerLines.length, 1, '应恰有一行省略标记');
    assert.ok(contentLines.some((l) => l.includes('commit-13')), '保尾策略应保留最新输出行 commit-13');
    view.close();
  });
});
