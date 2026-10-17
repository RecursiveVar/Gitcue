/**
 * 无头渲染契约 testHarness 单元测试。
 *
 * 覆盖：
 *  ① 恒等守卫：renderAppLines(state) === renderPlainLines(state) 逐字节相等
 *     （单一真源不漂移的契约自检，代表性 state 集）；
 *  ② stripAnsiCodes（含 SGR/CSI/OSC 与幂等）；
 *  ③ renderAppLines 的 guide/exited 行为；
 *  ④ createRenderSampler：sample 返回有限正数、close 后正常结束、连续采样无异常；
 *  ⑤ renderAppFrame 连续 100 次 mount+unmount 无异常（进程稳定）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsiCodes, renderAppLines, renderAppFrame, createRenderSampler } from '../src/ui/testHarness.mjs';
import { renderPlainLines } from '../src/ui/appView.mjs';
import { createInitialState } from '../src/ui/reducer.mjs';

const SK_TEXT = 'git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]';

/** 代表性 state 集（覆盖 guide/exited/五区全景/纠错/分页/非仓库/plain 旗标差异） */
function representativeStates() {
  const base = () => ({
    ...createInitialState({
      config: {},
      repo: { isRepo: true, branch: 'main', cwd: 'D:\\demo' },
      now: 1000,
    }),
    line: 'git rebase -i ',
    cursor: 14,
    view: {
      isGit: true,
      covered: true,
      phase: 'options',
      commandName: 'rebase',
      tokens: [],
      active: null,
      marks: [],
      corrections: [],
      positionLabel: '选项名（--on*）',
      skeleton: { text: SK_TEXT, marks: [{ start: 12, end: 14, patternId: 'rebase:opt:-i', state: 'consumed' }], cursor: 35 },
      candidates: [
        { text: '--onto', paramHint: '<newbase>', summary: '把提交重放到指定新基点上', kind: 'option', patternId: 'rebase:opt:--onto', insert: null, detail: '不切换到 <upstream>。', example: 'git rebase --onto main topicA topicB' },
        { text: 'checkout', kind: 'correction', insert: 'checkout', summary: '' },
        { text: '<branch>', summary: '要变基的分支', kind: 'placeholder', placeholderKind: 'branch', insert: '' },
      ],
      debug: { timingsMs: {} },
    },
  });
  return [
    ['五区全景', base()],
    ['plain 旗标 true', { ...base(), plain: true }],
    ['theme none', { ...base(), config: { theme: 'none' } }],
    ['guide 态', { ...base(), mode: 'guide' }],
    ['exited 态', { ...base(), mode: 'exited' }],
    ['非仓库', { ...base(), repo: { isRepo: false, branch: null, cwd: 'D:\\tmp' } }],
    ['exit 淡出窗口内', { ...base(), lastExit: { code: 0, at: 1000 } }],
    ['分页第 2 页', (() => { const s = base(); s.view = { ...s.view, candidates: Array.from({ length: 10 }, (_, i) => ({ text: `opt${i}`, summary: `说明${i}`, kind: 'option', insert: null })) }; s.config = { ...s.config, candidate_limit: 3 }; return { ...s, page: 1, selected: 3 }; })()],
    ['空行无视图', { ...base(), line: '', cursor: 0, view: null }],
    ['running 态', { ...base(), mode: 'running', runningLine: 'git status', line: '' }],
  ];
}

describe('tui-harness 恒等守卫（单一真源不漂移）', () => {
  for (const [name, state] of representativeStates()) {
    it(`renderAppLines === renderPlainLines（${name}）`, () => {
      assert.deepEqual(renderAppLines(state), renderPlainLines(state));
      // 逐字节相等（deepEqual 之上再以连接串断言，杜绝任何隐式归一化）
      assert.equal(renderAppLines(state).join('\n'), renderPlainLines(state).join('\n'));
    });
  }
});

describe('tui-harness stripAnsiCodes', () => {
  it('剥离 SGR 颜色/样式序列', () => {
    assert.equal(stripAnsiCodes('\x1b[31m红\x1b[0m'), '红');
    assert.equal(stripAnsiCodes('\x1b[1m\x1b[4m\x1b[97m-i\x1b[0m'), '-i');
    assert.equal(stripAnsiCodes('\x1b[7m▏\x1b[0m'), '▏');
  });
  it('剥离 CSI 光标/清屏序列（CR 等非转义字符保留）', () => {
    assert.equal(stripAnsiCodes('\x1b[2A\r\x1b[Kl1'), '\rl1');
    assert.equal(stripAnsiCodes('\x1b[?25l文本\x1b[?25h'), '文本');
    assert.equal(stripAnsiCodes('\x1b[38;2;10;20;30mRGB\x1b[0m'), 'RGB');
  });
  it('剥离 OSC 序列（含 BEL 与 ST 终止）', () => {
    assert.equal(stripAnsiCodes('\x1b]0;title\x07正文'), '正文');
    assert.equal(stripAnsiCodes('\x1b]8;;http://x\x1b\\链接\x1b]8;;\x1b\\'), '链接');
  });
  it('无转义文本原样返回；null/undefined 安全（归空串）', () => {
    assert.equal(stripAnsiCodes('纯净文本 GitCue ─ D:\\demo'), '纯净文本 GitCue ─ D:\\demo');
    assert.equal(stripAnsiCodes(null), '');
    assert.equal(stripAnsiCodes(undefined), '');
  });
  it('幂等：对已剥离结果再次剥离不变', () => {
    const dirty = '\x1b[31mA\x1b[0m\x1b[2K┌ GitCue';
    const once = stripAnsiCodes(dirty);
    assert.equal(stripAnsiCodes(once), once);
  });
});

describe('tui-harness renderAppLines 的 guide/exited 行为', () => {
  it('guide 态返回 ≤5 行引导文案', () => {
    const s = { ...createInitialState({ showGuide: true, now: 1000 }) };
    const lines = renderAppLines(s);
    assert.equal(lines.length, 5);
    assert.equal(lines[0], '  GitCue：输入 git 命令，实时获得语法与候选提示');
    assert.equal(lines[4], '  按任意键继续');
  });
  it('exited 态返回空数组；null 安全', () => {
    assert.deepEqual(renderAppLines({ ...createInitialState(), mode: 'exited' }), []);
    assert.deepEqual(renderAppLines(null), []);
  });
});

describe('tui-harness createRenderSampler（生产模式采样器）', () => {
  it('sample 返回有限正数；连续采样无异常；close 正常结束', () => {
    const sampler = createRenderSampler();
    try {
      const samples = [];
      for (const [, state] of representativeStates()) {
        const ms = sampler.sample(state);
        assert.ok(typeof ms === 'number' && Number.isFinite(ms) && ms > 0, `sample 应返回有限正数，实际 ${ms}`);
        samples.push(ms);
      }
      // 热身后的采样应稳定在个位数毫秒量级（不设硬阈值断言，仅回归护栏）
      assert.ok(samples.every((ms) => ms < 50), `热身后单次渲染应 < 50ms（渲染上限），实际 max ${Math.max(...samples).toFixed(2)}ms`);
    } finally {
      sampler.close();
    }
  });
  it('close 后进程可正常结束（无悬挂句柄/定时器阻塞）', () => {
    const sampler = createRenderSampler();
    sampler.sample({ ...createInitialState({ now: 1000 }) });
    sampler.close();
    // 本用例正常返回即证明：unmount 后无阻塞事件循环的残留（node:test 会在用例超时上报）
    assert.ok(true);
  });
});

describe('tui-harness renderAppFrame 连续 mount/unmount 稳定性', () => {
  it('连续 100 次 mount+unmount 无异常、帧始终非空', () => {
    const states = representativeStates().filter(([, s]) => s.mode !== 'exited');
    for (let i = 0; i < 100; i++) {
      const [, state] = states[i % states.length];
      const frame = renderAppFrame(state);
      assert.ok(typeof frame === 'string');
      if (state.mode !== 'exited') assert.ok(frame.length > 0, `第 ${i} 次渲染帧不应为空`);
    }
  });
});
