/**
 * i18n / 使用频率统计 / 日志单元测试。
 * 覆盖：zh-CN 全键非空；en-US 回退；params 插值；
 * usage bump/count/reset/防抖落盘（GITCUE_HOME→.sandbox）；日志级别与 stderr。
 */

import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { MESSAGES, t } from '../src/i18n.mjs';
import { createUsage } from '../src/usage.mjs';
import { createLogger } from '../src/log.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const SB = path.join(ROOT, '.sandbox', 'm1');

// —— 安全自检：涉及用户数据的测试必须先固定 GITCUE_HOME 到沙箱 ——
before(() => {
  process.env.GITCUE_HOME = path.join(SB, 'home');
  const resolved = path.resolve(process.env.GITCUE_HOME);
  assert.ok(
    resolved.startsWith(path.resolve(ROOT)),
    `GITCUE_HOME 必须位于工作区沙箱内，实际：${resolved}`,
  );
});

/** 建立独占用例目录 */
function freshCase(name) {
  const dir = path.join(SB, 'home', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 捕获 stderr 输出（log.mjs 在调用点动态查找 process.stderr.write） */
function captureStderr(fn) {
  const orig = process.stderr.write;
  let buf = '';
  process.stderr.write = (chunk) => {
    buf += String(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return buf;
}

describe('i18n', () => {
  /** 界面文案要求存在的 i18n 键 */
  const REQUIRED_KEYS = [
    'ui.title',
    'ui.prompt',
    'ui.zone.syntax',
    'ui.zone.candidates',
    'ui.zone.detail',
    'ui.syntax.guide',
    'ui.syntax.uncovered',
    'ui.loading',
    'ui.notrepo',
    'ui.didyoumean',
    'ui.nosummary',
    'ui.exit.ok',
    'ui.exit.fail',
    'ui.running',
    'ui.hintbar',
    'ui.guide.1',
    'ui.guide.2',
    'ui.guide.3',
    'ui.guide.4',
    'ui.guide.5',
    'ui.since',
    'ui.warn.enum',
    'danger.push_force',
    'danger.reset_hard',
    'danger.clean_fd',
    'danger.branch_D',
  ];

  test('zh-CN 为基准语言且全键非空', () => {
    assert.ok(MESSAGES['zh-CN'], 'zh-CN 必须存在');
    for (const key of REQUIRED_KEYS) {
      const v = MESSAGES['zh-CN'][key];
      assert.ok(typeof v === 'string' && v.length > 0, `zh-CN 键 "${key}" 缺失或为空`);
    }
  });

  test('en-US 覆盖全部 zh-CN 键（界面框架文案）', () => {
    assert.ok(MESSAGES['en-US']);
    const zhKeys = Object.keys(MESSAGES['zh-CN']).sort();
    const enKeys = Object.keys(MESSAGES['en-US']).sort();
    assert.deepEqual(enKeys, zhKeys, 'en-US 与 zh-CN 键集必须一致');
    for (const [k, v] of Object.entries(MESSAGES['en-US'])) {
      assert.ok(typeof v === 'string' && v.length > 0, `en-US 键 "${k}" 为空`);
    }
  });

  test('zh-CN 键值抽样锚点（逐字断言）', () => {
    assert.equal(t('zh-CN', 'ui.prompt'), 'git> ');
    assert.equal(t('zh-CN', 'ui.syntax.guide'), '输入子命令，↓ 浏览全部');
    assert.equal(t('zh-CN', 'ui.syntax.uncovered'), 'git <command> [args...]（未收录，直接执行）');
    assert.equal(t('zh-CN', 'ui.nosummary'), '（暂无说明）');
    assert.equal(t('zh-CN', 'ui.hintbar'), 'Tab 补全 │ ↑↓ 选择 │ F1 详情 │ Enter 执行 │ Esc 清空 │ Ctrl+Q 退出');
    assert.equal(t('zh-CN', 'danger.push_force'), '⚠ 强制推送将覆盖远端历史');
    assert.equal(t('zh-CN', 'danger.reset_hard'), '⚠ --hard 将丢弃未提交改动');
    assert.equal(t('zh-CN', 'danger.clean_fd'), '⚠ 将删除未跟踪的文件与目录');
    assert.equal(t('zh-CN', 'danger.branch_D'), '⚠ 将强制删除分支');
  });

  test('params 插值 {x}', () => {
    assert.equal(t('zh-CN', 'ui.exit.fail', { code: 128 }), '✘ exit 128');
    assert.equal(t('zh-CN', 'ui.exit.ok', { code: 0 }), '✔ exit 0');
    assert.equal(t('zh-CN', 'ui.didyoumean', { s: 'checkout' }), 'Did you mean: checkout? (Tab 采纳)');
    assert.equal(t('zh-CN', 'ui.since', { v: '2.23' }), '（需 git ≥ 2.23）');
  });

  test('缺失的插值参数原样保留占位符', () => {
    assert.equal(t('zh-CN', 'ui.since', {}), '（需 git ≥ {v}）');
  });

  test('未知语言回退 zh-CN', () => {
    assert.equal(t('fr-FR', 'ui.prompt'), t('zh-CN', 'ui.prompt'));
  });

  test('缺键：en-US 缺键回退 zh-CN，仍缺返回键名本身（不抛错）', () => {
    // 临时摘除 en-US 的一个键以构造真实缺键路径（结束后恢复）
    const key = 'ui.loading';
    const saved = MESSAGES['en-US'][key];
    delete MESSAGES['en-US'][key];
    try {
      assert.equal(t('en-US', key), MESSAGES['zh-CN'][key], 'en-US 缺键应回退 zh-CN');
    } finally {
      MESSAGES['en-US'][key] = saved;
    }
    // 两表都缺 → 返回键名本身
    assert.equal(t('zh-CN', 'no.such.key'), 'no.such.key');
    assert.equal(t('en-US', 'no.such.key'), 'no.such.key');
    assert.equal(t('fr', 'no.such.key'), 'no.such.key');
  });
});

describe('usage 使用频率统计', () => {
  test('count 未记录键返回 0；文件不存在不报错', () => {
    const home = freshCase('usage-basic');
    const u = createUsage({ file: path.join(home, 'usage.json') });
    assert.equal(u.count('cmd:rebase'), 0);
    assert.deepEqual(u.all(), {});
  });

  test('bump 内存计数；flush 落盘为约定 JSON 格式', () => {
    const home = freshCase('usage-flush');
    const file = path.join(home, 'usage.json');
    const u = createUsage({ file });
    u.bump('cmd:rebase');
    u.bump('cmd:rebase');
    u.bump('opt:log:opt:--oneline');
    assert.equal(u.count('cmd:rebase'), 2);
    assert.equal(existsSync(file), false, '防抖期内不应落盘');
    u.flush();
    assert.equal(existsSync(file), true);
    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(persisted.version, 1);
    assert.deepEqual(persisted.counts, { 'cmd:rebase': 2, 'opt:log:opt:--oneline': 1 });
  });

  test('落盘文件可被新实例读取（跨会话累积）', () => {
    const home = freshCase('usage-reload');
    const file = path.join(home, 'usage.json');
    const u1 = createUsage({ file });
    u1.bump('cmd:log');
    u1.flush();
    const u2 = createUsage({ file });
    assert.equal(u2.count('cmd:log'), 1);
    u2.bump('cmd:log');
    u2.flush();
    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(persisted.counts['cmd:log'], 2);
  });

  test('reset 清空内存并删除文件', () => {
    const home = freshCase('usage-reset');
    const file = path.join(home, 'usage.json');
    const u = createUsage({ file });
    u.bump('dyn:branch:main');
    u.flush();
    assert.equal(existsSync(file), true);
    u.reset();
    assert.equal(existsSync(file), false, 'reset 应删除统计文件');
    assert.equal(u.count('dyn:branch:main'), 0);
    assert.deepEqual(u.all(), {});
    u.flush(); // reset 后 flush 写出空统计
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).counts, {});
  });

  test('reset 对不存在的文件不报错', () => {
    const home = freshCase('usage-reset-missing');
    const u = createUsage({ file: path.join(home, 'usage.json') });
    u.reset();
    assert.equal(existsSync(path.join(home, 'usage.json')), false);
  });

  test('损坏的统计文件视为空统计（不抛错）', () => {
    const home = freshCase('usage-corrupt');
    const file = path.join(home, 'usage.json');
    writeFileSync(file, 'not a json {{{', 'utf8');
    const u = createUsage({ file });
    assert.equal(u.count('cmd:rebase'), 0);
    u.bump('cmd:rebase');
    u.flush();
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).counts['cmd:rebase'], 1);
  });

  test('防抖 2s 后自动落盘（尾沿触发）', async () => {
    const home = freshCase('usage-debounce');
    const file = path.join(home, 'usage.json');
    const u = createUsage({ file });
    u.bump('cmd:status');
    assert.equal(existsSync(file), false, '刚 bump 不应有文件');
    await new Promise((resolve) => setTimeout(resolve, 2300)); // 等待防抖窗口（2s）+ 余量
    assert.equal(existsSync(file), true, '防抖到期应自动落盘');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).counts['cmd:status'], 1);
  });

  test('多键落盘按字典序排序（字节稳定）', () => {
    const home = freshCase('usage-sorted');
    const file = path.join(home, 'usage.json');
    const u = createUsage({ file });
    u.bump('dyn:branch:zzz');
    u.bump('cmd:aaa');
    u.bump('opt:x:opt:-i');
    u.flush();
    const keys = Object.keys(JSON.parse(readFileSync(file, 'utf8')).counts);
    assert.deepEqual(keys, [...keys].sort());
  });
});

describe('log 日志', () => {
  test('默认关闭（GITCUE_LOG 未设置）', () => {
    const log = createLogger({ env: {} });
    assert.equal(log.level, 'off');
    const out = captureStderr(() => {
      log.debug('d');
      log.info('i');
      log.error('e');
    });
    assert.equal(out, '');
  });

  test('GITCUE_LOG 非法值视为关闭', () => {
    assert.equal(createLogger({ env: { GITCUE_LOG: 'bogus' } }).level, 'off');
    assert.equal(createLogger({ env: { GITCUE_LOG: 'DEBUG' } }).level, 'debug', '大小写不敏感');
  });

  test('error 级别：仅 error 输出', () => {
    const log = createLogger({ env: { GITCUE_LOG: 'error' } });
    const out = captureStderr(() => {
      log.debug('D');
      log.info('I');
      log.error('E');
    });
    assert.ok(out.includes('[gitcue:error] E'));
    assert.ok(!out.includes('D'));
    assert.ok(!out.includes('I'));
  });

  test('info 级别：info 与 error 输出，debug 静默', () => {
    const log = createLogger({ env: { GITCUE_LOG: 'info' } });
    const out = captureStderr(() => {
      log.debug('D');
      log.info('I');
      log.error('E');
    });
    assert.ok(out.includes('[gitcue:info] I'));
    assert.ok(out.includes('[gitcue:error] E'));
    assert.ok(!out.includes('D'));
  });

  test('debug 级别：全量输出，附加数据以 JSON 序列化', () => {
    const log = createLogger({ env: { GITCUE_LOG: 'debug' } });
    const out = captureStderr(() => {
      log.debug('解析完成', { ms: 12, phase: 'options' });
    });
    assert.ok(out.includes('[gitcue:debug] 解析完成'));
    assert.ok(out.includes('"ms":12'));
    assert.ok(out.includes('"phase":"options"'));
  });

  test('forceDebug 覆盖环境（--debug 语义）', () => {
    const log = createLogger({ env: {}, forceDebug: true });
    assert.equal(log.level, 'debug');
    const out = captureStderr(() => log.debug('X'));
    assert.ok(out.includes('X'));
  });

  test('循环引用附加数据不抛错', () => {
    const log = createLogger({ env: { GITCUE_LOG: 'debug' } });
    const cyc = { self: null };
    cyc.self = cyc;
    const out = captureStderr(() => log.debug('cyc', cyc));
    assert.ok(out.includes('[gitcue:debug] cyc'));
  });
});
