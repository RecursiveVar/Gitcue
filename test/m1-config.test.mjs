/**
 * 配置加载单元测试。
 * 覆盖：默认值合并；用户级覆盖；项目级覆盖用户级；
 * 非法项 warning + 回退；mini-TOML 解析（注释/引号/整数/布尔/未知 key）；resolveHome。
 *
 * 安全边界：所有用户级文件写入 .sandbox/m1/home/<用例名>/（GITCUE_HOME 语义目录），
 * 绝不触碰真实用户主目录。
 */

import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG, loadConfig, parseToml, resolveHome } from '../src/config.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const SB = path.join(ROOT, '.sandbox', 'm1');

/** 建立独占用例目录（before 内清理重建） */
function freshCase(name) {
  const dir = path.join(SB, 'home', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

// —— 安全自检：涉及用户数据的测试必须先固定 GITCUE_HOME 到沙箱 ——
before(() => {
  process.env.GITCUE_HOME = path.join(SB, 'home');
  const resolved = path.resolve(process.env.GITCUE_HOME);
  assert.ok(
    resolved.startsWith(path.resolve(ROOT)),
    `GITCUE_HOME 必须位于工作区沙箱内，实际：${resolved}`,
  );
});

describe('resolveHome', () => {
  test('GITCUE_HOME 优先', () => {
    assert.equal(resolveHome({ GITCUE_HOME: 'D:/x/.gitcue' }), 'D:/x/.gitcue');
  });

  test('未设置时回退 ~/.gitcue（产品语义）', () => {
    assert.equal(resolveHome({}), path.join(os.homedir(), '.gitcue'));
    assert.equal(resolveHome({ GITCUE_HOME: '' }), path.join(os.homedir(), '.gitcue'));
  });
});

describe('parseToml（mini-TOML 标量子集）', () => {
  test('空文本与纯注释', () => {
    assert.deepEqual(parseToml(''), { values: {}, errors: [] });
    assert.deepEqual(parseToml('# 只有注释\n  \n# 另一行'), { values: {}, errors: [] });
  });

  test('三类标量：字符串 / 布尔 / 整数', () => {
    const { values, errors } = parseToml(
      'lang = "en-US"\nhistory_enabled = false\ncandidate_limit = 5\ndynamic_cache_seconds = 30\n',
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(values, {
      lang: 'en-US',
      history_enabled: false,
      candidate_limit: 5,
      dynamic_cache_seconds: 30,
    });
  });

  test('字符串转义：\\" 与 \\\\，其余转义非法', () => {
    const ok = parseToml('custom_command_dir = "a\\"b\\\\c"');
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.values.custom_command_dir, 'a"b\\c');
    const bad = parseToml('pager = "a\\nb"');
    assert.equal(bad.errors.length, 1);
    assert.ok(bad.errors[0].includes('pager'));
  });

  test('行内注释与字符串内的 # ', () => {
    const r = parseToml('pager = "less # 不是注释"  # 这才是注释\nhistory_limit = 100 # 整数后注释');
    assert.deepEqual(r.errors, []);
    assert.equal(r.values.pager, 'less # 不是注释');
    assert.equal(r.values.history_limit, 100);
  });

  test('未加引号的字符串值 → 解析错误', () => {
    const r = parseToml('lang = en-US');
    assert.equal(r.errors.length, 1);
    assert.deepEqual(r.values, {});
  });

  test('非法键名（前导连字符等）→ 解析错误；数字开头键按规范 [A-Za-z0-9_]+ 属合法键', () => {
    const r = parseToml('-lang = "x"');
    assert.equal(r.errors.length, 1);
    // 键字符集含数字：1lang 可解析，但不在合法配置项表中 → loadConfig 层报未知项
    const r2 = parseToml('1lang = "x"');
    assert.deepEqual(r2.errors, []);
    assert.deepEqual(r2.values, { '1lang': 'x' });
  });

  test('重复键 → 解析错误', () => {
    const r = parseToml('pager = "a"\npager = "b"');
    assert.equal(r.errors.length, 1);
    assert.ok(r.errors[0].includes('pager'));
    assert.equal(r.values.pager, 'a'); // 首次出现的值保留
  });

  test('未闭合字符串 → 解析错误', () => {
    const r = parseToml('pager = "less');
    assert.equal(r.errors.length, 1);
  });

  test('闭引号后有多余内容 → 解析错误', () => {
    const r = parseToml('pager = "less" extra');
    assert.equal(r.errors.length, 1);
  });

  test('CRLF 换行可解析', () => {
    const r = parseToml('lang = "en-US"\r\ncandidate_limit = 3\r\n');
    assert.deepEqual(r.errors, []);
    assert.equal(r.values.lang, 'en-US');
    assert.equal(r.values.candidate_limit, 3);
  });
});

describe('loadConfig 合并顺序与覆盖', () => {
  test('无任何文件 → 全默认值，files 为空', () => {
    const home = freshCase('defaults');
    const r = loadConfig({ env: { GITCUE_HOME: home }, cwd: path.join(SB, 'no-such-cwd') });
    assert.deepEqual(r.config, { ...DEFAULT_CONFIG });
    assert.deepEqual(r.files, []);
    assert.deepEqual(r.warnings, []);
  });

  test('用户级 config.toml 覆盖默认值', () => {
    const home = freshCase('user-override');
    writeFileSync(
      path.join(home, 'config.toml'),
      'lang = "en-US"\ncandidate_limit = 3\npager = "less"\n',
      'utf8',
    );
    const r = loadConfig({ env: { GITCUE_HOME: home }, cwd: path.join(SB, 'no-such-cwd') });
    assert.equal(r.config.lang, 'en-US');
    assert.equal(r.config.candidate_limit, 3);
    assert.equal(r.config.pager, 'less');
    assert.equal(r.config.history_limit, DEFAULT_CONFIG.history_limit); // 未覆盖项保持默认
    assert.equal(r.files.length, 1);
    assert.ok(r.files[0].includes(path.join(home, 'config.toml')));
  });

  test('项目级 .gitcue.toml 覆盖用户级；未覆盖项沿用用户级', () => {
    const home = freshCase('project-override');
    writeFileSync(path.join(home, 'config.toml'), 'lang = "en-US"\ncandidate_limit = 3\n', 'utf8');
    const cwd = path.join(SB, 'proj-override');
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(path.join(cwd, '.gitcue.toml'), 'candidate_limit = 5\ntheme = "contrast"\n', 'utf8');
    const r = loadConfig({ env: { GITCUE_HOME: home }, cwd });
    assert.equal(r.config.lang, 'en-US'); // 用户级生效
    assert.equal(r.config.candidate_limit, 5); // 项目级覆盖
    assert.equal(r.config.theme, 'contrast');
    assert.equal(r.files.length, 2); // 用户级在前、项目级在后
    assert.ok(r.files[0].endsWith('config.toml'));
    assert.ok(r.files[1].endsWith('.gitcue.toml'));
    rmSync(cwd, { recursive: true, force: true });
  });

  test('cliLang（--lang）优先级最高', () => {
    const home = freshCase('cli-lang');
    writeFileSync(path.join(home, 'config.toml'), 'lang = "zh-CN"\n', 'utf8');
    const r = loadConfig({ env: { GITCUE_HOME: home }, cwd: SB, cliLang: 'en-US' });
    assert.equal(r.config.lang, 'en-US');
    const r2 = loadConfig({ env: { GITCUE_HOME: home }, cwd: SB });
    assert.equal(r2.config.lang, 'zh-CN');
  });
});

describe('loadConfig 非法项告警并回退默认', () => {
  function loadWith(home, content) {
    writeFileSync(path.join(home, 'config.toml'), content, 'utf8');
    return loadConfig({ env: { GITCUE_HOME: home }, cwd: path.join(SB, 'no-such-cwd') });
  }

  test('未知 key → warning 并忽略', () => {
    const r = loadWith(freshCase('unknown-key'), 'foo_bar = 1\n');
    assert.equal(r.warnings.length, 1);
    assert.ok(r.warnings[0].includes('foo_bar'), r.warnings[0]);
    assert.equal('foo_bar' in r.config, false);
  });

  test('枚举值非法（lang/theme/enter_action）→ warning + 默认', () => {
    const r = loadWith(
      freshCase('bad-enum'),
      'lang = "fr"\ntheme = "dark"\nenter_action = "run"\n',
    );
    assert.equal(r.warnings.length, 3);
    assert.equal(r.config.lang, DEFAULT_CONFIG.lang);
    assert.equal(r.config.theme, DEFAULT_CONFIG.theme);
    assert.equal(r.config.enter_action, DEFAULT_CONFIG.enter_action);
  });

  test('类型不符（布尔给了字符串、整数给了字符串）→ warning + 默认', () => {
    const r = loadWith(freshCase('bad-type'), 'history_enabled = "yes"\ncandidate_limit = "8"\n');
    assert.equal(r.warnings.length, 2);
    assert.equal(r.config.history_enabled, DEFAULT_CONFIG.history_enabled);
    assert.equal(r.config.candidate_limit, DEFAULT_CONFIG.candidate_limit);
  });

  test('整数越界（candidate_limit=0、dynamic_cache_seconds=-1）→ warning + 默认', () => {
    const r = loadWith(freshCase('bad-range'), 'candidate_limit = 0\ndynamic_cache_seconds = -1\n');
    assert.equal(r.warnings.length, 2);
    assert.equal(r.config.candidate_limit, DEFAULT_CONFIG.candidate_limit);
    assert.equal(r.config.dynamic_cache_seconds, DEFAULT_CONFIG.dynamic_cache_seconds);
  });

  test('合法边界值被接受（candidate_limit=1、history_limit=1、dynamic_cache_seconds=0）', () => {
    const r = loadWith(freshCase('ok-range'), 'candidate_limit = 1\nhistory_limit = 1\ndynamic_cache_seconds = 0\n');
    assert.deepEqual(r.warnings, []);
    assert.equal(r.config.candidate_limit, 1);
    assert.equal(r.config.history_limit, 1);
    assert.equal(r.config.dynamic_cache_seconds, 0);
  });

  test('TOML 语法错误行 → warning 携带文件名与行号', () => {
    const home = freshCase('syntax-error');
    writeFileSync(path.join(home, 'config.toml'), 'lang = en-US\n', 'utf8');
    const r = loadConfig({ env: { GITCUE_HOME: home }, cwd: path.join(SB, 'no-such-cwd') });
    assert.equal(r.warnings.length, 1);
    assert.ok(r.warnings[0].includes('config.toml'), r.warnings[0]);
    assert.ok(r.warnings[0].includes('第 1 行'), r.warnings[0]);
    assert.equal(r.config.lang, DEFAULT_CONFIG.lang);
  });

  test('DEFAULT_CONFIG 为冻结对象（防误改默认值）', () => {
    assert.ok(Object.isFrozen(DEFAULT_CONFIG));
  });
});
