// test/m2-loader-validate.test.mjs —— 知识库 loader/validate 单元测试
// 覆盖：全量载入与 syntaxFull 预生成；自定义目录覆盖与新增；schemaVersion 不兼容跳过+告警；
// 损坏 JSON 跳过不崩溃；内置 command 与文件名不一致跳过；validateData 对合法内置数据 ok、
// 对损坏夹具目录报 error。git -h 离线比对由 data-*.test.mjs 承担，此处不重复。
//
// 安全边界：夹具一律位于本模块独占沙箱 .sandbox/m2/；GITCUE_HOME 指向 .sandbox/m2/home。

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadKnowledgeBase, SUPPORTED_SCHEMA } from '../src/kb/loader.mjs';
import { validateData } from '../src/kb/validate.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SB = path.join(ROOT, '.sandbox', 'm2');
const HOME = path.join(ROOT, '.sandbox', 'home', 'm2'); // GITCUE_HOME 统一位于 .sandbox/home/ 下
const CUSTOM = path.join(SB, 'custom');

before(() => {
  mkdirSync(HOME, { recursive: true });
  process.env.GITCUE_HOME = HOME;
  assert.ok(path.resolve(HOME).startsWith(path.resolve(ROOT)), '沙箱越界');
});

/** 重建自定义夹具目录 */
function freshCustom() {
  rmSync(CUSTOM, { recursive: true, force: true });
  mkdirSync(CUSTOM, { recursive: true });
  return CUSTOM;
}

describe('m2-loader 基础加载', () => {
  test('全量载入内置 25 命令，names/get/syntaxFull 就绪', () => {
    const kb = loadKnowledgeBase({ dataDir: DATA_DIR, customDir: null });
    assert.deepEqual(kb.warnings, [], `不应有告警：${kb.warnings.join('；')}`);
    assert.equal(kb.names().length, 25, 'v0.1 清单 25 命令（含 rebase）');
    for (const name of ['log', 'rebase', 'stash', 'mv']) {
      const e = kb.get(name);
      assert.ok(e, `缺少 ${name}`);
      assert.ok(e.compiled && e.compiled.patterns.length > 0, `${name} 应已编译`);
      assert.ok(e.syntaxFull.startsWith(`git ${name}`), `${name} 的完整骨架应以 "git ${name}" 开头`);
    }
    assert.equal(kb.schemaVersion, `${SUPPORTED_SCHEMA.major}.${SUPPORTED_SCHEMA.minor}`);
  });

  test('dataDir 直接指向条目目录（无 commands/ 子目录）也被接受', () => {
    const kb = loadKnowledgeBase({ dataDir: path.join(DATA_DIR, 'commands') });
    assert.ok(kb.names().includes('log'));
  });
});

describe('m2-loader 自定义目录', () => {
  test('同名覆盖内置、新增命令并入', () => {
    const dir = freshCustom();
    writeFileSync(
      path.join(dir, 'log.json'),
      JSON.stringify({
        schemaVersion: '1.0',
        command: 'log',
        category: 'porcelain',
        popularity: 5,
        summary: '自定义覆盖的 log',
        grammar: [
          { type: 'option', key: '--oneline', popularity: 5, summary: '单行显示（自定义）' },
        ],
      }),
      'utf8',
    );
    writeFileSync(
      path.join(dir, 'mytool.json'),
      JSON.stringify({
        schemaVersion: '1.0',
        command: 'mytool',
        category: 'plumbing',
        popularity: 1,
        summary: '自定义新命令',
        grammar: [{ type: 'option', key: '--x', popularity: 1, summary: '示例选项' }],
      }),
      'utf8',
    );
    const kb = loadKnowledgeBase({ dataDir: DATA_DIR, customDir: dir });
    assert.equal(kb.get('log').summary, '自定义覆盖的 log', '同名应覆盖内置');
    assert.equal(kb.get('log').grammar.length, 1, '覆盖即整体替换');
    assert.ok(kb.names().includes('mytool'), '新增命令应并入');
    assert.equal(kb.names().length, 26);
  });

  test('schemaVersion 大版本不兼容 → 跳过 + 告警', () => {
    const dir = freshCustom();
    writeFileSync(
      path.join(dir, 'future.json'),
      JSON.stringify({
        schemaVersion: '2.0',
        command: 'future',
        summary: 'x',
        grammar: [{ type: 'option', key: '--x', popularity: 1, summary: 'x' }],
      }),
      'utf8',
    );
    const kb = loadKnowledgeBase({ dataDir: DATA_DIR, customDir: dir });
    assert.equal(kb.get('future'), undefined, '不兼容条目应跳过');
    assert.ok(kb.warnings.some((w) => w.includes('schema 大版本不兼容')), kb.warnings.join('；'));
  });

  test('损坏 JSON 与 command/文件名不一致 → 跳过不崩溃', () => {
    const dir = freshCustom();
    writeFileSync(path.join(dir, 'broken.json'), '{ not json', 'utf8');
    const kb = loadKnowledgeBase({ dataDir: DATA_DIR, customDir: dir });
    assert.equal(kb.get('broken'), undefined);
    assert.ok(kb.warnings.some((w) => w.includes('broken.json')), '损坏文件应有告警');
    assert.ok(kb.names().includes('log'), '其余条目不受影响');
  });
});

describe('m2-validate validateData', () => {
  test('内置 25 条全部通过，ok=true', () => {
    const res = validateData({ dataDir: DATA_DIR, customDir: null });
    assert.equal(res.ok, true, `错误：${res.errors.map((e) => `${e.file} ${e.path}: ${e.message}`).join('；')}`);
    assert.equal(res.passed, 25);
  });

  test('夹具目录的各类违规被逐一报错', () => {
    const dir = freshCustom();
    writeFileSync(
      path.join(dir, 'bad.json'),
      JSON.stringify({
        schemaVersion: '1.0',
        command: 'BadName', // 命令名非法（条目级快速失败）
        summary: 'x',
        grammar: [{ type: 'option', key: '--x', popularity: 1, summary: 'x' }],
      }),
      'utf8',
    );
    writeFileSync(
      path.join(dir, 'patternbad.json'),
      JSON.stringify({
        schemaVersion: '1.0',
        command: 'patternbad',
        popularity: 3,
        summary: 'pattern 级违规',
        grammar: [{ type: 'option', key: 'not-an-option', popularity: 9, summary: '' }],
      }),
      'utf8',
    );
    writeFileSync(
      path.join(dir, 'conflict.json'),
      JSON.stringify({
        schemaVersion: '1.0',
        command: 'conflict',
        popularity: 3,
        summary: '占名冲突',
        grammar: [
          { type: 'option', key: '--x', popularity: 1, summary: '选项一' },
          { type: 'option', key: '--x', aliases: ['-y'], popularity: 1, summary: '同名选项' },
        ],
      }),
      'utf8',
    );
    const res = validateData({ dataDir: dir, customDir: null });
    assert.equal(res.ok, false);
    const msgs = res.errors.map((e) => e.message).join('\n');
    assert.match(msgs, /命令名非法/);
    assert.match(msgs, /应为 1–5 整数/);
    assert.match(msgs, /key 格式非法/);
    assert.match(msgs, /必填且为非空字符串/);
    assert.match(msgs, /占名「--x」同时属于/);
    assert.equal(res.passed, 0);
  });
});
