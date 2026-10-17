/**
 * 单次模式输出渲染单元测试。
 * 覆盖：稳定行前缀（语法/匹配/位置/候选/提示）、匹配行标记（✓ ▶ ⚠ ·）、
 * 候选对齐（CJK 记 2 列）、纠错提示、--strict 判定 onceHasUnknown、字节稳定性。
 *
 * 说明：renderOnceText 的输入是建议管线输出的 SuggestResult 结构，
 * 此处以手工构造的 fake view 驱动，不依赖知识库与建议模块是否就绪。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { renderOnceText, onceHasUnknown } from '../bin/gitcue.mjs';

/** 构造 fake SuggestResult（renderOnceText 的输入结构） */
function fakeView(over = {}) {
  return {
    isGit: true,
    covered: true,
    phase: 'options',
    tokens: [
      { text: 'git', start: 0, end: 3, quoted: false },
      { text: 'log', start: 4, end: 7, quoted: false },
    ],
    active: { text: '--on', start: 8, end: 12, quoted: false },
    marks: [],
    commandName: 'log',
    skeleton: { text: 'git log [--oneline] [<pathspec>...]', marks: [], cursor: 9 },
    positionLabel: '选项名（--on*）',
    candidates: [
      {
        text: '--oneline',
        paramHint: null,
        summary: '一行一提交：短 SHA 与提交标题',
        kind: 'option',
        patternId: 'log:opt:--oneline',
        placeholderKind: null,
        popularity: 4,
        usage: 0,
        since: null,
        insert: null,
      },
    ],
    corrections: [],
    debug: { timingsMs: { lex: 0, match: 0, skeleton: 0, candidates: 0 } },
    ...over,
  };
}

/** fake KbDb：仅提供 get() 返回 syntaxFull（KbEntry 字段） */
function fakeKb(syntaxFull) {
  return { get: () => ({ syntaxFull }), names: () => ['log'] };
}

describe('renderOnceText 行前缀与基本结构（plain）', () => {
  test('五组行前缀固定：语法/匹配/位置/候选(N)/提示', () => {
    const text = renderOnceText(fakeView(), { lang: 'zh-CN', plain: true, kb: fakeKb('git log [-n <num>] [--oneline]') });
    const lines = text.split('\n');
    assert.ok(lines[0].startsWith('语法: '), lines[0]);
    assert.ok(lines[1].startsWith('匹配: '), lines[1]);
    assert.ok(lines[2].startsWith('位置: '), lines[2]);
    assert.ok(lines[3].startsWith('候选(1):'), lines[3]);
    assert.ok(lines[lines.length - 2].startsWith('提示: '), lines[lines.length - 2]);
    assert.ok(text.endsWith('\n'), '输出应以换行结尾');
  });

  test('完整骨架优先取自 kb 条目 syntaxFull', () => {
    const text = renderOnceText(fakeView(), {
      lang: 'zh-CN',
      plain: true,
      kb: fakeKb('git log [-n <num>] [--oneline] [--graph] [<pathspec>...]'),
    });
    assert.ok(
      text.startsWith('语法: git log [-n <num>] [--oneline] [--graph] [<pathspec>...]\n'),
      text,
    );
  });

  test('kb 缺条目时回退紧凑骨架；无 kb 亦回退', () => {
    const v = fakeView();
    const t1 = renderOnceText(v, { lang: 'zh-CN', plain: true, kb: { get: () => undefined } });
    assert.ok(t1.startsWith('语法: git log [--oneline] [<pathspec>...]'));
    const t2 = renderOnceText(v, { lang: 'zh-CN', plain: true, kb: null });
    assert.ok(t2.startsWith('语法: git log [--oneline] [<pathspec>...]'));
  });

  test('匹配行：✓ 标记已完成 Token，▶ 标记活动词，条目间两空格', () => {
    const text = renderOnceText(fakeView(), { lang: 'zh-CN', plain: true, kb: fakeKb('x') });
    const matchLine = text.split('\n')[1];
    assert.equal(matchLine, '匹配: git ✓  log ✓  --on ▶');
  });

  test('匹配行：未识别 Token 标 ⚠', () => {
    const v = fakeView({
      tokens: [
        { text: 'git', start: 0, end: 3, quoted: false },
        { text: 'log', start: 4, end: 7, quoted: false },
        { text: '--bogus', start: 8, end: 15, quoted: false },
      ],
      marks: [{ patternId: null, role: 'unknown', warning: null }],
      active: null,
      phase: 'unknown',
      candidates: [],
      positionLabel: '命令末尾',
    });
    const matchLine = renderOnceText(v, { lang: 'zh-CN', plain: true, kb: fakeKb('x') }).split('\n')[1];
    assert.equal(matchLine, '匹配: git ✓  log ✓  --bogus ⚠');
  });

  test('匹配行：未收录子命令标 ·（非错误）', () => {
    const v = fakeView({
      covered: false,
      phase: 'uncovered',
      tokens: [
        { text: 'git', start: 0, end: 3, quoted: false },
        { text: 'mytool', start: 4, end: 10, quoted: false },
      ],
      active: null,
      commandName: null,
      candidates: [],
      positionLabel: '命令末尾',
    });
    const text = renderOnceText(v, { lang: 'zh-CN', plain: true, kb: null });
    assert.ok(text.split('\n')[1].includes('mytool ·'));
  });

  test('匹配行：非 git 命令全部标 ·，语法行为透传文案', () => {
    const v = fakeView({
      isGit: false,
      covered: false,
      phase: 'passthrough',
      tokens: [
        { text: 'ls', start: 0, end: 2, quoted: false },
        { text: '-la', start: 3, end: 6, quoted: false },
      ],
      active: null,
      commandName: null,
      candidates: [],
      positionLabel: '',
      skeleton: { text: '', marks: [], cursor: null },
    });
    const text = renderOnceText(v, { lang: 'zh-CN', plain: true, kb: null });
    const lines = text.split('\n');
    assert.ok(lines[0].includes('非 git 命令'), lines[0]);
    assert.equal(lines[1], '匹配: ls ·  -la ·');
  });

  test('空输入：语法行显示（空输入）', () => {
    const v = fakeView({
      isGit: false,
      covered: false,
      phase: 'empty',
      tokens: [],
      active: null,
      commandName: null,
      candidates: [],
      positionLabel: '',
      skeleton: { text: '', marks: [], cursor: null },
    });
    const text = renderOnceText(v, { lang: 'zh-CN', plain: true, kb: null });
    assert.ok(text.startsWith('语法: （空输入）'));
    assert.ok(text.includes('候选(0):'));
    assert.ok(text.includes('提示: （无）'));
  });

  test('位置行为空时以 — 兜底', () => {
    const v = fakeView({ positionLabel: '' });
    const text = renderOnceText(v, { lang: 'zh-CN', plain: true, kb: fakeKb('x') });
    assert.ok(text.split('\n')[2].startsWith('位置: —'));
  });
});

describe('renderOnceText 候选区', () => {
  test('候选行：文本 + 一行说明；含 paramHint 时拼接 <name>；同批说明列对齐', () => {
    const v = fakeView({
      active: null,
      candidates: [
        { text: '--onto', paramHint: '<newbase>', summary: '把提交重放到指定新基点上', kind: 'option', popularity: 3, usage: 0, since: null, insert: null, patternId: 'rebase:opt:--onto', placeholderKind: null },
        { text: '--keep-base', paramHint: null, summary: '以当前分支与上游共同祖先为基点', kind: 'option', popularity: 2, usage: 0, since: null, insert: null, patternId: 'rebase:opt:--keep-base', placeholderKind: null },
      ],
    });
    const text = renderOnceText(v, { lang: 'zh-CN', plain: true, kb: fakeKb('x') });
    const lines = text.split('\n');
    assert.ok(lines[3].startsWith('候选(2):'), lines[3]);
    const onto = lines.find((l) => l.trim().startsWith('--onto'));
    assert.ok(onto, '应有 --onto 候选行');
    assert.ok(onto.includes('--onto <newbase>'), onto);
    assert.ok(onto.includes('把提交重放到指定新基点上'), onto);
    // 对齐：列宽 = min(最长显示文本 16, 24) + 2 = 18，说明列 = 2 + 18 = 20
    assert.equal(onto.indexOf('把提交重放到'), 20, onto);
    const keep = lines.find((l) => l.trim().startsWith('--keep-base'));
    assert.equal(keep.indexOf('以当前分支'), 20, keep);
  });

  test('paramHint 为裸名时自动补尖括号（兼容两种形态）', () => {
    const v = fakeView({
      active: null,
      candidates: [
        { text: '--onto', paramHint: 'newbase', summary: 'x', kind: 'option', popularity: 3, usage: 0, since: null, insert: null, patternId: null, placeholderKind: null },
      ],
    });
    const text = renderOnceText(v, { lang: 'zh-CN', plain: true, kb: fakeKb('x') });
    assert.ok(text.includes('--onto <newbase>'));
  });

  test('说明为空时显示（暂无说明）兜底', () => {
    const v = fakeView({
      active: null,
      candidates: [
        { text: '-x', paramHint: null, summary: '', kind: 'option', popularity: 1, usage: 0, since: null, insert: null, patternId: null, placeholderKind: null },
      ],
    });
    const text = renderOnceText(v, { lang: 'zh-CN', plain: true, kb: fakeKb('x') });
    assert.ok(text.includes('-x') && text.includes('（暂无说明）'));
  });

  test('CJK 宽度按 2 列计算（“分支”与“abcd”同为 4 列 → 说明列一致）', () => {
    const v = fakeView({
      active: null,
      candidates: [
        { text: '分支', paramHint: null, summary: 's1', kind: 'dynamic', popularity: 3, usage: 0, since: null, insert: null, patternId: null, placeholderKind: null },
        { text: 'abcd', paramHint: null, summary: 's2', kind: 'dynamic', popularity: 3, usage: 0, since: null, insert: null, patternId: null, placeholderKind: null },
      ],
    });
    const lines = renderOnceText(v, { lang: 'zh-CN', plain: true, kb: fakeKb('x') }).split('\n');
    // 列宽 = min(4, 24) + 2 = 6；两行说明都从显示列 8 开始（CJK 记 2 列，而非码点数）
    const cjk = lines.find((l) => l.includes('分支'));
    const ascii = lines.find((l) => l.includes('abcd'));
    assert.equal(cjk, '  分支  s1', JSON.stringify(cjk));
    assert.equal(ascii, '  abcd  s2', JSON.stringify(ascii));
  });

  test('候选说明列上限 24+2 列；超长文本溢出但仍保留 2 空格间隔', () => {
    const long = '-'.repeat(40);
    const v = fakeView({
      active: null,
      candidates: [
        { text: long, paramHint: null, summary: '说明', kind: 'option', popularity: 1, usage: 0, since: null, insert: null, patternId: null, placeholderKind: null },
        { text: '--short', paramHint: null, summary: '说明2', kind: 'option', popularity: 1, usage: 0, since: null, insert: null, patternId: null, placeholderKind: null },
      ],
    });
    const lines = renderOnceText(v, { lang: 'zh-CN', plain: true, kb: fakeKb('x') }).split('\n');
    const longLine = lines.find((l) => l.includes(long));
    const shortLine = lines.find((l) => l.includes('--short'));
    // 短文本对齐到 2 + 24 + 2 = 28 列；超长文本溢出，说明跟在 2 空格之后（2+40+2 = 44）
    assert.equal(shortLine.indexOf('说明2'), 28, JSON.stringify(shortLine));
    assert.equal(longLine.indexOf('说明'), 2 + 40 + 2, JSON.stringify(longLine));
  });
});

describe('renderOnceText 提示行（纠错）与 i18n', () => {
  test('存在纠错：提示行含 ⚠ 未识别 与 Did you mean', () => {
    const v = fakeView({
      tokens: [
        { text: 'git', start: 0, end: 3, quoted: false },
        { text: 'chekcout', start: 4, end: 12, quoted: false },
      ],
      active: null,
      phase: 'unknown',
      candidates: [],
      corrections: [{ token: 'chekcout', index: 1, suggestions: ['checkout', 'checkou'] }],
      positionLabel: '命令末尾',
    });
    const text = renderOnceText(v, { lang: 'zh-CN', plain: true, kb: null });
    const hintLines = text.split('\n').filter((l) => l.startsWith('提示: '));
    assert.equal(hintLines.length, 1);
    assert.ok(hintLines[0].includes('⚠ 未识别: chekcout'), hintLines[0]);
    assert.ok(hintLines[0].includes('Did you mean: checkout, checkou?'), hintLines[0]);
  });

  test('纠错无建议时只显示 ⚠，不显示 Did you mean', () => {
    const v = fakeView({ corrections: [{ token: 'zzz', index: 2, suggestions: [] }] });
    const text = renderOnceText(v, { lang: 'zh-CN', plain: true, kb: fakeKb('x') });
    assert.ok(text.includes('⚠ 未识别: zzz'));
    assert.ok(!text.includes('Did you mean'));
  });

  test('多条纠错各占一行（行前缀仍固定）', () => {
    const v = fakeView({
      corrections: [
        { token: 'aa', index: 2, suggestions: ['ab'] },
        { token: 'bb', index: 3, suggestions: [] },
      ],
    });
    const text = renderOnceText(v, { lang: 'zh-CN', plain: true, kb: fakeKb('x') });
    const hintLines = text.split('\n').filter((l) => l.startsWith('提示: '));
    assert.equal(hintLines.length, 2);
  });

  test('en-US：行前缀切换为英文', () => {
    const text = renderOnceText(fakeView(), { lang: 'en-US', plain: true, kb: fakeKb('git log [...]') });
    const lines = text.split('\n');
    assert.ok(lines[0].startsWith('Syntax: '));
    assert.ok(lines[1].startsWith('Match: '));
    assert.ok(lines[2].startsWith('Position: '));
    assert.ok(lines[3].startsWith('Candidates(1):'));
    assert.ok(text.includes('Hint: (none)'));
  });

  test('同输入两次渲染逐字节一致（输出稳定性）', () => {
    const v = fakeView();
    const a = renderOnceText(v, { lang: 'zh-CN', plain: true, kb: fakeKb('git log [...]') });
    const b = renderOnceText(v, { lang: 'zh-CN', plain: true, kb: fakeKb('git log [...]') });
    assert.equal(a, b);
  });

  test('plain=false 时包含 ANSI 转义且行前缀不受影响', () => {
    const text = renderOnceText(fakeView(), { lang: 'zh-CN', plain: false, kb: fakeKb('git log [...]') });
    assert.ok(text.includes('\x1b['), '应包含 ANSI 转义');
    assert.ok(text.split('\n')[0].startsWith('语法: '));
    assert.ok(text.split('\n')[1].includes('✓') && text.split('\n')[1].includes('▶'));
  });
});

describe('onceHasUnknown（--strict 判定）', () => {
  test('phase=unknown → true', () => {
    assert.equal(onceHasUnknown(fakeView({ phase: 'unknown' })), true);
  });

  test('phase=options/uncovered/passthrough/empty → false', () => {
    for (const phase of ['options', 'uncovered', 'passthrough', 'empty', 'command']) {
      assert.equal(onceHasUnknown(fakeView({ phase })), false, phase);
    }
  });

  test('纠错指向已完成 Token → true（未收录子命令被建议纠错的情形）', () => {
    const v = fakeView({
      phase: 'uncovered',
      tokens: [
        { text: 'git', start: 0, end: 3, quoted: false },
        { text: 'chekcout', start: 4, end: 12, quoted: false },
      ],
      corrections: [{ token: 'chekcout', index: 1, suggestions: ['checkout'] }],
    });
    assert.equal(onceHasUnknown(v), true);
  });

  test('纠错只针对活动词（软提示）→ false', () => {
    const v = fakeView({
      phase: 'options',
      corrections: [{ token: '--zz', index: -1, suggestions: ['--oneline'] }],
    });
    assert.equal(onceHasUnknown(v), false, '活动词软提示不构成 strict 失败');
  });

  test('空视图安全', () => {
    assert.equal(onceHasUnknown(null), false);
  });
});
