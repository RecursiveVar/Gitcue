// test/m6-exec-history.test.mjs —— 执行层与历史单元测试
// 覆盖：runner 退出码透传 / 环境注入 / cancel→130；gitVersion 探测与比较；danger 规则表全分支；
// history 连续去重 / 上限裁剪 / enabled=false 仅会话 / 持久化 JSONL。
//
// 安全边界：全部夹具位于本模块独占沙箱 .sandbox/m6/；子进程仅 node -e 内联脚本与只读
// git --version，不触碰任何仓库；GITCUE_HOME 指向 .sandbox/m6/home。

import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { createRunner } from '../src/exec/runner.mjs';
import { detectGitVersion, majorMinor, compareMajorMinor, meetsMinimum } from '../src/exec/gitVersion.mjs';
import { detectDanger } from '../src/exec/danger.mjs';
import { createHistory } from '../src/history.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SB = path.join(ROOT, '.sandbox', 'm6');
const HOME = path.join(ROOT, '.sandbox', 'home', 'm6'); // GITCUE_HOME 统一位于 .sandbox/home/ 下

before(() => {
  mkdirSync(HOME, { recursive: true });
  process.env.GITCUE_HOME = HOME;
  assert.ok(path.resolve(HOME).startsWith(path.resolve(ROOT)), '沙箱越界');
});

describe('m6-runner 透传执行', () => {
  test('退出码透传与 durationMs 计时', async () => {
    const runner = createRunner({ cwd: SB, env: process.env });
    const r = await runner.run('node -e "process.exit(7)"');
    assert.equal(r.code, 7);
    assert.ok(Number.isFinite(r.durationMs) && r.durationMs >= 0);
    assert.equal(runner.active(), false, '结束后应无活动子进程');
  });

  test('stdout 原样透传（继承到本进程stdout，仅验证不抛错与退出码 0）', async () => {
    const runner = createRunner({ cwd: SB, env: process.env });
    const r = await runner.run('node -e "process.stdout.write(\'m6-ok\')"');
    assert.equal(r.code, 0);
  });

  test('cancel：终止长命子进程，退出码 130', async () => {
    const runner = createRunner({ cwd: SB, env: process.env });
    const p = runner.run('node -e "setTimeout(() => process.exit(9), 30000)"');
    await new Promise((res) => setTimeout(res, 300)); // 等子进程起来
    assert.equal(runner.active(), true);
    assert.equal(runner.cancel(), true, '应已发送终止');
    const r = await p;
    assert.equal(r.code, 130, '被终止的子进程按 Ctrl+C 惯例码 130');
  });
});

describe('m6-gitVersion 探测与比较', () => {
  test('detectGitVersion：成功返回原样输出，失败返回 null', async () => {
    assert.equal(await detectGitVersion(async () => ({ code: 0, stdout: 'git version 2.55.0.windows.4\n', stderr: '' })), 'git version 2.55.0.windows.4');
    assert.equal(await detectGitVersion(async () => ({ code: -1, stdout: '', stderr: 'not found' })), null);
    assert.equal(await detectGitVersion(async () => { throw new Error('boom'); }), null, 'runGit 异常也应兜底为 null');
  });

  test('majorMinor / compareMajorMinor / meetsMinimum（最低 2.30）', () => {
    assert.deepEqual(majorMinor('2.55.0.windows.4'), [2, 55]);
    assert.deepEqual(majorMinor('git version 2.30'), [2, 30]);
    assert.equal(majorMinor('unknown'), null);
    assert.equal(compareMajorMinor([2, 20], [2, 30]) < 0, true);
    assert.equal(compareMajorMinor([2, 30], [2, 30]), 0);
    assert.equal(compareMajorMinor([3, 0], [2, 55]) > 0, true);
    assert.equal(meetsMinimum('2.20.1'), false);
    assert.equal(meetsMinimum('2.30.0'), true);
    assert.equal(meetsMinimum('2.55.0.windows.4'), true);
    assert.equal(meetsMinimum(null), true, '版本未知时宽松降级（不阻塞）');
  });

  test('真实 git --version 探测（只读，沙箱环境）', async () => {
    const { createGitQuery } = await import('../src/providers/gitQuery.mjs');
    const runGit = createGitQuery({ cwd: SB, env: process.env }).run;
    const v = await detectGitVersion(runGit);
    assert.ok(v === null || /^git version \d/.test(v), `实际值：${v}`);
  });
});

describe('m6-danger 规则表（只提示不拦截）', () => {
  test('push --force / -f 命中，--force-with-lease 除外', () => {
    assert.deepEqual(detectDanger(['push', '--force']), { message: '⚠ 强制推送将覆盖远端历史' });
    assert.deepEqual(detectDanger(['push', '-f', 'origin', 'main']), { message: '⚠ 强制推送将覆盖远端历史' });
    assert.equal(detectDanger(['push', '--force-with-lease', 'origin', 'main']), null);
    assert.equal(detectDanger(['push', 'origin', 'main']), null);
  });

  test('reset --hard / clean 强制+目录 / branch -D', () => {
    assert.deepEqual(detectDanger(['reset', '--hard', 'HEAD~1']), { message: '⚠ --hard 将丢弃未提交改动' });
    assert.deepEqual(detectDanger(['clean', '-fd']), { message: '⚠ 将删除未跟踪的文件与目录' });
    assert.deepEqual(detectDanger(['clean', '-f', '-d']), { message: '⚠ 将删除未跟踪的文件与目录' });
    assert.equal(detectDanger(['clean', '-f']), null, '只删文件不删目录不警示');
    assert.deepEqual(detectDanger(['branch', '-D', 'topic']), { message: '⚠ 将强制删除分支' });
    assert.deepEqual(detectDanger(['branch', '--delete', '--force', 'topic']), { message: '⚠ 将强制删除分支' });
    assert.equal(detectDanger(['branch', '-d', 'topic']), null);
  });

  test('安全命令与空输入返回 null', () => {
    assert.equal(detectDanger(['status']), null);
    assert.equal(detectDanger(['log', '--oneline']), null);
    assert.equal(detectDanger([]), null);
    assert.equal(detectDanger(null), null);
  });
});

describe('m6-history 会话与持久化', () => {
  /** 独立历史文件路径 */
  const histFile = (name) => {
    const dir = path.join(SB, 'hist', name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return path.join(dir, 'history.jsonl');
  };

  test('连续重复不入库；all() 最近在前', () => {
    const h = createHistory({ file: histFile('dedupe'), limit: 10 });
    h.load();
    h.push('git status');
    h.push('git status');
    h.push('git log --oneline');
    h.push('git log --oneline');
    h.push('git diff');
    assert.deepEqual(h.all(), ['git diff', 'git log --oneline', 'git status']);
  });

  test('上限裁剪最旧并持久化为 JSONL', () => {
    const file = histFile('limit');
    const h = createHistory({ file, limit: 3, now: () => 123456 });
    h.load();
    for (const c of ['a1', 'a2', 'a3', 'a4', 'a5']) h.push(c);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3, '文件应只保留上限条数');
    assert.deepEqual(lines.map((l) => JSON.parse(l).cmd), ['a3', 'a4', 'a5'], '裁掉最旧');
    assert.equal(JSON.parse(lines[0]).t, 123456, '记录时间戳');
    // 重新加载：历史延续
    const h2 = createHistory({ file, limit: 3 });
    h2.load();
    assert.deepEqual(h2.all(), ['a5', 'a4', 'a3']);
    h2.push('a5');
    assert.deepEqual(h2.all(), ['a5', 'a4', 'a3'], '与文件尾连续重复不入库');
  });

  test('enabled=false：不写文件，仅会话内', () => {
    const file = histFile('disabled');
    const h = createHistory({ file, limit: 10, enabled: false });
    h.load();
    h.push('git status');
    assert.equal(existsSync(file), false, '禁用时不落盘');
    assert.deepEqual(h.all(), ['git status']);
    assert.deepEqual(h.sessionView(), ['git status']);
  });
});
