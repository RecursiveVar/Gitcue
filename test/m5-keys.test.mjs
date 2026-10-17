/**
 * ANSI 键解码器单元测试。
 * 覆盖：解码表逐序列、跨 chunk ESC 序列、孤立 ESC flush、UTF-8 多字节。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyDecoder } from '../src/ui/keys.mjs';

/** 按字节精确构造（控制字节用 latin1，多字节字符用 utf8） */
function bytes(str) {
  return Buffer.from(str, 'latin1');
}

describe('m5-keys 单字节与控制键', () => {
  it('\\r 与 \\n → enter', () => {
    assert.deepEqual(createKeyDecoder().feed(bytes('\r')), [{ type: 'enter' }]);
    assert.deepEqual(createKeyDecoder().feed(bytes('\n')), [{ type: 'enter' }]);
  });
  it('\\t → tab', () => {
    assert.deepEqual(createKeyDecoder().feed(bytes('\t')), [{ type: 'tab' }]);
  });
  it('\\x7f 与 \\x08 → backspace', () => {
    assert.deepEqual(createKeyDecoder().feed(bytes('\x7f')), [{ type: 'backspace' }]);
    assert.deepEqual(createKeyDecoder().feed(bytes('\x08')), [{ type: 'backspace' }]);
  });
  it('Ctrl 键：\\x03 c / \\x11 q / \\x15 u / \\x17 w / \\x01 a / \\x05 e / \\x1f ?', () => {
    const d = createKeyDecoder();
    assert.deepEqual(d.feed(bytes('\x03')), [{ type: 'ctrl', ch: 'c' }]);
    assert.deepEqual(d.feed(bytes('\x11')), [{ type: 'ctrl', ch: 'q' }]);
    assert.deepEqual(d.feed(bytes('\x15')), [{ type: 'ctrl', ch: 'u' }]);
    assert.deepEqual(d.feed(bytes('\x17')), [{ type: 'ctrl', ch: 'w' }]);
    assert.deepEqual(d.feed(bytes('\x01')), [{ type: 'ctrl', ch: 'a' }]);
    assert.deepEqual(d.feed(bytes('\x05')), [{ type: 'ctrl', ch: 'e' }]);
    assert.deepEqual(d.feed(bytes('\x1f')), [{ type: 'ctrl', ch: '?' }]);
  });
  it('\\x00（Ctrl+Space）与其它未列控制键直接丢弃', () => {
    assert.deepEqual(createKeyDecoder().feed(bytes('\x00')), []);
    assert.deepEqual(createKeyDecoder().feed(bytes('\x02')), []); // ctrl b
    assert.deepEqual(createKeyDecoder().feed(bytes('\x1a')), []); // ctrl z
  });
  it('可打印 ASCII 与多字节 UTF-8 → printable', () => {
    assert.deepEqual(createKeyDecoder().feed(bytes('a')), [{ type: 'printable', ch: 'a' }]);
    assert.deepEqual(createKeyDecoder().feed(Buffer.from('中')), [{ type: 'printable', ch: '中' }]);
    assert.deepEqual(createKeyDecoder().feed(Buffer.from('文')), [{ type: 'printable', ch: '文' }]);
  });
  it('同一 chunk 多键按序输出', () => {
    assert.deepEqual(createKeyDecoder().feed(bytes('abc\r')), [
      { type: 'printable', ch: 'a' },
      { type: 'printable', ch: 'b' },
      { type: 'printable', ch: 'c' },
      { type: 'enter' },
    ]);
  });
});

describe('m5-keys 转义序列', () => {
  it('方向键 \\x1b[A/B/C/D', () => {
    const d = createKeyDecoder();
    assert.deepEqual(d.feed(bytes('\x1b[A')), [{ type: 'arrow', dir: 'up' }]);
    assert.deepEqual(d.feed(bytes('\x1b[B')), [{ type: 'arrow', dir: 'down' }]);
    assert.deepEqual(d.feed(bytes('\x1b[C')), [{ type: 'arrow', dir: 'right' }]);
    assert.deepEqual(d.feed(bytes('\x1b[D')), [{ type: 'arrow', dir: 'left' }]);
  });
  it('翻页 \\x1b[5~ / \\x1b[6~，删除 \\x1b[3~', () => {
    const d = createKeyDecoder();
    assert.deepEqual(d.feed(bytes('\x1b[5~')), [{ type: 'page', dir: 'up' }]);
    assert.deepEqual(d.feed(bytes('\x1b[6~')), [{ type: 'page', dir: 'down' }]);
    assert.deepEqual(d.feed(bytes('\x1b[3~')), [{ type: 'delete' }]);
  });
  it('home/end 各变体', () => {
    const d = createKeyDecoder();
    for (const seq of ['\x1b[H', '\x1b[1~', '\x1b[7~']) {
      assert.deepEqual(createKeyDecoder().feed(bytes(seq)), [{ type: 'home' }], seq);
    }
    for (const seq of ['\x1b[F', '\x1b[4~', '\x1b[8~']) {
      assert.deepEqual(createKeyDecoder().feed(bytes(seq)), [{ type: 'end' }], seq);
    }
    void d;
  });
  it('SS3 功能键 \\x1bOP..S → F1..F4', () => {
    assert.deepEqual(createKeyDecoder().feed(bytes('\x1bOP')), [{ type: 'function', n: 1 }]);
    assert.deepEqual(createKeyDecoder().feed(bytes('\x1bOQ')), [{ type: 'function', n: 2 }]);
    assert.deepEqual(createKeyDecoder().feed(bytes('\x1bOR')), [{ type: 'function', n: 3 }]);
    assert.deepEqual(createKeyDecoder().feed(bytes('\x1bOS')), [{ type: 'function', n: 4 }]);
  });
  it('未知序列丢弃（\\x1b[Z、\\x1b[2~、\\x1bOX）', () => {
    assert.deepEqual(createKeyDecoder().feed(bytes('\x1b[Z')), []);
    assert.deepEqual(createKeyDecoder().feed(bytes('\x1b[2~')), []);
    assert.deepEqual(createKeyDecoder().feed(bytes('\x1bOX')), []);
  });
  it('序列后跟普通键继续解码', () => {
    assert.deepEqual(createKeyDecoder().feed(bytes('\x1b[3~x')), [
      { type: 'delete' },
      { type: 'printable', ch: 'x' },
    ]);
  });
});

describe('m5-keys 跨 chunk 与 flush', () => {
  it('ESC 序列跨 chunk：\\x1b + [A 补齐后输出方向键', () => {
    const d = createKeyDecoder();
    assert.deepEqual(d.feed(bytes('\x1b')), []);
    assert.deepEqual(d.feed(bytes('[A')), [{ type: 'arrow', dir: 'up' }]);
  });
  it('翻页序列跨 chunk 三段补齐', () => {
    const d = createKeyDecoder();
    assert.deepEqual(d.feed(bytes('\x1b')), []);
    assert.deepEqual(d.feed(bytes('[')), []);
    assert.deepEqual(d.feed(bytes('5')), []);
    assert.deepEqual(d.feed(bytes('~')), [{ type: 'page', dir: 'up' }]);
  });
  it('UTF-8 多字节跨 chunk 补齐', () => {
    const d = createKeyDecoder();
    const buf = Buffer.from('中'); // E4 B8 AD
    assert.deepEqual(d.feed(buf.subarray(0, 1)), []);
    assert.deepEqual(d.feed(buf.subarray(1, 2)), []);
    assert.deepEqual(d.feed(buf.subarray(2)), [{ type: 'printable', ch: '中' }]);
  });
  it('孤立 ESC：feed 缓冲，flush 结算为 escape', () => {
    const d = createKeyDecoder();
    assert.deepEqual(d.feed(bytes('\x1b')), []);
    assert.deepEqual(d.flush(), [{ type: 'escape' }]);
    // flush 后缓冲清空，再次 flush 无输出
    assert.deepEqual(d.flush(), []);
  });
  it('flush 丢弃无法补齐的 CSI 前缀', () => {
    const d = createKeyDecoder();
    d.feed(bytes('\x1b['));
    assert.deepEqual(d.flush(), []);
  });
  it('ESC + 普通字节：结算 escape 后剩余字节按普通键解析', () => {
    assert.deepEqual(createKeyDecoder().feed(bytes('\x1ba')), [
      { type: 'escape' },
      { type: 'printable', ch: 'a' },
    ]);
  });
  it('无效 UTF-8 首字节（孤立续字节）被丢弃', () => {
    const d = createKeyDecoder();
    assert.deepEqual(d.feed(bytes('\x80')), []);
    assert.deepEqual(d.feed(bytes('k')), [{ type: 'printable', ch: 'k' }]);
  });
});
