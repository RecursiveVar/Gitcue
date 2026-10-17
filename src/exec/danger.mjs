/**
 * 高危命令一次性警示。
 *
 * 只提示、不拦截（执行与否由用户决定）。
 * 文案取 i18n danger.* 值（zh-CN 为准，en-US 见 src/i18n.mjs）。
 */

import { t } from '../i18n.mjs';

/** tokens 是否包含某个裸 flag（严格等值匹配，不做前缀推断） */
const has = (tokens, flag) => tokens.includes(flag);

/**
 * 展开 POSIX 风格组合短选项：'-fd' → ['-f', '-d']，'-df' → ['-d', '-f']。
 * 仅展开小写字母组合且整体以单个 '-' 开头的形式；'-f' 等单字符原样返回。
 * @param {string} tok
 * @returns {string[]}
 */
function expandCombined(tok) {
  if (typeof tok !== 'string' || !/^-[a-z]{2,}$/.test(tok)) return typeof tok === 'string' ? [tok] : [];
  return [...tok.slice(1)].map((c) => `-${c}`);
}

/**
 * 高危检测。
 * @param {string[]} tokens 完整词法 Token 文本数组（不含行首 'git'）
 * @returns {{ message: string } | null} 命中返回警示文案；否则 null
 */
export function detectDanger(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  const [head, ...rest] = tokens;
  const all = rest.flatMap(expandCombined); // 展开后统一判定，'-fd' 与 '-f -d' 等价

  switch (head) {
    case 'push': {
      // --force 或 -f，但 --force-with-lease 除外（其前缀含 --force，须显式排除）
      const forced =
        (has(rest, '--force') || has(rest, '-f')) && !rest.some((s) => s.startsWith('--force-with-lease'));
      if (forced) return { message: t('zh-CN', 'danger.push_force') };
      return null;
    }
    case 'reset':
      if (has(rest, '--hard')) return { message: t('zh-CN', 'danger.reset_hard') };
      return null;
    case 'clean': {
      const forced = has(all, '-f') || has(rest, '--force');
      const dirs = has(all, '-d');
      if (forced && dirs) return { message: t('zh-CN', 'danger.clean_fd') };
      return null;
    }
    case 'branch': {
      if (has(rest, '-D')) return { message: t('zh-CN', 'danger.branch_D') };
      if (has(rest, '--delete') && (has(rest, '--force') || has(all, '-f'))) {
        return { message: t('zh-CN', 'danger.branch_D') };
      }
      return null;
    }
    default:
      return null;
  }
}
