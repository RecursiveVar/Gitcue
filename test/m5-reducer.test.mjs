/**
 * 按键 reducer 单元测试（纯函数无头驱动）。
 * 覆盖：按键行为表逐行、Tab 补全算法（唯一/LCP/placeholder 展开/correction 替换/
 * paramHint 不插参）、历史回溯、mode 流转、output 态防吞键、不可变性、attachView 钳制。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, handleKey, attachView } from '../src/ui/reducer.mjs';

const P = (ch) => ({ type: 'printable', ch });
const ENTER = { type: 'enter' };
const TAB = { type: 'tab' };
const ESC = { type: 'escape' };

/** 快捷构造初始态 */
function init(opts = {}) {
  return createInitialState({ config: opts.config ?? {}, now: 1000, ...opts });
}

/** 构造最小 SuggestResult 形状的假视图（reducer 只读 candidates/active/tokens/corrections） */
function fakeView({ candidates = [], active = null, tokens = [], corrections = [] } = {}) {
  return {
    isGit: true,
    covered: true,
    phase: 'options',
    tokens,
    active,
    marks: [],
    commandName: 'x',
    skeleton: { text: '', marks: [], cursor: null },
    positionLabel: '',
    candidates,
    corrections,
    debug: { timingsMs: {} },
  };
}

function type(state, text) {
  let s = state;
  for (const ch of text) s = handleKey(s, P(ch));
  return s;
}

describe('m5-reducer 初始态', () => {
  it('默认字段齐全', () => {
    const s = init();
    assert.equal(s.mode, 'input');
    assert.equal(s.line, '');
    assert.equal(s.cursor, 0);
    assert.equal(s.selected, 0);
    assert.equal(s.page, 0);
    assert.equal(s.detailOpen, false);
    assert.equal(s.dismissed, false);
    assert.equal(s.historyIndex, null);
    assert.equal(s.ctrlcCount, 0);
    assert.equal(s.view, null);
    assert.equal(s.lang, 'zh-CN');
    assert.deepEqual({ ...s.repo }, { isRepo: false, branch: null, cwd: process.cwd() });
  });
  it('showGuide → guide 态；config 覆盖生效', () => {
    const s = init({ showGuide: true, config: { candidate_limit: 3, lang: 'en-US' } });
    assert.equal(s.mode, 'guide');
    assert.equal(s.config.candidate_limit, 3);
    assert.equal(s.lang, 'en-US');
    assert.equal(s.config.pager, 'cat'); // 兜底默认值仍在
  });
});

describe('m5-reducer 行编辑', () => {
  it('printable 插入光标处并推进光标', () => {
    const s = type(init(), 'git reb');
    assert.equal(s.line, 'git reb');
    assert.equal(s.cursor, 7);
  });
  it('光标移到中间后插入', () => {
    let s = type(init(), 'ab');
    s = handleKey(handleKey(s, { type: 'home' }), P('X'));
    assert.equal(s.line, 'Xab');
    assert.equal(s.cursor, 1);
  });
  it('left/right/home/end/ctrl+a/ctrl+e 移动光标并钳制', () => {
    let s = type(init(), 'git');
    s = handleKey(s, { type: 'home' });
    assert.equal(s.cursor, 0);
    s = handleKey(s, { type: 'arrow', dir: 'left' });
    assert.equal(s.cursor, 0);
    s = handleKey(s, { type: 'arrow', dir: 'right' });
    assert.equal(s.cursor, 1);
    s = handleKey(s, { type: 'end' });
    assert.equal(s.cursor, 3);
    s = handleKey(s, { type: 'arrow', dir: 'right' });
    assert.equal(s.cursor, 3);
    s = handleKey(s, { type: 'ctrl', ch: 'a' });
    assert.equal(s.cursor, 0);
    s = handleKey(s, { type: 'ctrl', ch: 'e' });
    assert.equal(s.cursor, 3);
  });
  it('backspace 删光标前字符', () => {
    let s = type(init(), 'abc');
    s = handleKey(handleKey(s, { type: 'backspace' }), { type: 'backspace' });
    assert.equal(s.line, 'a');
    assert.equal(s.cursor, 1);
  });
  it('行空时 backspace 清除 danger/notice', () => {
    let s = { ...init(), danger: { message: 'x', at: 1 }, notice: { text: 'y', at: 1 } };
    s = handleKey(s, { type: 'backspace' });
    assert.equal(s.danger, null);
    assert.equal(s.notice, null);
  });
  it('delete 删光标后字符', () => {
    let s = type(init(), 'abc');
    s = handleKey(s, { type: 'home' });
    s = handleKey(s, { type: 'delete' });
    assert.equal(s.line, 'bc');
  });
  it('ctrl+u 清空输入行并复位历史回溯', () => {
    let s = type(init(), 'git st');
    s = { ...s, historyList: ['git log'], historyIndex: 0, historyDraft: 'xx' };
    s = handleKey(s, { type: 'ctrl', ch: 'u' });
    assert.equal(s.line, '');
    assert.equal(s.cursor, 0);
    assert.equal(s.historyIndex, null);
    assert.equal(s.historyDraft, '');
  });
  it('ctrl+w 删除光标前一个词（跳过多余空格）', () => {
    let s = type(init(), 'git rebase origin');
    s = handleKey(s, { type: 'ctrl', ch: 'w' });
    assert.equal(s.line, 'git rebase ');
    assert.equal(s.cursor, 11);
    s = handleKey(s, { type: 'ctrl', ch: 'w' });
    assert.equal(s.line, 'git ');
    assert.equal(s.cursor, 4);
  });
});

describe('m5-reducer Tab 补全算法', () => {
  it('唯一候选：插入候选文本 + 尾随空格', () => {
    let s = type(init(), 'git reb');
    s = attachView(
      s,
      fakeView({
        candidates: [{ text: 'rebase', kind: 'command', insert: null }],
        active: { text: 'reb', start: 4, end: 7, quoted: false },
      }),
    );
    s = handleKey(s, TAB);
    assert.equal(s.line, 'git rebase ');
    assert.equal(s.cursor, 11);
  });
  it('多候选：补最长公共前缀 LCP（不加尾随空格）', () => {
    let s = type(init(), 'git cherr');
    s = attachView(
      s,
      fakeView({
        candidates: [
          { text: 'cherry', kind: 'command', insert: null },
          { text: 'cherry-pick', kind: 'command', insert: null },
        ],
        active: { text: 'cherr', start: 4, end: 9, quoted: false },
      }),
    );
    s = handleKey(s, TAB);
    assert.equal(s.line, 'git cherry');
    assert.equal(s.cursor, 10);
  });
  it('多候选 LCP 无进展：采纳当前高亮候选（Tab 补全高亮候选）', () => {
    // checkout 与 commit 的 LCP 恰为 'c'，等于活动词 → LCP 无进展
    const cands = [
      { text: 'checkout', kind: 'command', insert: null },
      { text: 'commit', kind: 'command', insert: null },
    ];
    let s = type(init(), 'git c');
    s = attachView(s, fakeView({ candidates: cands, active: { text: 'c', start: 4, end: 5, quoted: false } }));
    s = handleKey(s, TAB);
    assert.equal(s.line, 'git checkout ');
    // 高亮移到第二项后再 Tab：采纳 commit
    s = attachView({ ...s, selected: 1, line: 'git c', cursor: 5 }, fakeView({ candidates: cands, active: { text: 'c', start: 4, end: 5, quoted: false } }));
    s = handleKey(s, TAB);
    assert.equal(s.line, 'git commit ');
  });
  it('带 paramHint 的选项只插入选项名 + 空格，参数位不插入实际字符', () => {
    let s = type(init(), 'git rebase --'); // '--' 位于 [11,13)
    s = attachView(
      s,
      fakeView({
        candidates: [{ text: '--onto', paramHint: '<newbase>', kind: 'option', insert: null }],
        active: { text: '--', start: 11, end: 13, quoted: false },
      }),
    );
    s = handleKey(s, TAB);
    assert.equal(s.line, 'git rebase --onto ');
    assert.ok(!s.line.includes('<newbase>'));
  });
  it('placeholder 候选（insert 为空串）：不改行，解除浮层关闭态', () => {
    let s = type(init(), 'git push ');
    s = attachView(
      s,
      fakeView({
        candidates: [{ text: '<remote>', kind: 'placeholder', insert: '', placeholderKind: 'remote' }],
        active: null,
      }),
    );
    s = handleKey({ ...s, dismissed: true }, TAB);
    assert.equal(s.line, 'git push ');
    assert.equal(s.dismissed, false);
  });
  it('活动词为空：Tab 采纳高亮候选（动态值）', () => {
    let s = type(init(), 'git push ');
    s = attachView(
      s,
      fakeView({
        candidates: [
          { text: 'origin', kind: 'dynamic', insert: null, placeholderKind: 'remote' },
          { text: 'main', kind: 'dynamic', insert: null, placeholderKind: 'branch' },
        ],
        active: null,
      }),
    );
    s = handleKey(s, TAB);
    assert.equal(s.line, 'git push origin ');
    s = handleKey(attachView({ ...s, selected: 1, line: 'git push ', cursor: 9 }, s.view), TAB);
    assert.equal(s.line, 'git push main ');
  });
  it('correction 候选：替换 unknown Token（活动词为 null 时走 corrections 索引）', () => {
    let s = type(init(), 'git chekcout ');
    s = attachView(
      s,
      fakeView({
        candidates: [{ text: 'checkout', kind: 'correction', insert: 'checkout' }],
        active: null,
        tokens: [
          { text: 'git', start: 0, end: 3, quoted: false },
          { text: 'chekcout', start: 4, end: 12, quoted: false },
        ],
        corrections: [{ token: 'chekcout', index: 1, suggestions: ['checkout'] }],
      }),
    );
    s = handleKey(s, TAB);
    assert.equal(s.line, 'git checkout ');
    assert.equal(s.cursor, 13);
  });
  it('correction 候选：有活动词时替换活动词', () => {
    let s = type(init(), 'git chekcou');
    s = attachView(
      s,
      fakeView({
        candidates: [{ text: 'checkout', kind: 'correction', insert: 'checkout' }],
        active: { text: 'chekcou', start: 4, end: 11, quoted: false },
      }),
    );
    s = handleKey(s, TAB);
    assert.equal(s.line, 'git checkout ');
  });
  it('无候选：Tab 无操作', () => {
    let s = type(init(), 'git xyz ');
    s = attachView(s, fakeView({ candidates: [], active: null }));
    const before = s.line;
    s = handleKey(s, TAB);
    assert.equal(s.line, before);
  });
});

describe('m5-reducer Enter 与 mode 流转', () => {
  it('空行 Enter 忽略', () => {
    const s = handleKey(init(), ENTER);
    assert.equal(s.mode, 'input');
  });
  it('Enter → running，runningLine 记录整行且输入行复位为空（执行后 ↑ 可回溯历史）', () => {
    const s = handleKey(type(init(), 'git status'), ENTER);
    assert.equal(s.mode, 'running');
    assert.equal(s.runningLine, 'git status');
    assert.equal(s.line, '');
    assert.equal(s.cursor, 0);
  });
  it("enter_action='complete'：有候选且活动词非空 → 先补全不执行", () => {
    let s = init({ config: { enter_action: 'complete' } });
    s = type(s, 'git reb');
    s = attachView(
      s,
      fakeView({
        candidates: [{ text: 'rebase', kind: 'command', insert: null }],
        active: { text: 'reb', start: 4, end: 7, quoted: false },
      }),
    );
    s = handleKey(s, ENTER);
    assert.equal(s.mode, 'input');
    assert.equal(s.line, 'git rebase ');
  });
  it("enter_action='complete' 但无候选 → 照常执行", () => {
    let s = init({ config: { enter_action: 'complete' } });
    s = type(s, 'git status');
    s = attachView(s, fakeView({ candidates: [] }));
    s = handleKey(s, ENTER);
    assert.equal(s.mode, 'running');
  });
  it('guide 态：printable 先回 input 再插入（防吞键）', () => {
    let s = init({ showGuide: true });
    s = handleKey(s, P('g'));
    assert.equal(s.mode, 'input');
    assert.equal(s.line, 'g');
  });
  it('guide 态：非 printable 任意键仅回到 input', () => {
    let s = init({ showGuide: true });
    s = handleKey(s, ENTER);
    assert.equal(s.mode, 'input');
    assert.equal(s.line, '');
  });
  it('output 态：printable 回输入态并插入字符（防吞键）', () => {
    let s = { ...init(), mode: 'output', line: 'git st', cursor: 6 };
    s = handleKey(s, P('a'));
    assert.equal(s.mode, 'input');
    assert.equal(s.line, 'git sta');
  });
  it('running 态：除 Ctrl+C 外按键忽略', () => {
    let s = handleKey(type(init(), 'git push'), ENTER);
    s = handleKey(s, P('x'));
    assert.equal(s.mode, 'running');
    const s2 = handleKey(s, TAB);
    assert.equal(s2.mode, 'running');
  });
  it('running 态 Ctrl+C → 回 input（exec.cancel 由 controller 负责），行为空', () => {
    let s = handleKey(type(init(), 'git push'), ENTER);
    s = handleKey(s, { type: 'ctrl', ch: 'c' });
    assert.equal(s.mode, 'input');
    assert.equal(s.line, '');
  });
});

describe('m5-reducer 候选移动 / 翻页 / 详情', () => {
  const cands = Array.from({ length: 5 }, (_, i) => ({ text: `opt${i}`, kind: 'option', insert: null }));

  it('↑↓ 移动高亮并跨页自动翻页', () => {
    let s = attachView(init({ config: { candidate_limit: 2 } }), fakeView({ candidates: cands }));
    assert.equal(s.selected, 0);
    assert.equal(s.page, 0);
    s = handleKey(s, { type: 'arrow', dir: 'down' });
    assert.equal(s.selected, 1);
    s = handleKey(s, { type: 'arrow', dir: 'down' });
    assert.equal(s.selected, 2);
    assert.equal(s.page, 1); // 跨页自动翻页
    s = handleKey(s, { type: 'arrow', dir: 'up' });
    assert.equal(s.selected, 1);
    assert.equal(s.page, 0);
    s = handleKey(s, { type: 'arrow', dir: 'up' });
    assert.equal(s.selected, 0); // 顶部钳制
  });
  it('PgUp/PgDn 翻页并把高亮带入新页', () => {
    let s = attachView(init({ config: { candidate_limit: 2 } }), fakeView({ candidates: cands }));
    s = handleKey(s, { type: 'page', dir: 'down' });
    assert.equal(s.page, 1);
    assert.equal(s.selected, 2);
    s = handleKey(s, { type: 'page', dir: 'down' });
    assert.equal(s.page, 2);
    assert.equal(s.selected, 4);
    s = handleKey(s, { type: 'page', dir: 'down' });
    assert.equal(s.page, 2); // 末页钳制
    s = handleKey(s, { type: 'page', dir: 'up' });
    assert.equal(s.page, 1);
    assert.equal(s.selected, 2);
  });
  it('F1 / Ctrl+? 切换详情展开', () => {
    let s = init();
    s = handleKey(s, { type: 'function', n: 1 });
    assert.equal(s.detailOpen, true);
    s = handleKey(s, { type: 'function', n: 1 });
    assert.equal(s.detailOpen, false);
    s = handleKey(s, { type: 'ctrl', ch: '?' });
    assert.equal(s.detailOpen, true);
  });
});

describe('m5-reducer 历史回溯（历史浏览规则）', () => {
  it('空行无候选：↑ 进入回溯、连续 ↑ 变旧、↓ 变新、末尾恢复草稿', () => {
    let s = { ...init(), historyList: ['git status', 'git log', 'git diff'] };
    s = handleKey(s, { type: 'arrow', dir: 'up' });
    assert.equal(s.line, 'git status');
    assert.equal(s.historyIndex, 0);
    s = handleKey(s, { type: 'arrow', dir: 'up' });
    assert.equal(s.line, 'git log');
    assert.equal(s.historyIndex, 1);
    s = handleKey(s, { type: 'arrow', dir: 'up' });
    assert.equal(s.line, 'git diff');
    s = handleKey(s, { type: 'arrow', dir: 'up' });
    assert.equal(s.historyIndex, 2); // 最旧一条钳制
    s = handleKey(s, { type: 'arrow', dir: 'down' });
    assert.equal(s.line, 'git log');
    s = handleKey(s, { type: 'arrow', dir: 'down' });
    assert.equal(s.line, 'git status');
    s = handleKey(s, { type: 'arrow', dir: 'down' });
    assert.equal(s.historyIndex, null);
    assert.equal(s.line, '');
  });
  it('回溯中编辑行内容：退出回溯态，↓ 不再回溯（行保持已编辑内容）', () => {
    let s = { ...init(), historyList: ['git status'] };
    s = handleKey(s, { type: 'arrow', dir: 'up' });
    assert.equal(s.line, 'git status');
    assert.equal(s.historyDraft, '');
    s = handleKey(s, P('X')); // 回溯中编辑 → 退出回溯态
    assert.equal(s.line, 'git statusX');
    assert.equal(s.historyIndex, null);
    assert.equal(s.historyDraft, '');
    s = handleKey(s, { type: 'arrow', dir: 'down' }); // 已不在回溯态：无操作
    assert.equal(s.line, 'git statusX');
  });
  it('回溯后编辑行产生候选：↑↓ 移动候选高亮而非历史浏览（修复回溯劫持）', () => {
    let s = { ...init(), historyList: ['git status'] };
    s = handleKey(s, { type: 'arrow', dir: 'up' }); // 空行 ↑ 进入回溯
    assert.equal(s.line, 'git status');
    s = type(s, ' --s'); // 编辑 → 退出回溯态
    s = attachView(s, fakeView({
      candidates: [
        { text: '--short', kind: 'option', insert: null },
        { text: '--stage', kind: 'option', insert: null },
      ],
      active: { text: '--s', start: 10, end: 13, quoted: false },
    }));
    s = handleKey(s, { type: 'arrow', dir: 'down' });
    assert.equal(s.selected, 1, '↓ 选择下一条候选');
    assert.equal(s.line, 'git status --s', '行内容不被历史改写');
    s = handleKey(s, { type: 'arrow', dir: 'up' });
    assert.equal(s.selected, 0, '↑ 移回上一条候选');
    assert.equal(s.line, 'git status --s');
  });
  it('回溯态连续 ↑ 仍浏览历史（未被编辑打断时回溯语义保持）', () => {
    let s = { ...init(), historyList: ['git status', 'git log'] };
    s = handleKey(s, { type: 'arrow', dir: 'up' });
    assert.equal(s.line, 'git status');
    assert.equal(s.historyIndex, 0);
    s = handleKey(s, { type: 'arrow', dir: 'up' }); // 回溯出的行有候选也不切换高亮
    assert.equal(s.line, 'git log');
    assert.equal(s.historyIndex, 1);
    s = handleKey(s, { type: 'arrow', dir: 'left' }); // 纯光标移动不算编辑，回溯保持
    s = handleKey(s, { type: 'arrow', dir: 'up' });
    assert.equal(s.historyIndex, 1, '已到最旧一条，钳制');
  });
  it('非空行且无候选：↑ 不进入回溯（回溯仅空行触发）', () => {
    let s = type(init(), 'abc');
    s = { ...s, historyList: ['git status'] };
    s = handleKey(s, { type: 'arrow', dir: 'up' });
    assert.equal(s.line, 'abc');
    assert.equal(s.historyIndex, null);
  });
  it('有候选且行非空：↑↓ 移动候选高亮，不进历史', () => {
    let s = type(init(), 'git reb');
    s = attachView(
      s,
      fakeView({
        candidates: [
          { text: 'rebase', kind: 'command', insert: null },
          { text: 'remote', kind: 'command', insert: null },
        ],
        active: { text: 'reb', start: 4, end: 7, quoted: false },
      }),
    );
    s = handleKey(s, { type: 'arrow', dir: 'down' });
    assert.equal(s.selected, 1);
    assert.equal(s.line, 'git reb');
    assert.equal(s.historyIndex, null);
  });
  it('空行且 dismissed：↑ 进入回溯', () => {
    let s = { ...init(), historyList: ['git log'], dismissed: true, line: '' };
    s = handleKey(s, { type: 'arrow', dir: 'up' });
    assert.equal(s.line, 'git log');
  });
  it('历史为空：↑ 无操作', () => {
    const s = handleKey(init(), { type: 'arrow', dir: 'up' });
    assert.equal(s.line, '');
    assert.equal(s.historyIndex, null);
  });
});

describe('m5-reducer Esc 与退出', () => {
  it('Esc 第一次关闭候选浮层，第二次清空输入行并复位', () => {
    let s = type(init(), 'git reb');
    s = attachView(
      s,
      fakeView({
        candidates: [{ text: 'rebase', kind: 'command', insert: null }],
        active: { text: 'reb', start: 4, end: 7, quoted: false },
      }),
    );
    s = handleKey({ ...s, selected: 1, detailOpen: true }, ESC);
    assert.equal(s.dismissed, true);
    assert.equal(s.line, 'git reb'); // 行保留
    s = handleKey(s, ESC);
    assert.equal(s.line, '');
    assert.equal(s.cursor, 0);
    assert.equal(s.dismissed, false);
    assert.equal(s.detailOpen, false);
    assert.equal(s.selected, 0);
  });
  it('Ctrl+C 第一次清空输入，第二次退出；中间按其它键清零计数', () => {
    let s = type(init(), 'git st');
    s = handleKey(s, { type: 'ctrl', ch: 'c' });
    assert.equal(s.ctrlcCount, 1);
    assert.equal(s.line, '');
    assert.equal(s.mode, 'input');
    s = handleKey(s, P('x')); // 任意非 ctrl-c 键清零
    assert.equal(s.ctrlcCount, 0);
    s = handleKey(s, { type: 'ctrl', ch: 'c' });
    s = handleKey(s, { type: 'ctrl', ch: 'c' });
    assert.equal(s.mode, 'exited');
  });
  it('Ctrl+Q 直接退出', () => {
    const s = handleKey(init(), { type: 'ctrl', ch: 'q' });
    assert.equal(s.mode, 'exited');
  });
  it('exited 态任何键无操作', () => {
    const s = handleKey({ ...init(), mode: 'exited' }, P('a'));
    assert.equal(s.mode, 'exited');
    assert.equal(s.line, '');
  });
});

describe('m5-reducer 纯度与 attachView', () => {
  it('handleKey 不修改入参（结构共享）', () => {
    const s = type(init(), 'git st');
    const frozen = JSON.parse(JSON.stringify(s));
    const n = handleKey(s, P('a'));
    assert.deepEqual(JSON.parse(JSON.stringify(s)), frozen);
    assert.equal(n.line, 'git sta');
    assert.notEqual(n, s);
  });
  it('attachView 挂载视图并钳制 selected/page', () => {
    let s = { ...init({ config: { candidate_limit: 3 } }), selected: 9, page: 4 };
    s = attachView(
      s,
      fakeView({
        candidates: [1, 2, 3, 4, 5].map((i) => ({ text: `o${i}`, kind: 'option', insert: null })),
      }),
    );
    assert.equal(s.selected, 4);
    assert.equal(s.page, 1); // floor(4/3)
    s = attachView(s, fakeView({ candidates: [] }));
    assert.equal(s.selected, 0);
    assert.equal(s.page, 0);
    assert.equal(s.view.candidates.length, 0);
  });
  it('未知键类型忽略且不抛错', () => {
    const s = init();
    assert.equal(handleKey(s, { type: 'weird' }), s);
  });
});
