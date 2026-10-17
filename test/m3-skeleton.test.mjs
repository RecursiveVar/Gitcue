// test/m3-skeleton.test.mjs —— 骨架渲染单元测试
// 覆盖：完整骨架逐字断言；紧凑骨架（rebase 锚点）；consumed 标注 span；
// 光标 offset；互斥伙伴消失；literal 折叠与分支渲染；引导与未收录文案。

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compilePatterns } from '../src/parser/machine.mjs';
import { matchTokens } from '../src/parser/machine.mjs';
import {
  renderSkeleton,
  guideSkeleton,
  uncoveredSkeleton,
} from '../src/parser/skeleton.mjs';
import { ensureSandbox, REBASE_GRAMMAR, STASH_GRAMMAR } from './m3-fixtures.mjs';

before(() => {
  process.env.GITCUE_HOME = ensureSandbox();
});

const REBASE = compilePatterns('rebase', REBASE_GRAMMAR);
const STASH = compilePatterns('stash', STASH_GRAMMAR);

/** 便捷：匹配 words 后做紧凑渲染 */
function compact(words, { cursorOn = undefined, compiled = REBASE, commandName = 'rebase' } = {}) {
  const match = matchTokens(
    compiled,
    words.map((text) => ({ text, quoted: false })),
  );
  const pendingParam = match.pendingParamId ? compiled.byId.get(match.pendingParamId) : null;
  const co = cursorOn !== undefined ? cursorOn : pendingParam ?? match.frontier.nextOrdered ?? null;
  return {
    match,
    sk: renderSkeleton({
      commandName,
      compiled,
      consumedIds: match.consumedIds,
      activeBranchKey: match.activeBranchKey,
      frontier: match.frontier,
      cursorOn: co,
      mode: 'compact',
    }),
  };
}

describe('完整骨架（默认 mode）', () => {
  test('rebase 完整骨架逐字一致（含 alias、互斥组、enum 参数、positional）', () => {
    const sk = renderSkeleton({ commandName: 'rebase', compiled: REBASE });
    assert.equal(
      sk.text,
      'git rebase [-i | --interactive] [--onto <newbase>] [--keep-base] [--fork-point] ' +
        '[-m | --merge] [-s | --strategy <strategy>] [--empty <how>] [--autosquash] [--stat] ' +
        '[-n | --no-stat] [--continue | --abort | --skip | --edit-todo] [<upstream>] [<branch>]',
    );
    assert.equal(sk.cursor, null);
  });

  test('全部 pattern 均有 span 标注（dim 态）', () => {
    const sk = renderSkeleton({ commandName: 'rebase', compiled: REBASE });
    assert.equal(sk.marks.length, REBASE.patterns.length);
    assert.ok(sk.marks.every((mk) => mk.state === 'dim'));
    const onto = sk.marks.find((mk) => mk.patternId === 'rebase:opt:--onto');
    assert.equal(sk.text.slice(onto.start, onto.end), '--onto <newbase>');
  });

  test('literal 的 then 内联渲染', () => {
    const sk = renderSkeleton({ commandName: 'stash', compiled: STASH });
    assert.ok(sk.text.startsWith('git stash [-p | --patch] [push [-m | --message <msg>] [<pathspec>...]]'));
    assert.ok(sk.text.includes('[pop [<stash>]]'));
    assert.ok(sk.text.includes('[list]'));
    assert.ok(sk.text.includes('[clear]'));
  });
});

describe('紧凑骨架（rebase 锚点）', () => {
  const ANCHOR = 'git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]';

  test('空输入：紧凑骨架恰为锚点串（低频选项与未消费互斥组成员隐藏）', () => {
    const { sk } = compact([]);
    assert.equal(sk.text, ANCHOR);
  });

  test('光标落在 [<upstream>] 之前（验收 1 锚点）', () => {
    const { sk } = compact([]);
    assert.equal(sk.cursor, sk.text.indexOf('[<upstream>]'));
  });

  test('已输入 -i 后骨架不收缩文本，-i 标 consumed，其余 dim', () => {
    const { sk } = compact(['-i']);
    assert.equal(sk.text, ANCHOR);
    const mi = sk.marks.find((mk) => mk.patternId === 'rebase:opt:-i');
    assert.equal(mi.state, 'consumed');
    assert.equal(sk.text.slice(mi.start, mi.end), '-i');
    const up = sk.marks.find((mk) => mk.patternId === 'rebase:pos:<upstream>');
    assert.equal(up.state, 'available'); // cursorOn → 当前位置
    assert.equal(sk.cursor, sk.text.indexOf('[<upstream>]'));
  });

  test('已消费的低频选项照常显示（不论常用度）', () => {
    const { sk } = compact(['--keep-base']);
    assert.ok(sk.text.includes('[--keep-base]'));
    const mk = sk.marks.find((x) => x.patternId === 'rebase:opt:--keep-base');
    assert.equal(mk.state, 'consumed');
  });

  test('互斥伙伴消费后从骨架消失（动态收缩）', () => {
    // -n（pop 2）消费后 --stat（同互斥组）即使被消费也不显示；-n 自身 consumed 显示
    const { sk } = compact(['-n']);
    assert.ok(sk.text.includes('[-n]'));
    assert.ok(!sk.text.includes('--stat'));
    assert.ok(!sk.text.includes('--no-stat'));
  });

  test('已消费的互斥组成员照常显示（规则①的例外）', () => {
    const { sk } = compact(['--continue']);
    assert.ok(sk.text.includes('[--continue]'));
    assert.ok(!sk.text.includes('--abort'));
    assert.ok(!sk.text.includes('--skip'));
  });

  test('游标耗尽（全部 positional 消费）→ cursor=null', () => {
    const { sk } = compact(['main', 'dev']);
    assert.equal(sk.cursor, null);
    const b = sk.marks.find((x) => x.patternId === 'rebase:pos:<branch>');
    assert.equal(b.state, 'consumed');
  });

  test('待填参数：cursor 指向 <newbase> 段', () => {
    const { sk } = compact(['--onto']);
    assert.equal(sk.cursor, sk.text.indexOf('<newbase>'));
  });
});

describe('紧凑骨架（literal 折叠与分支渲染）', () => {
  test('未进入分支：literal 集合折叠为 [<command>]（只出现一次）', () => {
    const { sk } = compact([], { compiled: STASH, commandName: 'stash' });
    assert.equal(sk.text, 'git stash [-p] [<command>]');
    assert.equal(sk.text.indexOf('[<command>]'), sk.text.lastIndexOf('[<command>]'));
  });

  test('进入分支后渲染该分支（设计示例形态）', () => {
    const { sk } = compact(['push'], { compiled: STASH, commandName: 'stash' });
    assert.equal(sk.text, 'git stash push [-m <msg>] [<pathspec>...]');
  });

  test('进入无参分支（list）→ 仅命令头 + 分支名', () => {
    const { sk } = compact(['list'], { compiled: STASH, commandName: 'stash' });
    assert.equal(sk.text, 'git stash list');
  });

  test('折叠段的光标指向其起点', () => {
    const { sk } = compact([], { compiled: STASH, commandName: 'stash' });
    // cursorOn = 根序列第一个 literal（push）→ 光标落在 [<command>] 前
    assert.equal(sk.cursor, sk.text.indexOf('[<command>]'));
  });
});

describe('紧凑骨架的命令头/分支路径已输入标注', () => {
  test('空输入：命令头 rebase 标注 consumed（Tab 补全后「其中 rebase 已高亮」）', () => {
    const { sk } = compact([]);
    const cmd = sk.marks.find((mk) => mk.patternId === 'rebase:cmd:rebase');
    assert.ok(cmd, '应含命令头标注 rebase:cmd:rebase');
    assert.equal(cmd.state, 'consumed');
    assert.equal(sk.text.slice(cmd.start, cmd.end), 'rebase');
  });

  test('已输入 -i：命令头与 -i 均 consumed；命令头 span 不与 pattern span 重叠', () => {
    const { sk } = compact(['-i']);
    const cmd = sk.marks.find((mk) => mk.patternId === 'rebase:cmd:rebase');
    const mi = sk.marks.find((mk) => mk.patternId === 'rebase:opt:-i');
    assert.equal(cmd.state, 'consumed');
    assert.equal(mi.state, 'consumed');
    assert.ok(cmd.end <= mi.start, '命令头标注与选项标注不得重叠');
  });

  test('进入 literal 分支：分支路径（stash push 的 push）标注 consumed', () => {
    const { sk } = compact(['push'], { compiled: STASH, commandName: 'stash' });
    const lit = sk.marks.find((mk) => mk.patternId === 'stash:lit:push');
    assert.ok(lit, '应含分支字面量标注 stash:lit:push');
    assert.equal(lit.state, 'consumed');
    assert.equal(sk.text.slice(lit.start, lit.end), 'push');
    const cmd = sk.marks.find((mk) => mk.patternId === 'stash:cmd:stash');
    assert.equal(sk.text.slice(cmd.start, cmd.end), 'stash');
  });

  test('完整骨架不附带命令头标注（加载期静态展示，marks 数量不变）', () => {
    const sk = renderSkeleton({ commandName: 'rebase', compiled: REBASE });
    assert.equal(sk.marks.length, REBASE.patterns.length);
    assert.ok(!sk.marks.some((mk) => mk.patternId.includes(':cmd:')));
  });
});

describe('空态与未收录文案', () => {
  test('空态引导文案', () => {
    assert.equal(guideSkeleton('zh-CN').text, '输入子命令，↓ 浏览全部');
    assert.equal(guideSkeleton('en-US').text, 'Type a subcommand, press ↓ to browse all');
    assert.deepEqual(guideSkeleton().marks, []);
    assert.equal(guideSkeleton().cursor, null);
  });

  test('未收录文案（<command> 为字面占位）', () => {
    assert.equal(uncoveredSkeleton('zh-CN').text, 'git <command> [args...]（未收录，直接执行）');
    assert.deepEqual(uncoveredSkeleton().marks, []);
    assert.equal(uncoveredSkeleton().cursor, null);
  });
});

describe('span 完整性（文本与偏移一致）', () => {
  test('每个 mark 的 [start,end) 切片非空且不越界', () => {
    for (const words of [[], ['-i'], ['--onto'], ['main'], ['--continue', 'main']]) {
      const { sk } = compact(words);
      for (const mk of sk.marks) {
        assert.ok(mk.start < mk.end, `空 span：${JSON.stringify(mk)}`);
        assert.ok(mk.start >= 0 && mk.end <= sk.text.length, `越界 span：${JSON.stringify(mk)}`);
        assert.ok(sk.text.slice(mk.start, mk.end).length > 0);
      }
    }
  });
});
