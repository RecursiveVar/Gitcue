// test/m3-lexer.test.mjs —— 词法分析单元测试
// 覆盖：引号/转义/多空格/光标各位置的活动词判定/`--`/`--opt=val` 不拆分。
// 约定：默认光标 = 行尾，故“全部 Token 已完成”的用例一律以尾随空格结尾；
//       活动词用例不带尾随空格。
// 本模块纯逻辑测试不涉及用户级数据；仍防御性地将 GITCUE_HOME 指向本模块沙箱。

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/parser/lexer.mjs';
import { ensureSandbox } from './m3-fixtures.mjs';

before(() => {
  process.env.GITCUE_HOME = ensureSandbox();
});

/** 便捷：取 token 文本数组 */
const texts = (r) => r.tokens.map((t) => t.text);

describe('基础切分', () => {
  test('普通命令行按空格切分，记录偏移', () => {
    const r = tokenize('git rebase -i ');
    assert.deepEqual(texts(r), ['git', 'rebase', '-i']);
    assert.deepEqual(
      r.tokens.map((t) => [t.start, t.end]),
      [
        [0, 3],
        [4, 10],
        [11, 13],
      ],
    );
    assert.equal(r.tokens.every((t) => t.quoted === false), true);
    assert.equal(r.active, null);
  });

  test('光标越界钳制到行尾（cursor=24 超出行长）', () => {
    const r = tokenize('git rebase -i', 15);
    assert.deepEqual(texts(r), ['git', 'rebase']);
    assert.equal(r.active.text, '-i'); // 等价于光标 13（行尾）
  });

  test('多个连续空格/制表符不分出空 Token', () => {
    const r = tokenize('git   rebase\t\t-i ');
    assert.deepEqual(texts(r), ['git', 'rebase', '-i']);
  });

  test('空行与纯空格行', () => {
    assert.deepEqual(texts(tokenize('')), []);
    assert.equal(tokenize('').active, null);
    assert.deepEqual(texts(tokenize('   ')), []);
  });

  test('--opt=value 不在词法层拆分（R4 由匹配层拆）', () => {
    const r = tokenize('git rebase --empty=drop ');
    assert.deepEqual(texts(r), ['git', 'rebase', '--empty=drop']);
  });
});

describe('引号与转义', () => {
  test('双引号内空格合并为一个 Token，text 去引号', () => {
    const r = tokenize('git commit -m "hello world" ');
    assert.deepEqual(texts(r), ['git', 'commit', '-m', 'hello world']);
    assert.equal(r.tokens[3].quoted, true);
    assert.deepEqual([r.tokens[3].start, r.tokens[3].end], [14, 27]);
  });

  test('单引号同样合并', () => {
    const r = tokenize("git commit -m 'a b' ");
    assert.deepEqual(texts(r), ['git', 'commit', '-m', 'a b']);
    assert.equal(r.tokens[3].quoted, true);
  });

  test('双引号内的转义引号与转义反斜杠', () => {
    const r = tokenize('git commit -m "a \\"b\\" c" ');
    assert.equal(r.tokens[3].text, 'a "b" c');
    const r2 = tokenize('git commit -m "a\\\\b" ');
    assert.equal(r2.tokens[3].text, 'a\\b');
  });

  test('单引号内反斜杠按字面量处理（POSIX 习惯）', () => {
    const r = tokenize("git commit -m 'a\\b' ");
    assert.equal(r.tokens[3].text, 'a\\b');
  });

  test('引号外反斜杠转义空格', () => {
    const r = tokenize('git mv a\\ b c ');
    assert.deepEqual(texts(r), ['git', 'mv', 'a b', 'c']);
    assert.equal(r.tokens[2].quoted, false);
  });

  test('未闭合引号容错为活动词（不抛异常）', () => {
    const r = tokenize('git commit -m "abc');
    assert.deepEqual(texts(r), ['git', 'commit', '-m']);
    assert.equal(r.active.text, 'abc');
    assert.equal(r.active.quoted, true);
  });

  test('行尾悬垂反斜杠按字面量容错', () => {
    const r = tokenize('git rebase -i\\');
    assert.deepEqual(texts(r), ['git', 'rebase']);
    assert.equal(r.active.text, '-i\\');
  });
});

describe('活动词判定（光标所在词为活动词，不进 tokens）', () => {
  test('光标在行尾词内 → 该词为 active 且不进 tokens', () => {
    const r = tokenize('git rebase -i origin/ma');
    assert.equal(r.active.text, 'origin/ma');
    assert.deepEqual(texts(r), ['git', 'rebase', '-i']);
  });

  test('光标在词中间 → 该词为 active（取全文，非前缀）', () => {
    const r = tokenize('git rebase -i origin/ma', 18);
    assert.equal(r.active.text, 'origin/ma');
    assert.deepEqual(texts(r), ['git', 'rebase', '-i']);
  });

  test('光标在词首 → 该词为 active', () => {
    const r = tokenize('git rebase', 4);
    assert.equal(r.active.text, 'rebase');
    assert.deepEqual(texts(r), ['git']);
  });

  test('尾随空格后（新词）→ active=null，前词已完成', () => {
    const r = tokenize('git push ');
    assert.equal(r.active, null);
    assert.deepEqual(texts(r), ['git', 'push']);
  });

  test('光标紧贴词尾但其后是空格 → 视为已离开该词（active=null，词已完成）', () => {
    const r = tokenize('git push origin', 8);
    assert.equal(r.active, null);
    assert.deepEqual(texts(r), ['git', 'push', 'origin']);
  });

  test('光标默认行尾', () => {
    const r = tokenize('git reb');
    assert.equal(r.active.text, 'reb');
    assert.deepEqual(texts(r), ['git']);
  });

  test('引号词内光标 → 引号词为 active', () => {
    const line = 'git commit -m "hello wor';
    const r = tokenize(line, line.length);
    assert.equal(r.active.text, 'hello wor');
    assert.deepEqual(texts(r), ['git', 'commit', '-m']);
  });
});

describe('分隔符 --（R9）', () => {
  test('精确 `--` Token 标记 separatorSeen', () => {
    const r = tokenize('git log -- path ');
    assert.equal(r.separatorSeen, true);
    assert.deepEqual(texts(r), ['git', 'log', '--', 'path']);
  });

  test('行尾 `--` 成为已完成 Token 后同样标记', () => {
    assert.equal(tokenize('git log -- ').separatorSeen, true);
  });

  test('`--xxx` 与 `--x=y` 不是分隔符', () => {
    assert.equal(tokenize('git log --oneline ').separatorSeen, false);
    assert.equal(tokenize('git log --pretty=format:x ').separatorSeen, false);
  });

  test('活动词 `--` 未完成，不计入 separatorSeen', () => {
    const r = tokenize('git log --'); // 默认光标在行尾，`--` 是活动词
    assert.equal(r.active.text, '--');
    assert.equal(r.tokens.some((t) => t.text === '--'), false);
    assert.equal(r.separatorSeen, false);
    const r2 = tokenize('git log -- ', 10); // 光标移离后成为已完成 Token
    assert.equal(r2.separatorSeen, true);
  });
});
