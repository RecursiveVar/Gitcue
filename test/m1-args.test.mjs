/**
 * CLI 参数解析与帮助文本单元测试。
 * 覆盖：参数表全形态解析；非法 flag/--lang 值 → errors；VERSION。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { VERSION, parseArgs, buildHelpText, SUPPORTED_LANGS } from '../src/cli/args.mjs';

describe('VERSION', () => {
  test('常量为 0.1.0 且与 package.json version 一致', () => {
    assert.equal(VERSION, '0.1.0');
    const pkg = JSON.parse(
      readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    );
    assert.equal(VERSION, pkg.version);
  });

  test('支持语言表为 zh-CN 与 en-US', () => {
    assert.deepEqual(SUPPORTED_LANGS, ['zh-CN', 'en-US']);
  });
});

describe('parseArgs 基本形态', () => {
  test('无参数 → REPL 模式', () => {
    const r = parseArgs([]);
    assert.equal(r.mode, 'repl');
    assert.equal(r.commandLine, null);
    assert.equal(r.exec, false);
    assert.equal(r.plain, false);
    assert.equal(r.strict, false);
    assert.equal(r.lang, null);
    assert.equal(r.debug, false);
    assert.deepEqual(r.errors, []);
  });

  test('单个位置参数 → 单次模式，命令行原样保留', () => {
    const r = parseArgs(['git log --oneline -5']);
    assert.equal(r.mode, 'once');
    assert.equal(r.commandLine, 'git log --oneline -5');
  });

  test('flags 与位置参数顺序随意', () => {
    const r = parseArgs(['--plain', 'git status', '--strict', '--exec']);
    assert.equal(r.mode, 'once');
    assert.equal(r.commandLine, 'git status');
    assert.equal(r.plain, true);
    assert.equal(r.strict, true);
    assert.equal(r.exec, true);
  });

  test('--debug / --plain / --strict / --exec 均可独立出现', () => {
    for (const flag of ['--debug', '--plain', '--strict', '--exec']) {
      const r = parseArgs([flag]);
      assert.equal(r.mode, 'repl', flag);
      assert.equal(r.errors.length, 0, flag);
    }
    const r = parseArgs(['--debug']);
    assert.equal(r.debug, true);
  });

  test('--help 与 -h → help 模式', () => {
    assert.equal(parseArgs(['--help']).mode, 'help');
    assert.equal(parseArgs(['-h']).mode, 'help');
  });

  test('--version 与 -V → version 模式', () => {
    assert.equal(parseArgs(['--version']).mode, 'version');
    assert.equal(parseArgs(['-V']).mode, 'version');
  });

  test('help 优先于位置参数与 version', () => {
    assert.equal(parseArgs(['--help', 'git log']).mode, 'help');
    assert.equal(parseArgs(['--version', '--help']).mode, 'help');
    assert.equal(parseArgs(['--version', 'git log']).mode, 'version');
  });

  test('validate-data / config 子命令', () => {
    assert.equal(parseArgs(['validate-data']).mode, 'validate-data');
    assert.equal(parseArgs(['config']).mode, 'config');
    // 与 flags 组合
    assert.equal(parseArgs(['--debug', 'validate-data']).mode, 'validate-data');
  });

  test('--reset-usage → reset-usage 模式；位置参数优先于它', () => {
    assert.equal(parseArgs(['--reset-usage']).mode, 'reset-usage');
    const r = parseArgs(['--reset-usage', 'git log']);
    assert.equal(r.mode, 'once');
    assert.equal(r.commandLine, 'git log');
  });

  test('--lang 接受合法值并可与任意模式组合', () => {
    const r = parseArgs(['--lang', 'en-US']);
    assert.equal(r.lang, 'en-US');
    assert.equal(r.mode, 'repl');
    const r2 = parseArgs(['--lang', 'zh-CN', 'git st']);
    assert.equal(r2.lang, 'zh-CN');
    assert.equal(r2.mode, 'once');
  });

  test('"--" 之后的内容按位置参数处理（CLI 惯例）', () => {
    const r = parseArgs(['--', '--plain']);
    assert.equal(r.mode, 'once');
    assert.equal(r.commandLine, '--plain');
    assert.equal(r.plain, false);
  });

  test('单个 "-" 视为位置参数而非 flag', () => {
    const r = parseArgs(['-']);
    assert.equal(r.mode, 'once');
    assert.equal(r.commandLine, '-');
  });

  test('重复 flag 幂等', () => {
    const r = parseArgs(['--plain', '--plain']);
    assert.equal(r.plain, true);
    assert.equal(r.errors.length, 0);
  });
});

describe('parseArgs 用法错误（errors 非空 → 调用方 exit 2）', () => {
  test('未知长 flag', () => {
    const r = parseArgs(['--bogus']);
    assert.equal(r.errors.length, 1);
    assert.ok(r.errors[0].includes('--bogus'), r.errors[0]);
  });

  test('未知短 flag', () => {
    const r = parseArgs(['-x']);
    assert.equal(r.errors.length, 1);
    assert.ok(r.errors[0].includes('-x'));
  });

  test('--lang=xx 形式不支持（值需空格分隔）→ 未知参数', () => {
    const r = parseArgs(['--lang=en-US']);
    assert.equal(r.errors.length, 1);
    assert.ok(r.errors[0].includes('--lang=en-US'));
  });

  test('--lang 缺值', () => {
    const r = parseArgs(['--lang']);
    assert.equal(r.errors.length, 1);
    assert.ok(r.errors[0].includes('--lang'));
  });

  test('--lang 值非法', () => {
    const r = parseArgs(['--lang', 'fr']);
    assert.equal(r.errors.length, 1);
    assert.ok(r.errors[0].includes('fr'));
    assert.equal(r.lang, null);
  });

  test('多个位置参数 → errors', () => {
    const r = parseArgs(['git log', 'extra']);
    assert.equal(r.errors.length, 1);
    assert.ok(r.errors[0].includes('2'));
  });

  test('子命令后多余位置参数 → errors', () => {
    const r = parseArgs(['validate-data', 'extra']);
    assert.equal(r.errors.length, 1);
  });

  test('有错误时其余参数仍被解析（错误信息完整收集）', () => {
    const r = parseArgs(['--plain', '--bogus', '--lang', 'xx']);
    assert.equal(r.plain, true);
    assert.equal(r.errors.length, 2);
  });
});

describe('buildHelpText', () => {
  test('zh-CN：包含用法、参数表与快捷键摘要', () => {
    const s = buildHelpText('zh-CN');
    assert.ok(s.includes('用法'), '应含“用法”');
    assert.ok(s.includes('gitcue "<命令行>"'), '应含单次模式用法');
    assert.ok(s.includes('--exec'));
    assert.ok(s.includes('--plain'));
    assert.ok(s.includes('--strict'));
    assert.ok(s.includes('--lang'));
    assert.ok(s.includes('validate-data'));
    assert.ok(s.includes('config'));
    assert.ok(s.includes('--reset-usage'));
    assert.ok(s.includes('Tab 补全'), '应含快捷键摘要');
    assert.ok(s.includes(VERSION), '应含版本号');
  });

  test('en-US：对应英文文案', () => {
    const s = buildHelpText('en-US');
    assert.ok(s.includes('Usage:'));
    assert.ok(s.includes('validate-data'));
    assert.ok(s.includes('Tab complete'));
  });

  test('未知语言回退 zh-CN', () => {
    assert.equal(buildHelpText('fr'), buildHelpText('zh-CN'));
  });

  test('同参数输出字节稳定（两次构建一致）', () => {
    assert.equal(buildHelpText('zh-CN'), buildHelpText('zh-CN'));
  });
});
