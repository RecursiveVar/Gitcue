/**
 * ANSI/C0 按键解码器（`src/ui/keys.mjs`）。
 *
 * 职责：把 raw mode 下 stdin 的字节流解码为结构化 Key 事件，供 reducer 消费。
 *
 * 特性：
 *  - 跨 chunk 安全：转义序列 / UTF-8 多字节字符跨读取分片时先缓冲，补齐后再解码；
 *  - 孤立 ESC：终端单按 Esc 只发送 0x1b 一个字节，无法与序列前缀区分，
 *    feed() 会保留缓冲；controller 在空闲 50ms 后调用 flush() 将其结算为 escape 键；
 *  - 未知序列丢弃，任何输入都不抛异常。
 *
 * 解码表：
 *   \r（及 \n）→ enter；\t → tab；\x7f / \x08 → backspace；
 *   \x1b[A/B/C/D → arrow；\x1b[5~/6~ → page；\x1b[3~ → delete；
 *   \x1b[H / \x1b[1~ / \x1b[7~ → home；\x1b[F / \x1b[4~ / \x1b[8~ → end；
 *   \x1bOP/OQ/OR/OS → F1–F4；\x03 → ctrl c、\x11 → ctrl q、\x15 → ctrl u、
 *   \x17 → ctrl w、\x01 → ctrl a、\x05 → ctrl e、\x00 → ctrl space（直接丢弃）、
 *   \x1f → ctrl ?；其余可打印 UTF-8 → printable。
 *
 * @typedef {{type:'printable',ch:string}
 *   |{type:'enter'}|{type:'tab'}|{type:'escape'}|{type:'backspace'}|{type:'delete'}
 *   |{type:'arrow',dir:'up'|'down'|'left'|'right'}
 *   |{type:'page',dir:'up'|'down'}
 *   |{type:'home'}|{type:'end'}
 *   |{type:'function',n:number}
 *   |{type:'ctrl',ch:'c'|'q'|'u'|'w'|'a'|'e'|'space'|'?'}} Key
 */

/** 单字节控制键 → Key（未列出的 C0 控制键一律丢弃） */
const SINGLE_KEYS = new Map([
  [0x0d, { type: 'enter' }],
  [0x0a, { type: 'enter' }], // 部分终端以 \n 发送回车，按 enter 处理
  [0x09, { type: 'tab' }],
  [0x7f, { type: 'backspace' }],
  [0x08, { type: 'backspace' }],
  [0x01, { type: 'ctrl', ch: 'a' }],
  [0x03, { type: 'ctrl', ch: 'c' }],
  [0x05, { type: 'ctrl', ch: 'e' }],
  [0x11, { type: 'ctrl', ch: 'q' }],
  [0x15, { type: 'ctrl', ch: 'u' }],
  [0x17, { type: 'ctrl', ch: 'w' }],
  [0x1f, { type: 'ctrl', ch: '?' }],
]);

/** 惰性创建的 UTF-8 解码器（仅对"已补齐的完整序列"解码，无流式状态） */
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * 估算 UTF-8 序列长度（按首字节）；返回 0 表示无效首字节（孤立续字节等，应丢弃）。
 * @param {number} b 首字节
 * @returns {number} 序列字节数（1–4），无效返回 0
 */
function utf8SeqLen(b) {
  if (b >= 0x20 && b <= 0x7e) return 1; // 可打印 ASCII
  if (b >= 0xc2 && b <= 0xdf) return 2;
  if (b >= 0xe0 && b <= 0xef) return 3;
  if (b >= 0xf0 && b <= 0xf4) return 4;
  return 0;
}

/**
 * 创建按键解码器实例。
 * @returns {{ feed(bytes: Uint8Array): Key[], flush(): Key[] }}
 */
export function createKeyDecoder() {
  /** @type {number[]} 待解析字节缓冲 */
  let buf = [];

  /**
   * 尝试在缓冲头部匹配一条转义序列（ESC 开头）。
   * 完成：消费相应字节并返回 key（未知序列返回 null 表示已丢弃）；
   * 未补齐：返回 { wait: true }；ESC 后跟非 [/O 字节：结算为孤立 escape（Alt 组合的
   * 前缀场景，剩余字节交回主循环继续按普通键解析）。
   * @param {boolean} isFlush 是否处于 flush 结算阶段（此时不再等待补齐）
   */
  function matchEscape(isFlush) {
    if (buf.length < 2) {
      if (isFlush) {
        buf.shift();
        return { key: { type: 'escape' } };
      }
      return { wait: true };
    }
    const kind = buf[1];
    if (kind !== 0x5b /* [ */ && kind !== 0x4f /* O */) {
      // ESC + 普通字节：视为孤立 ESC（或 Alt 组合前缀），仅消费 ESC
      buf.shift();
      return { key: { type: 'escape' } };
    }
    if (kind === 0x5b) {
      // CSI 序列：扫描参数区（数字与 ;<=>?）直至终结字节（0x40–0x7E）
      let i = 2;
      while (i < buf.length && !(buf[i] >= 0x40 && buf[i] <= 0x7e)) i++;
      if (i >= buf.length) {
        if (isFlush) {
          buf.length = 0; // 未知且无法补齐的序列前缀：整体丢弃
          return {};
        }
        return { wait: true };
      }
      const final = String.fromCharCode(buf[i]);
      const params = String.fromCharCode(...buf.slice(2, i));
      buf.splice(0, i + 1);
      if (final === 'A') return { key: { type: 'arrow', dir: 'up' } };
      if (final === 'B') return { key: { type: 'arrow', dir: 'down' } };
      if (final === 'C') return { key: { type: 'arrow', dir: 'right' } };
      if (final === 'D') return { key: { type: 'arrow', dir: 'left' } };
      if (final === 'H') return { key: { type: 'home' } };
      if (final === 'F') return { key: { type: 'end' } };
      if (final === '~') {
        const n = parseInt(params, 10);
        if (n === 1 || n === 7) return { key: { type: 'home' } };
        if (n === 4 || n === 8) return { key: { type: 'end' } };
        if (n === 5) return { key: { type: 'page', dir: 'up' } };
        if (n === 6) return { key: { type: 'page', dir: 'down' } };
        if (n === 3) return { key: { type: 'delete' } };
        return {}; // 2（Insert）等未知波浪号序列：丢弃
      }
      return {}; // 未知 CSI 序列：丢弃
    }
    // SS3（ESC O P/Q/R/S → F1–F4；其余丢弃）
    if (buf.length < 3) {
      if (isFlush) {
        buf.length = 0;
        return {};
      }
      return { wait: true };
    }
    const c = String.fromCharCode(buf[2]);
    buf.splice(0, 3);
    if (c >= 'P' && c <= 'S') return { key: { type: 'function', n: c.charCodeAt(0) - 'P'.charCodeAt(0) + 1 } };
    return {};
  }

  /**
   * 主解析循环：尽可能多地消费缓冲并产出 Key。
   * @param {boolean} isFlush flush 阶段：不完整前缀直接丢弃而不是等待
   * @returns {Key[]}
   */
  function parse(isFlush) {
    /** @type {Key[]} */
    const keys = [];
    while (buf.length > 0) {
      const b = buf[0];
      if (b === 0x1b) {
        const r = matchEscape(isFlush);
        if (r.key) keys.push(r.key);
        if (r.wait) break;
        continue;
      }
      const single = SINGLE_KEYS.get(b);
      if (single) {
        buf.shift();
        keys.push(single);
        continue;
      }
      if (b < 0x20 || b === 0x7f || b === 0x00) {
        buf.shift(); // 其它控制键（含 ctrl+space 的 \x00）：丢弃
        continue;
      }
      const need = utf8SeqLen(b);
      if (need === 0) {
        buf.shift(); // 无效首字节：丢弃
        continue;
      }
      if (buf.length < need) {
        if (isFlush) buf.length = 0; // 残缺 UTF-8 前缀：丢弃
        break;
      }
      const seq = buf.splice(0, need);
      const ch = utf8Decoder.decode(Uint8Array.from(seq));
      if (ch && ch !== '\ufffd') keys.push({ type: 'printable', ch });
    }
    return keys;
  }

  return {
    /** 送入一段原始字节，返回本段内已可完整解码的按键（可能为空数组）。 */
    feed(bytes) {
      if (!bytes || !bytes.length) return [];
      for (let i = 0; i < bytes.length; i++) buf.push(bytes[i]);
      return parse(false);
    },
    /** 空闲结算：把无法继续补齐的缓冲内容按孤立 ESC / 丢弃处理并清空。 */
    flush() {
      return parse(true);
    },
  };
}
