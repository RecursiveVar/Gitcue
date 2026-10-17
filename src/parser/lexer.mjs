// src/parser/lexer.mjs —— 词法分析（叶子库，零内部依赖）
// 按 shell 规则切分输入行，识别"活动词"（光标所在未完成词）。
//
// 规则要点：
// 1. 以空格/制表符分隔 Token；反斜杠转义下一字符（含空格）；
//    "..." 与 '...' 引号内（含被转义的引号）合并为一个 Token（quoted:true，text 为去引号内容）。
// 2. 未闭合的引号/悬垂反斜杠按"到行尾为止"容错处理，绝不抛异常。
// 3. 光标所在词为活动词 active：光标位于词内（含词首）或紧贴词尾且其后无空格时
//    active=该词；否则 active=null 表示"新词"（如 `git push ` 光标在尾随空格后）。
//    活动词【不进入 tokens】，永不参与语法匹配，只用于候选前缀过滤。
// 4. `--` 精确 Token 由 separatorSeen 标记；`--opt=value` 不在词法层拆分（由匹配层拆）。

/**
 * 词法 Token。
 * @typedef {object} LexToken
 * @property {string} text    去除引号/转义后的文本
 * @property {number} start   行内起始字符偏移（含引号本身）
 * @property {number} end     行内结束偏移（开区间，指向词后首字符）
 * @property {boolean} quoted 是否经历过引号包裹
 */

/** 空格字符集合（空格与制表符） */
function isSpace(ch) {
  return ch === ' ' || ch === '\t';
}

/**
 * 词法切分。
 * @param {string} line   输入行（单行；多行/续行输入延后）
 * @param {number} [cursor] 光标偏移 0..line.length，默认行尾
 * @returns {{ tokens: LexToken[], active: LexToken|null, separatorSeen: boolean }}
 *    tokens：全部【已完成】Token（活动词不含在内）；
 *    active：活动词（可为 null）；
 *    separatorSeen：已完成 Token 中是否出现精确的 `--` 分隔符
 */
export function tokenize(line, cursor = line.length) {
  // 光标钳制到 [0, line.length]（防御：契约示例与真实终端都不会越界，越界按行尾处理）
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
  if (cursor > line.length) cursor = line.length;
  const tokens = [];
  let active = null;

  let i = 0;
  const n = line.length;
  while (i < n) {
    // 跳过词间空白
    if (isSpace(line[i])) {
      i += 1;
      continue;
    }
    // 开始扫描一个词
    const start = i;
    let text = '';
    let quoted = false;
    let closed = true; // 引号是否全部闭合（未闭合也容错成词）
    while (i < n) {
      const ch = line[i];
      if (ch === '\\') {
        // 反斜杠转义下一字符（含空格与引号）；行尾悬垂反斜杠按字面量处理
        if (i + 1 < n) {
          text += line[i + 1];
          i += 2;
        } else {
          text += '\\';
          i += 1;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        // 引号内合并为一个 Token；单引号内反斜杠不转义（对齐 POSIX 习惯），
        // 双引号内仅 \" 与 \\ 生效，其余反斜杠按字面量保留。
        quoted = true;
        const quote = ch;
        i += 1;
        let innerDone = false;
        while (i < n && !innerDone) {
          const c = line[i];
          if (c === quote) {
            i += 1;
            innerDone = true;
            break;
          }
          if (quote === '"' && c === '\\') {
            if (i + 1 < n && (line[i + 1] === '"' || line[i + 1] === '\\')) {
              text += line[i + 1];
              i += 2;
            } else {
              text += '\\';
              i += 1;
            }
          } else {
            text += c;
            i += 1;
          }
        }
        if (!innerDone) {
          closed = false; // 未闭合引号：吞到行尾，容错
        }
        continue;
      }
      if (isSpace(ch)) {
        break; // 词结束
      }
      text += ch;
      i += 1;
    }
    const end = i;
    const tok = { text, start, end, quoted };
    // 活动词判定：光标位于词内 [start, end]，其中紧贴词尾（cursor===end）时
    // 要求其后无空白（实际等价于 end===line.length，因为词只在空白/行尾处结束）。
    const cursorInside = cursor >= start && cursor <= end;
    const atEndFollowedBySpace = cursor === end && end < n && isSpace(line[end]);
    if (cursorInside && !atEndFollowedBySpace) {
      active = tok; // 光标仍在编辑该词 → 活动词，不进入 tokens
    } else {
      tokens.push(tok);
    }
  }

  const separatorSeen = tokens.some((t) => t.text === '--');
  return { tokens, active, separatorSeen };
}
