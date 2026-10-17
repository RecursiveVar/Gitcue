// test/m3-machine.test.mjs —— 状态机单元测试
// 覆盖：浮动选项、位置游标、literal 分支进入与不回退、互斥组（显式 mutex/隐式否定/自动互斥/
// group 摊平）、repeatable（保留必填余数）、组合短选项、unknown 兜底、enum 越界 warning、
// `--` 分隔、`--opt=value` 一体形式、非法输入零异常。

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compilePatterns, matchTokens } from '../src/parser/machine.mjs';
import {
  ensureSandbox,
  REBASE_GRAMMAR,
  STASH_GRAMMAR,
  MV_GRAMMAR,
  ADD_GRAMMAR,
} from './m3-fixtures.mjs';

before(() => {
  process.env.GITCUE_HOME = ensureSandbox();
});

const REBASE = compilePatterns('rebase', REBASE_GRAMMAR);
const STASH = compilePatterns('stash', STASH_GRAMMAR);
const MV = compilePatterns('mv', MV_GRAMMAR);
const ADD = compilePatterns('add', ADD_GRAMMAR);

/** 便捷：把字符串数组包成 token 形状并匹配 */
const m = (compiled, words) => matchTokens(compiled, words.map((text) => ({ text, quoted: false })));
const ids = (result) => [...result.consumedIds];
const optTexts = (result) => result.frontier.options.map((p) => p.key);

describe('编译（compilePatterns）', () => {
  test('patternId 规则：<command>:<类型缩写>:<key>', () => {
    assert.equal(REBASE.byId.get('rebase:opt:-i').key, '-i');
    assert.equal(REBASE.byId.get('rebase:opt:--onto').param.name, 'newbase');
    assert.equal(REBASE.byId.get('rebase:pos:<upstream>').type, 'positional');
    assert.equal(STASH.byId.get('stash:lit:push').type, 'literal');
  });

  test('未被认领的长选项生成隐式否定形式', () => {
    const fp = REBASE.byId.get('rebase:opt:--fork-point');
    assert.deepEqual(fp.implicitForms, ['--no-fork-point']);
    // --keep-base/--autosquash 同理
    assert.deepEqual(REBASE.byId.get('rebase:opt:--keep-base').implicitForms, ['--no-keep-base']);
  });

  test('--no-stat 被 -n 显式认领 → --stat 不生成隐式否定，且与 -n 同互斥组', () => {
    const stat = REBASE.byId.get('rebase:opt:--stat');
    const n = REBASE.byId.get('rebase:opt:-n');
    assert.deepEqual(stat.implicitForms, []);
    assert.equal(stat.mutex, n.mutex); // 并入同一组（显式 stat-mode 为规范名）
    assert.ok(stat.mutex !== null);
    const members = REBASE.mutexGroups.get(stat.mutex);
    assert.ok(members.includes('rebase:opt:--stat'));
    assert.ok(members.includes('rebase:opt:-n'));
  });

  test('group(mode:mutex) 摊平为互斥组，成员标记 fromMutexGroupNode', () => {
    const cont = REBASE.byId.get('rebase:opt:--continue');
    const abort = REBASE.byId.get('rebase:opt:--abort');
    assert.equal(cont.mutex, abort.mutex);
    assert.equal(cont.fromMutexGroupNode, true);
    assert.equal(REBASE.rootOptions.some((p) => p.id === cont.id), true); // 摊平进根选项
  });

  test('同名 positional 的 patternId 去重（diff 式双 <commit> 建模）', () => {
    const c = compilePatterns('diff', [
      { type: 'positional', param: { kind: 'commit', name: 'commit' }, optional: true, popularity: 3, summary: 'a' },
      { type: 'positional', param: { kind: 'commit', name: 'commit' }, optional: true, popularity: 3, summary: 'b' },
    ]);
    assert.equal(c.rootOrdered.length, 2);
    assert.notEqual(c.rootOrdered[0].id, c.rootOrdered[1].id);
  });

  test('literal 分支登记 branches（含嵌套键）', () => {
    assert.ok(STASH.branches.has('push'));
    assert.ok(STASH.branches.has('pop'));
    const pushBranch = STASH.branches.get('push');
    assert.deepEqual(pushBranch.options.map((p) => p.key), ['-m']);
    assert.equal(pushBranch.ordered.length, 1);
  });
});

describe('匹配 R2/R3：浮动选项与位置游标', () => {
  test('选项浮动：不占位置游标', () => {
    const r = m(REBASE, ['main', '-i', 'dev']);
    assert.equal(r.marks[0].role, 'positional'); // main → <upstream>
    assert.equal(r.marks[0].patternId, 'rebase:pos:<upstream>');
    assert.equal(r.marks[1].role, 'option'); // -i 浮动匹配
    assert.equal(r.marks[2].role, 'positional'); // dev → <branch>
    assert.equal(r.marks[2].patternId, 'rebase:pos:<branch>');
  });

  test('游标耗尽后的自由 Token 标 unknown，不阻塞', () => {
    const r = m(REBASE, ['main', 'dev', 'extra']);
    assert.equal(r.marks[2].role, 'unknown');
    assert.deepEqual(r.unknownTokens, [{ index: 2, text: 'extra' }]);
    assert.equal(r.marks.length, 3);
  });

  test('选项参数：下一个 Token 一律作为参数', () => {
    const r = m(REBASE, ['--onto', 'main']);
    assert.equal(r.marks[0].role, 'option');
    assert.equal(r.marks[1].role, 'optionParam');
    assert.equal(r.marks[1].patternId, 'rebase:opt:--onto');
    assert.equal(r.pendingParamId, null);
  });

  test('R3 编号顺序：待填参数不吞噬后续选项（--onto -i main）', () => {
    const r = m(REBASE, ['--onto', '-i', 'main']);
    assert.equal(r.marks[1].role, 'option'); // -i 仍是选项
    assert.equal(r.marks[2].role, 'optionParam'); // main 填 --onto 的参数
    assert.equal(r.pendingParamId, null);
  });

  test('带 param 的 option 消费后 pendingParamId 保留（活动词不参与匹配）', () => {
    const r = m(REBASE, ['--onto']);
    assert.equal(r.pendingParamId, 'rebase:opt:--onto');
  });

  test('--opt=value 一体形式：option 与 param 一并消费（R4）', () => {
    const r = m(REBASE, ['--empty=drop']);
    assert.equal(r.marks[0].role, 'option');
    assert.equal(r.marks[0].patternId, 'rebase:opt:--empty');
    assert.equal(r.marks[0].warning, null);
    assert.equal(r.pendingParamId, null);
  });

  test('enum 越界：消费但附 warning（R4）', () => {
    const r = m(REBASE, ['--empty', 'weird']);
    assert.equal(r.marks[1].role, 'optionParam');
    assert.equal(r.marks[1].warning, '非枚举值');
    const r2 = m(REBASE, ['--empty=weird']);
    assert.equal(r2.marks[0].warning, '非枚举值');
  });

  test('非枚举 param 不产生 warning', () => {
    const r = m(REBASE, ['--onto', 'whatever']);
    assert.equal(r.marks[1].warning, null);
  });
});

describe('literal 分支（R5：进入分支，不回退）', () => {
  test('进入分支后只在 then 序列内匹配', () => {
    const r = m(STASH, ['push', '-m', 'msg', 'a']);
    assert.equal(r.marks[0].role, 'literal');
    assert.equal(r.activeBranchKey, 'push');
    // msg 填 -m 的 text 参数，a 进入 <pathspec>（repeatable）
    assert.equal(r.marks[1].role, 'option');
    assert.equal(r.marks[2].role, 'optionParam');
    assert.equal(r.marks[2].patternId, 'stash:opt:-m');
    assert.equal(r.marks[3].role, 'positional');
    assert.equal(r.marks[3].patternId, 'stash:pos:<pathspec>');
    // 未消费 -m 时：push 后的裸 token 直接归 <pathspec>
    const r2 = m(STASH, ['push', 'x', 'y']);
    assert.equal(r2.marks[1].role, 'positional');
    assert.equal(r2.marks[2].role, 'positional');
  });

  test('不回退父序列：父级剩余 literal 失效', () => {
    // list 分支 then 为空；进入后根序列的 push/pop/clear 全部失效
    const r = m(STASH, ['list', 'push']);
    assert.equal(r.marks[0].role, 'literal');
    assert.equal(r.activeBranchKey, 'list');
    assert.equal(r.marks[1].role, 'unknown'); // push 不会回退匹配根序列的 literal
  });

  test('分支内选项仍可浮动匹配', () => {
    const r = m(STASH, ['push', '-m', 'msg', 'a', 'b']);
    assert.equal(r.marks[1].role, 'option');
    assert.equal(r.marks[2].role, 'optionParam');
    assert.equal(r.marks[3].role, 'positional');
    assert.equal(r.marks[4].role, 'positional');
    // pathspec repeatable：两个 token 都归它
    assert.equal(r.marks[3].patternId, r.marks[4].patternId);
  });

  test('根级浮动选项在进入分支前可匹配', () => {
    const r = m(STASH, ['-p', 'list']);
    assert.equal(r.marks[0].role, 'option');
    assert.equal(r.marks[1].role, 'literal');
    assert.equal(r.activeBranchKey, 'list');
  });
});

describe('互斥（R6）与已用剔除（R7）', () => {
  test('group 互斥组：消费其一，其余永久失效', () => {
    const r = m(REBASE, ['--continue']);
    assert.ok(!optTexts(r).includes('--abort'));
    assert.ok(!optTexts(r).includes('--skip'));
    assert.ok(!optTexts(r).includes('--edit-todo'));
    assert.ok(optTexts(r).includes('--onto')); // 其他选项不受影响
    const r2 = m(REBASE, ['--continue', '--abort']);
    assert.equal(r2.marks[1].role, 'unknown');
  });

  test('alias 联动：消费 --interactive 等价消费 -i（同 pattern）', () => {
    const r = m(REBASE, ['--interactive']);
    assert.ok(ids(r).includes('rebase:opt:-i'));
    assert.ok(!optTexts(r).includes('-i'));
    // alias 形式也已消失
    assert.ok(!r.frontier.options.some((p) => p.aliases.includes('--interactive')));
  });

  test('显式互斥：--stat 与 -n 互斥', () => {
    const r = m(REBASE, ['--stat']);
    assert.ok(!optTexts(r).includes('-n'));
    assert.ok(!r.frontier.options.some((p) => p.aliases.includes('--no-stat')));
    const r2 = m(REBASE, ['-n']);
    assert.ok(!optTexts(r2).includes('--stat'));
    const r3 = m(REBASE, ['-n', '--stat']);
    assert.equal(r3.marks[1].role, 'unknown');
  });

  test('隐式否定：--no-fork-point 可匹配且与 --fork-point 联动消失', () => {
    const r = m(REBASE, ['--no-fork-point']);
    assert.ok(ids(r).includes('rebase:opt:--fork-point'));
    assert.ok(!optTexts(r).includes('--fork-point'));
    const r2 = m(REBASE, ['--fork-point', '--no-fork-point']);
    assert.equal(r2.marks[1].role, 'unknown');
  });

  test('R7 已用剔除：非 repeatable 消费后不再可匹配', () => {
    const r = m(REBASE, ['-i', '-i']);
    assert.equal(r.marks[1].role, 'unknown');
  });

  test('R7 repeatable 选项可重复消费', () => {
    const c = compilePatterns('t', [
      { type: 'option', key: '-e', param: { kind: 'text', name: 'msg' }, optional: true, repeatable: true, popularity: 3, summary: 'x' },
    ]);
    const r = m(c, ['-e', 'a', '-e', 'b']);
    assert.equal(r.marks[0].role, 'option');
    assert.equal(r.marks[1].role, 'optionParam');
    assert.equal(r.marks[2].role, 'option');
    assert.equal(r.marks[3].role, 'optionParam');
  });
});

describe('repeatable positional（保留必填余数）', () => {
  test('git mv a b c dest → a/b/c 归 <sources>，dest 归 <dest>', () => {
    const r = m(MV, ['a', 'b', 'c', 'dest']);
    const roles = r.marks.map((x) => x.patternId);
    assert.deepEqual(roles, [
      'mv:pos:<sources>',
      'mv:pos:<sources>',
      'mv:pos:<sources>',
      'mv:pos:<dest>',
    ]);
  });

  test('git mv a b → a 归 <sources>，b 归 <dest>（r=1 ≤ k=1 推进游标）', () => {
    const r = m(MV, ['a', 'b']);
    assert.equal(r.marks[0].patternId, 'mv:pos:<sources>');
    assert.equal(r.marks[1].patternId, 'mv:pos:<dest>');
  });

  test('git mv a → 单 token 归 <dest>（r=1 ≤ k=1）', () => {
    const r = m(MV, ['a']);
    assert.equal(r.marks[0].patternId, 'mv:pos:<dest>');
  });

  test('无后续必填 positional 时 repeatable 持续吞并（add <pathspec>...）', () => {
    const r = m(ADD, ['a', 'b', 'c']);
    assert.ok(r.marks.every((x) => x.patternId === 'add:pos:<pathspec>'));
    assert.equal(r.frontier.nextOrdered.id, 'add:pos:<pathspec>'); // 游标不动，仍可继续
  });

  test('选项与 repeatable positional 混排', () => {
    const r = m(ADD, ['-A', 'a', '-u', 'b']);
    assert.equal(r.marks[0].role, 'option');
    assert.equal(r.marks[1].role, 'positional');
    assert.equal(r.marks[2].role, 'option');
    assert.equal(r.marks[3].role, 'positional');
  });
});

describe('组合短选项', () => {
  test('全部字母命中 → 依次消费各 Pattern', () => {
    const r = m(ADD, ['-Auf']);
    assert.ok(ids(r).includes('add:opt:-A'));
    assert.ok(ids(r).includes('add:opt:-u'));
    assert.ok(ids(r).includes('add:opt:-f'));
    assert.equal(r.marks[0].role, 'option');
    assert.equal(r.marks[0].patternId, 'add:opt:-A'); // mark 取组合首项
  });

  test('任一字母未命中 → 整体 unknown', () => {
    const r = m(ADD, ['-Ax']);
    assert.equal(r.marks[0].role, 'unknown');
    assert.deepEqual(r.unknownTokens, [{ index: 0, text: '-Ax' }]);
  });

  test('组合内重复非 repeatable 短选项 → unknown（无半消费）', () => {
    const r = m(ADD, ['-AA']);
    assert.equal(r.marks[0].role, 'unknown');
    assert.ok(!ids(r).includes('add:opt:-A')); // 两阶段验证：未产生部分消费
  });

  test('非字母组合（如 -A2）不走组合分支 → unknown', () => {
    const r = m(ADD, ['-A2']);
    assert.equal(r.marks[0].role, 'unknown');
  });
});

describe('分隔符 --（R9）', () => {
  test('分隔后非选项 Token 按 positional 匹配', () => {
    const r = m(REBASE, ['--', 'main']);
    assert.equal(r.marks[0].role, 'separator');
    assert.equal(r.separatorAt, 0);
    assert.equal(r.marks[1].role, 'positional');
    assert.equal(r.marks[1].patternId, 'rebase:pos:<upstream>');
  });

  test('分隔后选项 Token 标 unknown', () => {
    const r = m(REBASE, ['--', '-i']);
    assert.equal(r.marks[0].role, 'separator');
    assert.equal(r.marks[1].role, 'unknown');
  });

  test('分隔后不再匹配 literal（一律 positional）', () => {
    const r = m(STASH, ['--', 'push']);
    assert.equal(r.marks[0].role, 'separator');
    // stash 根序列无 positional → unknown（而非进入 push 分支）
    assert.equal(r.marks[1].role, 'unknown');
    assert.equal(r.activeBranchKey, null);
  });

  test('分隔后前沿 options 为空', () => {
    const r = m(REBASE, ['--']);
    assert.deepEqual(r.frontier.options, []);
  });
});

describe('前沿与零异常', () => {
  test('前沿 = 剩余可用选项 + 游标指向的下一个有序 Pattern', () => {
    const r = m(REBASE, ['-i']);
    assert.ok(optTexts(r).includes('--onto'));
    assert.ok(optTexts(r).includes('--continue')); // 互斥组未占用
    assert.equal(r.frontier.nextOrdered.id, 'rebase:pos:<upstream>');
    assert.equal(r.frontier.branchKey, null);
  });

  test('全部有序消费完 → nextOrdered=null（命令末尾）', () => {
    const r = m(REBASE, ['main', 'dev']);
    assert.equal(r.frontier.nextOrdered, null);
  });

  test('任意畸形输入零异常', () => {
    assert.doesNotThrow(() => m(REBASE, []));
    assert.doesNotThrow(() => m(REBASE, ['--', '--', '--']));
    assert.doesNotThrow(() => m(REBASE, ['%%%','&&&','***']));
    assert.doesNotThrow(() => m(REBASE, ['-']));
    assert.doesNotThrow(() => m(REBASE, Array.from({ length: 100 }, (_, i) => `t${i}`)));
    // '%%%' 是非选项 Token，按游标规则归首个 positional（positional 接受任意文本）
    const r = m(REBASE, ['%%%']);
    assert.equal(r.marks.length, 1);
    assert.equal(r.marks[0].role, 'positional');
  });

  test('单独的 `-` 不按选项处理（走 positional）', () => {
    const r = m(REBASE, ['-']);
    assert.equal(r.marks[0].role, 'positional');
  });
});
