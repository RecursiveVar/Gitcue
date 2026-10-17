// test/m3-suggest.test.mjs —— 建议管线单元测试
// 覆盖（fake providers/usage 注入）：排序三分量（频率>常用度>字典序）；前缀过滤；since 后缀；
// 互斥与已用剔除；纠错（≤2 距离、上限 3、软提示）；组合短选项；enum 与 `=` 合成；
// phase/positionLabel；未收录/空态/透传。
// 本模块纯逻辑测试不涉及用户级数据；仍防御性地将 GITCUE_HOME 指向本模块沙箱。

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSuggest } from '../src/parser/suggest.mjs';
import {
  ensureSandbox,
  makeCommonKb,
  makeKb,
  makeEntry,
  fakeUsage,
  fakeProviders,
  ready,
  REBASE_GRAMMAR,
} from './m3-fixtures.mjs';

before(() => {
  process.env.GITCUE_HOME = ensureSandbox();
});

const KB = makeCommonKb();
const ANCHOR = 'git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]';
const textsOf = (r) => r.candidates.map((c) => c.text);
const find = (r, text) => r.candidates.find((c) => c.text === text);

describe('命令路由与 phase', () => {
  test('空行 → empty；非 git → passthrough', () => {
    const s = createSuggest({ kb: KB }).suggest('');
    assert.equal(s.phase, 'empty');
    assert.equal(s.isGit, false);
    assert.deepEqual(s.candidates, []);
    const p = createSuggest({ kb: KB }).suggest('ls -la ');
    assert.equal(p.phase, 'passthrough');
    assert.equal(p.isGit, false);
  });

  test('只有 `git `（无子命令）→ command + 引导文案', () => {
    const r = createSuggest({ kb: KB }).suggest('git ');
    assert.equal(r.phase, 'command');
    assert.equal(r.isGit, true);
    assert.equal(r.covered, false);
    assert.equal(r.skeleton.text, '输入子命令，↓ 浏览全部');
    assert.ok(textsOf(r).includes('rebase'));
    assert.ok(textsOf(r).includes('checkout'));
  });

  test('`git`（无空格）→ git 仍是活动词 → passthrough（严格 R1：未成为已完成 Token）', () => {
    const r = createSuggest({ kb: KB }).suggest('git');
    assert.equal(r.phase, 'passthrough');
    assert.equal(r.active.text, 'git');
  });

  test('子命令为活动词 → command 阶段 + 前缀过滤 + 位置标注', () => {
    const r = createSuggest({ kb: KB }).suggest('git reb');
    assert.equal(r.phase, 'command');
    assert.deepEqual(textsOf(r), ['rebase']);
    assert.equal(r.positionLabel, '子命令名（reb*）');
  });

  test('git 后紧跟全局选项（暂不建模）→ 视作子命令未给出', () => {
    const r = createSuggest({ kb: KB }).suggest('git -C foo ');
    assert.equal(r.phase, 'command');
    assert.deepEqual(r.marks, []);
  });

  test('未收录命令 → uncovered + 未收录骨架', () => {
    const r = createSuggest({ kb: KB }).suggest('git mytool ');
    assert.equal(r.phase, 'uncovered');
    assert.equal(r.covered, false);
    assert.equal(r.skeleton.text, 'git <command> [args...]（未收录，直接执行）');
    assert.deepEqual(r.corrections, []);
    assert.deepEqual(r.candidates, []);
    assert.equal(r.commandName, 'mytool');
    // marks 与 tokens.slice(2) 对齐：后续 Token 一律 unknown（自由 Token，不阻塞）
    const r2 = createSuggest({ kb: KB }).suggest('git mytool a b ');
    assert.equal(r2.marks.length, 2);
    assert.ok(r2.marks.every((m) => m.role === 'unknown'));
  });

  test('covered 标志与 tokens/marks 对齐', () => {
    const r = createSuggest({ kb: KB }).suggest('git rebase -i origin/ma');
    assert.equal(r.covered, true);
    assert.equal(r.commandName, 'rebase');
    assert.deepEqual(r.tokens.map((t) => t.text), ['git', 'rebase', '-i']);
    assert.equal(r.active.text, 'origin/ma');
    assert.equal(r.marks.length, 1); // 与 tokens.slice(2) 对齐
    assert.equal(r.marks[0].role, 'option');
  });
});

describe('候选排序三分量', () => {
  test('默认（无频率）：常用度降序 > 字典序升序', () => {
    const r = createSuggest({ kb: KB }).suggest('git c');
    // checkout(5)/commit(5) 并列按字典序，然后 cherry(3)/cherry-pick(3)/clone(3)/config(3)
    assert.deepEqual(textsOf(r), ['checkout', 'commit', 'cherry', 'cherry-pick', 'clone', 'config']);
  });

  test('使用频率优先于常用度', () => {
    const r = createSuggest({ kb: KB, usage: fakeUsage(new Map([['cmd:clone', 50]])) }).suggest('git c');
    assert.equal(r.candidates[0].text, 'clone');
    assert.equal(r.candidates[0].usage, 50);
  });

  test('选项级频率加权（opt:<patternId>）', () => {
    const withUsage = createSuggest({
      kb: KB,
      usage: fakeUsage(new Map([['opt:rebase:opt:--keep-base', 7]])),
    });
    const r = withUsage.suggest('git rebase -');
    assert.equal(r.candidates[0].text, '--keep-base'); // 频率 7 压过 -i 的常用度 5
    const without = createSuggest({ kb: KB }).suggest('git rebase -');
    // 无频率时常用度优先：--continue 与 -i 并列 5，字典序 '--continue' < '-i'；
    // -i（5）排在 --onto（3）之前
    assert.equal(without.candidates[0].text, '--continue');
    assert.ok(textsOf(without).indexOf('-i') < textsOf(without).indexOf('--onto'));
  });

  test('去重：同文本保留排序靠前者', () => {
    const r = createSuggest({ kb: KB }).suggest('git rebase -');
    const set = new Set(textsOf(r));
    assert.equal(set.size, r.candidates.length);
  });
});

describe('前缀过滤与候选生成', () => {
  test('前缀过滤大小写敏感', () => {
    const r = createSuggest({ kb: KB }).suggest('git rebase --keep');
    assert.deepEqual(textsOf(r), ['--keep-base']);
  });

  test('验收 3 逻辑版：`--` 后列出选项且带中文说明', () => {
    const r = createSuggest({ kb: KB }).suggest('git rebase --');
    assert.equal(r.phase, 'options');
    const kb3 = find(r, '--keep-base');
    assert.equal(kb3.summary, '以当前分支与上游共同祖先为基点');
    for (const c of r.candidates.filter((x) => x.kind === 'option')) {
      assert.ok(c.summary.length > 0, `选项 ${c.text} 缺少说明`);
      assert.ok(!c.paramHint || c.paramHint.startsWith('<'));
    }
    // 活动词为选项形态 → 隐式否定形式也进入候选
    assert.ok(textsOf(r).includes('--no-fork-point'));
    // 非 `--` 开头的形式被过滤（-i、<upstream> 等）
    assert.ok(!textsOf(r).includes('-i'));
    assert.ok(!textsOf(r).includes('<upstream>'));
  });

  test('非选项形态活动词 → 隐式否定形式不进候选（避免噪音）', () => {
    const r = createSuggest({ kb: KB }).suggest('git rebase ');
    assert.ok(!textsOf(r).includes('--no-fork-point'));
    assert.ok(textsOf(r).includes('--fork-point'));
  });

  test('验收 4 逻辑版：互斥/alias 联动剔除', () => {
    const a = createSuggest({ kb: KB }).suggest('git rebase -i ');
    assert.ok(!textsOf(a).includes('-i'));
    assert.ok(!textsOf(a).includes('--interactive'));
    const b = createSuggest({ kb: KB }).suggest('git rebase --interactive ');
    assert.ok(!textsOf(b).includes('-i'));
    assert.ok(!textsOf(b).includes('--interactive'));
  });

  test('验收 2 逻辑版：push 的远程→分支动态候选', () => {
    const providers = fakeProviders({
      remote: ready('remote', ['origin']),
      branch: ready('branch', ['main', 'dev'], (v) => (v === 'main' ? 5 : 3)),
    });
    const s = createSuggest({ kb: KB, providers });
    const r1 = s.suggest('git push ');
    const origin = find(r1, 'origin');
    assert.equal(origin.kind, 'dynamic');
    assert.equal(origin.placeholderKind, 'remote');
    assert.ok(find(r1, '<remote>')); // 占位符候选并存
    const r2 = s.suggest('git push origin ');
    assert.ok(find(r2, 'main'));
    assert.ok(find(r2, 'dev'));
    assert.equal(find(r2, 'main').kind, 'dynamic');
    assert.equal(find(r2, 'main').placeholderKind, 'branch');
    // 动态候选参与排序：main（常用度 5）在 dev 前
    assert.ok(textsOf(r2).indexOf('main') < textsOf(r2).indexOf('dev'));
  });

  test('providers=null（单次模式降级）：仅占位符，无动态候选', () => {
    const r = createSuggest({ kb: KB }).suggest('git push ');
    assert.ok(find(r, '<remote>'));
    assert.equal(r.candidates.some((c) => c.kind === 'dynamic'), false);
  });

  test('providers 未就绪（loading/disabled）→ 仅占位符', () => {
    const providers = fakeProviders({
      remote: { status: 'loading', items: [], updatedAt: null, error: null },
    });
    const r = createSuggest({ kb: KB, providers }).suggest('git push ');
    assert.ok(find(r, '<remote>'));
    assert.equal(r.candidates.some((c) => c.kind === 'dynamic'), false);
  });

  test('骨架锚点 + 光标位 + 标注示范（逻辑版）', () => {
    const providers = fakeProviders({
      commit: ready('commit', ['HEAD', 'origin/main', 'main'], (v) => (v === 'HEAD' ? 5 : 3)),
    });
    const s = createSuggest({ kb: KB, providers });
    const r0 = s.suggest('git rebase ');
    assert.equal(r0.skeleton.text, ANCHOR);
    assert.equal(r0.skeleton.cursor, ANCHOR.indexOf('[<upstream>]'));
    const r1 = s.suggest('git rebase -i origin/ma');
    assert.equal(r1.skeleton.text, ANCHOR);
    const mi = r1.skeleton.marks.find((m) => m.patternId === 'rebase:opt:-i');
    assert.equal(mi.state, 'consumed');
    const main = find(r1, 'origin/main');
    assert.equal(main.kind, 'dynamic');
    assert.equal(r1.candidates[0].text, 'origin/main'); // 前缀命中置顶
    // 契约示例：cursor=24（越界钳制到行尾）行为一致
    const r2 = s.suggest('git rebase -i origin/ma', 24);
    assert.equal(r2.active.text, 'origin/ma');
    assert.equal(r2.candidates[0].text, 'origin/main');
    assert.equal(r2.positionLabel, '<upstream>（第 1 个位置参数）');
  });

  test('占位符候选的 insert=""（展开动态候选）与参数位提示', () => {
    const r = createSuggest({ kb: KB }).suggest('git rebase ');
    const onto = find(r, '--onto');
    assert.equal(onto.paramHint, '<newbase>');
    assert.equal(onto.insert, null);
    const ph = find(r, '<upstream>');
    assert.equal(ph.kind, 'placeholder');
    assert.equal(ph.insert, '');
    assert.equal(ph.placeholderKind, 'commit');
  });
});

describe('enum 参数与 `=` 合成', () => {
  test('枚举参数待填 → 枚举值候选 + phase/位置标注', () => {
    const r = createSuggest({ kb: KB }).suggest('git rebase --empty ');
    assert.equal(r.phase, 'optionParam');
    assert.equal(r.positionLabel, '--empty 的参数 <how>');
    // 活动词为空 → 只提供参数候选（枚举值，字典序排序），不含选项
    assert.deepEqual(textsOf(r), ['ask', 'drop', 'keep']);
    assert.ok(r.candidates.every((c) => c.kind === 'enum'));
    assert.ok(r.candidates.every((c) => c.patternId === 'rebase:opt:--empty'));
  });

  test('活动词 `--empty=d` → key=value 合成候选', () => {
    const r = createSuggest({ kb: KB }).suggest('git rebase --empty=d');
    assert.deepEqual(textsOf(r), ['--empty=drop']);
    assert.equal(r.candidates[0].kind, 'enum');
    assert.equal(r.candidates[0].insert, '--empty=drop');
  });

  test('活动词 `--strategy=o` → 别名形式的合成候选', () => {
    const r = createSuggest({ kb: KB }).suggest('git rebase --strategy=o');
    assert.deepEqual(textsOf(r), ['--strategy=octopus', '--strategy=ort', '--strategy=ours']);
  });

  test('非枚举参数的 `=` 形态 → 无合成候选但不报错', () => {
    const r = createSuggest({ kb: KB }).suggest('git rebase --onto=ma');
    assert.deepEqual(r.candidates.filter((c) => c.kind === 'enum'), []);
  });
});

describe('组合短选项候选', () => {
  test('`-am`：前缀 a 命中 → 生成 -am/-af 组合候选（不受 startsWith 过滤）', () => {
    const r = createSuggest({ kb: KB }).suggest('git commit -am');
    const am = find(r, '-am');
    assert.ok(am, '应有组合候选 -am');
    assert.equal(am.kind, 'option');
    assert.equal(am.patternId, 'commit:opt:-m');
    assert.equal(am.insert, '-am');
    assert.ok(find(r, '-af'), '应有组合候选 -af');
    // 组合候选按常用度排序：-am（3）在 -af（2）前
    assert.ok(textsOf(r).indexOf('-am') < textsOf(r).indexOf('-af'));
    // 普通候选已被前缀过滤（-a 不以 -am 开头）
    assert.ok(!textsOf(r).includes('-a'));
  });

  test('整体是精确可用短选项 → 不生成组合候选', () => {
    const r = createSuggest({ kb: KB }).suggest('git commit -a');
    assert.ok(find(r, '-a'));
    assert.equal(r.candidates.some((c) => c.patternId === 'commit:opt:-m' && c.text !== '-m' && c.text.startsWith('-a') && c.text.length > 2 && c.kind === 'option' && c.insert !== null), false);
  });

  test('前缀命中不完整 → 不生成组合候选（软纠错兜底）', () => {
    const r = createSuggest({ kb: KB }).suggest('git commit -xm');
    // 前缀字母 x 未命中可用短选项 → 无组合候选
    assert.equal(r.candidates.some((c) => c.insert !== null && c.text.startsWith('-x')), false);
    // 软纠错：-xm 与 -m 距离 1、与 -a/-f 距离 2（按距离升序、字典序升序）
    assert.deepEqual(r.corrections, [
      { token: '-xm', index: -1, suggestions: ['-m', '-a', '-f'] },
    ]);
  });
});

describe('纠错建议', () => {
  test('验收 6：git chekcout → Did you mean: checkout（硬触发，uncovered 路径）', () => {
    const r = createSuggest({ kb: KB }).suggest('git chekcout ');
    assert.equal(r.phase, 'uncovered');
    assert.deepEqual(r.corrections, [{ token: 'chekcout', index: 1, suggestions: ['checkout'] }]);
    assert.equal(r.candidates[0].kind, 'correction');
    assert.equal(r.candidates[0].text, 'checkout');
    assert.equal(r.candidates[0].insert, 'checkout');
    assert.ok(r.candidates[0].summary.includes('Did you mean: checkout'));
  });

  test('软触发：活动词完整命令名拼错（git chekcout 无尾随空格）', () => {
    const r = createSuggest({ kb: KB }).suggest('git chekcout');
    assert.equal(r.phase, 'command');
    assert.equal(r.corrections.length, 1);
    assert.equal(r.corrections[0].token, 'chekcout');
    assert.equal(r.corrections[0].index, -1);
    assert.deepEqual(r.corrections[0].suggestions, ['checkout']);
  });

  test('unknown 已完成 Token → 前沿出边池纠错（硬触发，covered 路径）', () => {
    const r = createSuggest({ kb: KB }).suggest('git rebase --keep-bas ');
    assert.equal(r.phase, 'unknown');
    assert.equal(r.corrections[0].token, '--keep-bas');
    assert.deepEqual(r.corrections[0].suggestions, ['--keep-base']);
    // 纠错候选置顶
    assert.equal(r.candidates[0].kind, 'correction');
    assert.equal(r.candidates[0].text, '--keep-base');
  });

  test('距离 ≤ 2 才入选；按距离升序、字典序升序', () => {
    // --cont：与 --onto 距离 2（删 c 增 o）；与 --continue 距离 3（长度差剪枝）→ 不入选
    const r = createSuggest({ kb: KB }).suggest('git rebase --cont ');
    assert.deepEqual(r.corrections, [{ token: '--cont', index: 2, suggestions: ['--onto'] }]);
    // --skipp：与 --skip 距离 1；其余前沿出边均 > 2
    const r2 = createSuggest({ kb: KB }).suggest('git rebase --skipp ');
    assert.deepEqual(r2.corrections[0].suggestions, ['--skip']);
  });

  test('编辑距离 ≤ 2 的多建议与排序（drop/keep/ask 场景）', () => {
    const r = createSuggest({ kb: KB }).suggest('git rebase --empty=drp ');
    // = 一体形式的值错误由 warning 承载，不产生 unknown Token
    assert.deepEqual(r.corrections, []);
  });

  test('活动词软纠错（covered，前缀过滤后为 0）', () => {
    // --fork-poin 是 --fork-point 的前缀 → 普通候选直接命中，无需软纠错
    const pre = createSuggest({ kb: KB }).suggest('git rebase --fork-poin');
    assert.deepEqual(pre.corrections, []);
    assert.deepEqual(textsOf(pre), ['--fork-point']);
    // --fork-poent 非前缀（距离 1）→ 软纠错
    const r = createSuggest({ kb: KB }).suggest('git rebase --fork-poent');
    assert.deepEqual(r.corrections, [
      { token: '--fork-poent', index: -1, suggestions: ['--fork-point'] },
    ]);
    assert.equal(r.candidates[0].kind, 'correction');
  });
});

describe('since 版本标注', () => {
  test('本机版本低于 since → summary 追加后缀', () => {
    const r = createSuggest({ kb: KB, gitVersion: '2.20.0' }).suggest('git rebase --keep');
    assert.equal(find(r, '--keep-base').summary, '以当前分支与上游共同祖先为基点（需 git ≥ 2.23）');
  });

  test('本机版本满足 → 不追加', () => {
    const r = createSuggest({ kb: KB, gitVersion: '2.55.0.windows.1' }).suggest('git rebase --keep');
    assert.equal(find(r, '--keep-base').summary, '以当前分支与上游共同祖先为基点');
  });

  test('版本未知 → 不追加', () => {
    const r = createSuggest({ kb: KB, gitVersion: null }).suggest('git rebase --keep');
    assert.equal(find(r, '--keep-base').summary, '以当前分支与上游共同祖先为基点');
  });
});

describe('positionLabel 与 phase', () => {
  test('选项名（--on*）', () => {
    const r = createSuggest({ kb: KB }).suggest('git rebase --on');
    assert.equal(r.phase, 'options');
    assert.equal(r.positionLabel, '选项名（--on*）');
  });

  test('--onto 的参数 <newbase>', () => {
    const r = createSuggest({ kb: KB }).suggest('git rebase --onto ');
    assert.equal(r.phase, 'optionParam');
    assert.equal(r.positionLabel, '--onto 的参数 <newbase>');
  });

  test('<branch>（第 2 个位置参数）与命令末尾', () => {
    const s = createSuggest({ kb: KB });
    assert.equal(s.suggest('git rebase main ').positionLabel, '<branch>（第 2 个位置参数）');
    assert.equal(s.suggest('git rebase main dev ').positionLabel, '命令末尾');
  });

  test('子命令位（literal 前沿）', () => {
    const r = createSuggest({ kb: KB }).suggest('git stash ');
    assert.equal(r.positionLabel, '子命令位');
    assert.ok(textsOf(r).includes('push'));
    assert.ok(textsOf(r).includes('pop'));
    assert.equal(r.candidates.find((c) => c.text === 'push').kind, 'literal');
  });

  test('待填参数 + 选项形态活动词 → phase=options（R3 顺序的镜像）', () => {
    const r = createSuggest({ kb: KB }).suggest('git rebase --onto --kee');
    assert.equal(r.phase, 'options');
    assert.deepEqual(textsOf(r), ['--keep-base']);
  });
});

describe('多语言与暂无说明兜底', () => {
  test('en-US 界面文案', () => {
    const s = createSuggest({ kb: KB, lang: 'en-US' });
    assert.equal(s.suggest('git ').skeleton.text, 'Type a subcommand, press ↓ to browse all');
    assert.equal(s.suggest('git mytool ').skeleton.text.startsWith('git <command>'), true);
  });

  test('未收录说明的候选显示（暂无说明），不留空不报错', () => {
    const kb = makeKb([
      makeEntry('blank', [
        { type: 'option', key: '--x', optional: true, popularity: 3, summary: '' },
      ], { summary: '空白说明命令', popularity: 3 }),
    ]);
    const r = createSuggest({ kb }).suggest('git blank --');
    assert.equal(find(r, '--x').summary, '（暂无说明）');
    const rEn = createSuggest({ kb, lang: 'en-US' }).suggest('git blank --');
    assert.equal(find(rEn, '--x').summary, '(no description)');
  });
});

describe('命令候选的详情区数据（典型示例/注意事项）', () => {
  test('命令候选携带条目级 examples 首条示例与 notes 注意事项', () => {
    const entry = makeEntry('rebase', REBASE_GRAMMAR, { summary: '在另一个基线之上重放提交', popularity: 4 });
    entry.examples = [
      { cmd: 'git rebase -i HEAD~3', note: '交互式整理最近 3 个提交' },
      { cmd: 'git rebase origin/main', note: '' },
    ];
    entry.notes = ['变基会改写提交历史，已推送的分支慎用', '冲突后先 git add 再 --continue'];
    const kb = makeKb([entry]);
    const r = createSuggest({ kb }).suggest('git reb');
    const c = find(r, 'rebase');
    assert.equal(c.example, 'git rebase -i HEAD~3'); // 条目 examples 首条 cmd
    assert.deepEqual(c.notes, entry.notes); // 条目 notes 透传
    assert.equal(c.detail, null); // 命令条目无 pattern 级 detail，详情区回退 summary
  });

  test('条目缺 examples/notes → 候选字段回退（null / 空数组），不报错', () => {
    const r = createSuggest({ kb: KB }).suggest('git reb');
    const c = find(r, 'rebase');
    assert.equal(c.example, null);
    assert.deepEqual(c.notes, []);
  });

  test('选项/占位符候选的 notes 默认为空数组（契约防御性扩展的默认值）', () => {
    const r = createSuggest({ kb: KB }).suggest('git rebase -');
    assert.ok(r.candidates.every((c) => Array.isArray(c.notes) && c.notes.length === 0));
  });
});

describe('debug 计时与健壮性', () => {
  test('timingsMs 四段非负', () => {
    const r = createSuggest({ kb: KB }).suggest('git rebase -i origin/main ');
    const { timingsMs } = r.debug;
    for (const v of Object.values(timingsMs)) {
      assert.ok(typeof v === 'number' && v >= 0);
    }
  });

  test('任意输入零异常', () => {
    const s = createSuggest({ kb: KB, providers: fakeProviders({}) });
    for (const line of ['', '   ', 'git', 'git ', 'git ///', 'git rebase "unterminated', 'git rebase -i -i -i']) {
      assert.doesNotThrow(() => s.suggest(line));
    }
  });
});
