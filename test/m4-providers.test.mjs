/**
 * 动态数据 Providers 单元测试。
 *
 * 覆盖：
 * 六 kind 采集与解析；TTL 过期 stale+后台刷新；结构性命令失效映射全表；
 * 非仓库 disabled；update 事件；并发 ensure 去重。
 *
 * 安全边界：
 * - 全部 git 夹具建于工作区 .sandbox/m4/ 内（git init），绝不触碰工作区之外；
 * - git 一律以 GITCUE sandbox 隔离环境（GIT_CONFIG_GLOBAL/SYSTEM 指向沙箱空文件）
 *   与 -c user.name=gitcue-test -c user.email=test@gitcue.local 执行；
 * - GITCUE_HOME 指向 .sandbox/m4/home（before 内自检断言）。
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createGitQuery } from '../src/providers/gitQuery.mjs';
import { KINDS, KIND_QUERIES, buildCommitItems } from '../src/providers/kinds.mjs';
import { createProviders, STRUCTURAL_INVALIDATION } from '../src/providers/hub.mjs';

// ---------------------------------------------------------------------------
// 沙箱布局与安全自检
// ---------------------------------------------------------------------------
const ROOT = path.resolve(import.meta.dirname, '..');
const SB = path.join(ROOT, '.sandbox', 'm4');
const HOME = path.join(SB, 'home');
const WORK = path.join(SB, 'work');
const ORIGIN = path.join(SB, 'origin.git');
const EMPTY = path.join(SB, 'empty');

/** 全部 git 子进程共用的隔离环境 */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(SB, 'git-global.cfg'),
  GIT_CONFIG_SYSTEM: path.join(SB, 'git-system.cfg'),
  GIT_TERMINAL_PROMPT: '0',
  // 阻止 git 向上发现工作区根仓库：夹具中的「非仓库」目录必须真正判定为非仓库，
  // 否则本工作区本身是 git 仓库时（克隆即如此），empty/ 会被父仓库吞掉
  GIT_CEILING_DIRECTORIES: ROOT,
  GITCUE_HOME: HOME,
};

/** 沙箱内提交身份 */
const ID = ['-c', 'user.name=gitcue-test', '-c', 'user.email=test@gitcue.local'];

/** 断言路径位于工作区内（防越界自检） */
function assertInWorkspace(p) {
  const resolved = path.resolve(p);
  assert.ok(
    resolved === ROOT || resolved.startsWith(ROOT + path.sep),
    `路径越界（安全自检失败）: ${p}`,
  );
}

/** 同步执行 git（夹具准备用）；默认断言退出码 0 */
function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync('git', [...ID, ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (!allowFail) {
    assert.equal(r.status, 0, `git ${args.join(' ')} 失败\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
  return r;
}

let fixtureReady = false;
/** 构建 .sandbox/m4 夹具（幂等）：bare origin + work 仓库 + 非仓库空目录 */
function buildFixture() {
  if (fixtureReady) return;
  for (const p of [SB, HOME, WORK, ORIGIN, EMPTY, GIT_ENV.GIT_CONFIG_GLOBAL, GIT_ENV.GIT_CONFIG_SYSTEM]) {
    assertInWorkspace(p);
  }
  // 安全自检：GITCUE_HOME 必须指向工作区 .sandbox 内
  assert.ok(
    path.resolve(GIT_ENV.GITCUE_HOME).startsWith(path.join(ROOT, '.sandbox')),
    `GITCUE_HOME 未指向 .sandbox（安全自检失败）: ${GIT_ENV.GITCUE_HOME}`,
  );

  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(EMPTY, { recursive: true });
  fs.writeFileSync(GIT_ENV.GIT_CONFIG_GLOBAL, '');
  fs.writeFileSync(GIT_ENV.GIT_CONFIG_SYSTEM, '');

  // bare origin（充当远程，本地路径推送，无网络）
  git(SB, ['init', '-q', '--bare', 'origin.git']);
  // work 仓库：main 分支 + 2 个提交
  git(SB, ['init', '-q', '-b', 'main', 'work']);
  fs.writeFileSync(path.join(WORK, 'README.md'), 'line1\n');
  fs.writeFileSync(path.join(WORK, 'docs.txt'), 'docs\n');
  fs.writeFileSync(path.join(WORK, 'del.txt'), 'del\n');
  git(WORK, ['add', '.']);
  git(WORK, ['commit', '-q', '-m', 'init']);
  git(WORK, ['commit', '-q', '--allow-empty', '-m', 'second']);
  // 分支与标签
  git(WORK, ['branch', 'dev']);
  git(WORK, ['branch', 'feature/x']);
  git(WORK, ['tag', 'v1.0']);
  git(WORK, ['tag', 'v1.1']);
  // 贮藏（先做，贮藏后工作区回到干净状态）
  fs.appendFileSync(path.join(WORK, 'README.md'), 'wip\n');
  git(WORK, ['stash', 'push', '-q', '-m', 'wip-save']);
  // 脏工作区：已修改 / 已删除 / 未跟踪（含中文名验证八进制转义解码）/ 已暂存
  fs.appendFileSync(path.join(WORK, 'README.md'), 'dirty\n');
  fs.rmSync(path.join(WORK, 'del.txt'));
  fs.writeFileSync(path.join(WORK, 'untracked.txt'), 'new\n');
  fs.writeFileSync(path.join(WORK, 'staged.txt'), 'staged\n');
  git(WORK, ['add', 'staged.txt']);
  fs.writeFileSync(path.join(WORK, '中文文件.txt'), '中文\n');
  // 远程 origin 并推送，制造 refs/remotes/origin/main
  git(WORK, ['remote', 'add', 'origin', path.relative(WORK, ORIGIN)]);
  git(WORK, ['push', '-q', '-u', 'origin', 'main']);
  // bare HEAD 指向 main，保持仓库形态规范
  git(ORIGIN, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

  // 夹具自检：建完后断言在仓库内
  assert.equal(git(WORK, ['rev-parse', '--is-inside-work-tree']).stdout.trim(), 'true');
  fixtureReady = true;
}

// ---------------------------------------------------------------------------
// 通用异步等待辅助
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待条件成立（超时抛错，避免用例挂死） */
async function waitFor(pred, { timeout = 8000, step = 10, what = '条件' } = {}) {
  const start = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - start > timeout) throw new Error(`等待超时: ${what}`);
    await sleep(step);
  }
}

/** 等待某 kind 快照到达指定状态并返回该快照 */
async function waitForSnapshot(hub, kind, status, timeout = 8000) {
  await waitFor(() => hub.snapshot(kind).status === status, { what: `${kind} -> ${status}`, timeout });
  return hub.snapshot(kind);
}

/** 让微任务队列推进若干轮（驱动 async 链） */
const tick = () => new Promise((r) => setImmediate(r));
async function ticks(n = 3) {
  for (let i = 0; i < n; i += 1) await tick();
}

// ---------------------------------------------------------------------------
// fake runGit 辅助（确定性注入，不触碰真实 git）
// ---------------------------------------------------------------------------
/** 把 args 映射为脚本键（与 src/providers 的探测/采集命令一一对应） */
function argsKey(args) {
  const j = args.join(' ');
  if (j === 'rev-parse --is-inside-work-tree') return 'repo';
  if (j === 'symbolic-ref --short HEAD') return 'branchname';
  if (args[0] === 'for-each-ref' && args.includes('refs/heads')) return 'branch';
  if (args[0] === 'for-each-ref' && args.includes('refs/tags')) return 'tag';
  if (args[0] === 'remote') return 'remote';
  if (args[0] === 'stash') return 'stash';
  if (args[0] === 'status') return 'status';
  if (args[0] === 'ls-files') return 'ls-files';
  return 'other';
}

const DEFAULT_SCRIPT = {
  repo: { code: 0, stdout: 'true\n', stderr: '' },
  branchname: { code: 0, stdout: 'main\n', stderr: '' },
  branch: { code: 0, stdout: 'main\ndev\n', stderr: '' },
  tag: { code: 0, stdout: 'v1.0\n', stderr: '' },
  remote: { code: 0, stdout: 'origin\n', stderr: '' },
  stash: { code: 0, stdout: 'stash@{0}\n', stderr: '' },
  status: { code: 0, stdout: '', stderr: '' },
  'ls-files': { code: 0, stdout: 'a.txt\n', stderr: '' },
};

/**
 * 构造 fake runGit：脚本键 → 结果或结果数组（数组依次出队，队尽复用末元素）。
 * 返回 { runGit, calls }，calls 记录每次调用的 args。
 */
function fakeGit(overrides = {}) {
  const scripts = new Map();
  for (const [k, v] of Object.entries({ ...DEFAULT_SCRIPT, ...overrides })) {
    scripts.set(k, Array.isArray(v) ? [...v] : [v]);
  }
  const calls = [];
  const runGit = async (args) => {
    calls.push(args);
    const seq = scripts.get(argsKey(args));
    if (!seq || seq.length === 0) {
      return { code: 1, stdout: '', stderr: `fake 未脚本化: ${args.join(' ')}` };
    }
    return seq.length > 1 ? seq.shift() : seq[0];
  };
  return { runGit, calls };
}

// ---------------------------------------------------------------------------
// gitQuery 单元测试
// ---------------------------------------------------------------------------
describe('M4 gitQuery（真实 git）', () => {
  before(() => buildFixture());

  it('--version：code 0 且 stdout 含版本号', async () => {
    const q = createGitQuery({ env: GIT_ENV });
    const r = await q.run(['--version']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /git version \d+\.\d+/);
  });

  it('cwd 生效：--show-toplevel 返回工作仓库根', async () => {
    const q = createGitQuery({ cwd: WORK, env: GIT_ENV });
    const r = await q.run(['rev-parse', '--show-toplevel']);
    assert.equal(r.code, 0);
    assert.equal(
      path.resolve(r.stdout.trim()).toLowerCase(),
      path.resolve(WORK).toLowerCase(),
    );
  });

  it('非零退出码与 stderr 原样返回（非仓库内执行 git status）', async () => {
    const q = createGitQuery({ cwd: EMPTY, env: GIT_ENV });
    const r = await q.run(['status']);
    assert.notEqual(r.code, 0);
    assert.ok(r.stderr.length > 0);
  });

  it('env 隔离：GIT_CONFIG_GLOBAL/SYSTEM 指向沙箱空文件时不读真实全局配置', async () => {
    const q = createGitQuery({ cwd: WORK, env: GIT_ENV });
    const none = await q.run(['config', '--get', 'user.name']);
    assert.notEqual(none.code, 0, '沙箱空配置下不应读到 user.name');
    const withId = await q.run([...ID, 'config', '--get', 'user.name']);
    assert.equal(withId.code, 0);
    assert.equal(withId.stdout.trim(), 'gitcue-test');
  });

  it('注入 GIT_TERMINAL_PROMPT=0（经 git shell alias 观察子进程环境）', async () => {
    const q = createGitQuery({ cwd: WORK, env: GIT_ENV });
    const r = await q.run([
      '-c', 'alias.probeenv=!node -p "process.env.GIT_TERMINAL_PROMPT"',
      'probeenv',
    ]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.equal(r.stdout.trim(), '0');
  });
});

// ---------------------------------------------------------------------------
// kinds 纯解析函数单元测试
// ---------------------------------------------------------------------------
describe('M4 kinds（纯解析函数）', () => {
  it('KINDS 顺序（固定契约）', () => {
    assert.deepEqual(KINDS, ['branch', 'tag', 'remote', 'commit', 'stash', 'pathspec']);
    for (const k of KINDS) assert.ok(KIND_QUERIES[k], `缺少 ${k} 定义`);
  });

  it('branch：当前分支 popularity=5/说明"当前分支"，其余=3，去重', () => {
    const items = KIND_QUERIES.branch.parse(['main\ndev\nmain\norigin/main\n'], { currentBranch: 'main' });
    assert.deepEqual(items.map((i) => i.value), ['main', 'dev', 'origin/main']);
    const main = items[0];
    assert.equal(main.popularity, 5);
    assert.equal(main.summary, '当前分支');
    assert.ok(items.slice(1).every((i) => i.popularity === 3 && i.summary === '分支'));
    assert.ok(items.every((i) => i.kind === 'branch' && i.label === i.value));
  });

  it('branch：上限 2000 截断', () => {
    const stdout = Array.from({ length: 2005 }, (_, i) => `b${i}`).join('\n') + '\n';
    const items = KIND_QUERIES.branch.parse([stdout], { currentBranch: null });
    assert.equal(items.length, KIND_QUERIES.branch.limit);
    assert.equal(KIND_QUERIES.branch.limit, 2000);
  });

  it('tag：解析、去重与说明"标签"', () => {
    const items = KIND_QUERIES.tag.parse(['v1.0\nv1.1\nv1.0\n'], {});
    assert.deepEqual(items.map((i) => i.value), ['v1.0', 'v1.1']);
    assert.ok(items.every((i) => i.summary === '标签' && i.popularity === 3 && i.kind === 'tag'));
  });

  it('remote：解析与说明"远程仓库"', () => {
    const items = KIND_QUERIES.remote.parse(['origin\nupstream\n'], {});
    assert.deepEqual(items.map((i) => i.value), ['origin', 'upstream']);
    assert.ok(items.every((i) => i.summary === '远程仓库' && i.kind === 'remote'));
  });

  it('stash：stash@{0} 说明"最新贮藏"，其余"第 n 个贮藏"', () => {
    const items = KIND_QUERIES.stash.parse(['stash@{0}\nstash@{1}\nstash@{2}\n'], {});
    assert.deepEqual(items.map((i) => i.value), ['stash@{0}', 'stash@{1}', 'stash@{2}']);
    assert.equal(items[0].summary, '最新贮藏');
    assert.equal(items[1].summary, '第 2 个贮藏');
    assert.equal(items[2].summary, '第 3 个贮藏');
    assert.ok(items.every((i) => i.kind === 'stash'));
  });

  it('pathspec：porcelain 状态标记 ∪ ls-files 已跟踪，去重', () => {
    const porcelain = [
      ' M mod.txt',       // 仅工作区修改
      'A  staged.txt',    // 仅暂存（新增）
      'D  delstaged.txt', // 仅暂存（删除）
      ' D delwork.txt',   // 仅工作区删除
      'MM both.txt',      // 暂存+修改
      '?? untracked.txt', // 未跟踪
      'UU conflict.txt',  // 合并冲突
      'R  old.txt -> new.txt', // 重命名取新路径
    ].join('\n');
    const items = KIND_QUERIES.pathspec.parse([porcelain, 'mod.txt\nclean.txt\n'], {});
    const map = new Map(items.map((i) => [i.value, i.summary]));
    assert.equal(map.get('mod.txt'), '已修改');
    assert.equal(map.get('staged.txt'), '已暂存');
    assert.equal(map.get('delstaged.txt'), '已暂存删除');
    assert.equal(map.get('delwork.txt'), '已删除');
    assert.equal(map.get('both.txt'), '已暂存+已修改');
    assert.equal(map.get('untracked.txt'), '未跟踪');
    assert.equal(map.get('conflict.txt'), '合并冲突');
    assert.equal(map.get('new.txt'), '已暂存'); // 重命名按暂存态展示
    assert.equal(map.get('clean.txt'), '已跟踪');
    assert.equal(map.get('old.txt'), undefined); // 旧路径不出现
    assert.equal(items.length, 9); // mod/staged/delstaged/delwork/both/untracked/conflict/new/clean
    assert.ok(items.every((i) => i.kind === 'pathspec'));
  });

  it('pathspec：八进制转义的中文路径解码为原文', () => {
    // git porcelain（core.quotePath 默认开启）输出："中文文件.txt" 的 UTF-8 八进制转义
    const items = KIND_QUERIES.pathspec.parse(['?? "\\344\\270\\255\\346\\226\\207\\346\\226\\207\\344\\273\\266.txt"\n', ''], {});
    assert.deepEqual(items.map((i) => i.value), ['中文文件.txt']);
    assert.equal(items[0].summary, '未跟踪');
  });

  it('pathspec：上限 500 截断，porcelain 条目优先', () => {
    const porcelain = Array.from({ length: 300 }, (_, i) => `?? p${i}.txt`).join('\n');
    const tracked = Array.from({ length: 400 }, (_, i) => `t${i}.txt`).join('\n');
    const items = KIND_QUERIES.pathspec.parse([porcelain, tracked], {});
    assert.equal(items.length, KIND_QUERIES.pathspec.limit);
    assert.equal(KIND_QUERIES.pathspec.limit, 500);
    // 前 300 条来自 porcelain（未跟踪），后 200 条来自 ls-files（已跟踪）
    assert.equal(items[0].value, 'p0.txt');
    assert.equal(items[299].value, 'p299.txt');
    assert.equal(items[300].value, 't0.txt');
    assert.equal(items[300].summary, '已跟踪');
  });

  it('buildCommitItems：固定 HEAD 系 + branch/tag 快照 + popularity 规则', () => {
    const branchItems = KIND_QUERIES.branch.parse(['main\ndev\n'], { currentBranch: 'main' });
    const tagItems = KIND_QUERIES.tag.parse(['v1.0\n'], {});
    const items = buildCommitItems(branchItems, tagItems);
    assert.deepEqual(
      items.slice(0, 10).map((i) => i.value),
      ['HEAD', 'HEAD~1', 'HEAD~2', 'HEAD~3', 'HEAD~4', 'HEAD~5', 'HEAD~6', 'HEAD~7', 'HEAD~8', 'HEAD~9'],
    );
    assert.equal(items[0].popularity, 5); // HEAD
    assert.equal(items[1].popularity, 4); // HEAD~1
    assert.equal(items[3].popularity, 2); // HEAD~3
    assert.equal(items[4].popularity, 1); // HEAD~4
    assert.equal(items[9].popularity, 1); // HEAD~9（clamp 到 1）
    const byValue = new Map(items.map((i) => [i.value, i]));
    assert.equal(byValue.get('main').popularity, 5); // 当前分支沿袭
    assert.equal(byValue.get('dev').popularity, 3);
    assert.equal(byValue.get('v1.0').popularity, 3);
    assert.ok(items.every((i) => i.kind === 'commit'));
  });

  it('buildCommitItems：同名 branch/tag 去重', () => {
    const branchItems = KIND_QUERIES.branch.parse(['release\n'], { currentBranch: 'release' });
    const tagItems = KIND_QUERIES.tag.parse(['release\n'], {});
    const items = buildCommitItems(branchItems, tagItems);
    assert.equal(items.filter((i) => i.value === 'release').length, 1);
  });
});

// ---------------------------------------------------------------------------
// createProviders：真实 git（.sandbox/m4 夹具）
// ---------------------------------------------------------------------------
describe('M4 createProviders（真实 git，.sandbox/m4 夹具）', () => {
  before(() => buildFixture());

  it('ProviderHub 是 EventEmitter 实例', () => {
    const hub = createProviders({ cwd: EMPTY, runGit: createGitQuery({ cwd: EMPTY, env: GIT_ENV }).run });
    assert.ok(hub instanceof EventEmitter);
    hub.close();
  });

  it('branch：本地+远程分支；当前分支 popularity=5 且说明"当前分支"', async () => {
    const hub = createProviders({ cwd: WORK, runGit: createGitQuery({ cwd: WORK, env: GIT_ENV }).run });
    try {
      const snap = await waitForSnapshot(hub, 'branch', 'ready');
      assert.deepEqual(
        snap.items.map((i) => i.value),
        ['dev', 'feature/x', 'main', 'origin/main'],
      );
      const main = snap.items.find((i) => i.value === 'main');
      assert.equal(main.popularity, 5);
      assert.equal(main.summary, '当前分支');
      assert.ok(snap.items.filter((i) => i.value !== 'main').every((i) => i.popularity === 3));
      assert.ok(Number.isInteger(snap.updatedAt));
    } finally { hub.close(); }
  });

  it('tag：v1.0 与 v1.1', async () => {
    const hub = createProviders({ cwd: WORK, runGit: createGitQuery({ cwd: WORK, env: GIT_ENV }).run });
    try {
      const snap = await waitForSnapshot(hub, 'tag', 'ready');
      assert.deepEqual(snap.items.map((i) => i.value), ['v1.0', 'v1.1']);
    } finally { hub.close(); }
  });

  it('remote：origin', async () => {
    const hub = createProviders({ cwd: WORK, runGit: createGitQuery({ cwd: WORK, env: GIT_ENV }).run });
    try {
      const snap = await waitForSnapshot(hub, 'remote', 'ready');
      assert.deepEqual(snap.items.map((i) => i.value), ['origin']);
    } finally { hub.close(); }
  });

  it('stash：stash@{0}（最新贮藏）', async () => {
    const hub = createProviders({ cwd: WORK, runGit: createGitQuery({ cwd: WORK, env: GIT_ENV }).run });
    try {
      const snap = await waitForSnapshot(hub, 'stash', 'ready');
      assert.deepEqual(snap.items.map((i) => i.value), ['stash@{0}']);
      assert.equal(snap.items[0].summary, '最新贮藏');
    } finally { hub.close(); }
  });

  it('pathspec：已修改/未跟踪/已暂存/已删除/已跟踪/中文未跟踪（真实 porcelain）', async () => {
    const hub = createProviders({ cwd: WORK, runGit: createGitQuery({ cwd: WORK, env: GIT_ENV }).run });
    try {
      const snap = await waitForSnapshot(hub, 'pathspec', 'ready');
      const map = new Map(snap.items.map((i) => [i.value, i.summary]));
      assert.equal(map.get('README.md'), '已修改');
      assert.equal(map.get('del.txt'), '已删除');
      assert.equal(map.get('staged.txt'), '已暂存');
      assert.equal(map.get('untracked.txt'), '未跟踪');
      assert.equal(map.get('中文文件.txt'), '未跟踪'); // 八进制转义已解码
      assert.equal(map.get('docs.txt'), '已跟踪');
      assert.equal(snap.items.length, 6);
    } finally { hub.close(); }
  });

  it('commit：派生 HEAD 系 + 分支 + 标签，popularity 规则生效', async () => {
    const hub = createProviders({ cwd: WORK, runGit: createGitQuery({ cwd: WORK, env: GIT_ENV }).run });
    try {
      const snap = await waitForSnapshot(hub, 'commit', 'ready');
      const values = snap.items.map((i) => i.value);
      assert.equal(values[0], 'HEAD');
      assert.ok(values.includes('HEAD~9'));
      assert.ok(values.includes('dev') && values.includes('feature/x') && values.includes('origin/main'));
      assert.ok(values.includes('v1.0') && values.includes('v1.1'));
      const byValue = new Map(snap.items.map((i) => [i.value, i]));
      assert.equal(byValue.get('HEAD').summary, '当前提交');
      assert.equal(byValue.get('HEAD~2').popularity, 3);
      assert.equal(byValue.get('HEAD~5').popularity, 1);
      assert.equal(byValue.get('main').popularity, 5); // 当前分支沿袭
      assert.equal(byValue.get('v1.0').popularity, 3);
      assert.ok(snap.items.every((i) => i.kind === 'commit'));
    } finally { hub.close(); }
  });

  it('repoInfo：仓库内 isRepo=true、branch=main、cwd=注入目录、checkedAt>0', async () => {
    const hub = createProviders({ cwd: WORK, runGit: createGitQuery({ cwd: WORK, env: GIT_ENV }).run });
    try {
      await waitFor(() => hub.repoInfo().isRepo === true, { what: 'repo 探测' });
      const info = hub.repoInfo();
      assert.equal(info.branch, 'main');
      assert.equal(info.cwd, WORK, 'repoInfo 应携带 cwd（界面标题区展示当前目录）');
      assert.ok(info.checkedAt > 0);
    } finally { hub.close(); }
  });

  it('非仓库：全部 kind disabled，且不调用任何采集命令', async () => {
    const base = createGitQuery({ cwd: EMPTY, env: GIT_ENV });
    let collectCalls = 0;
    const runGit = async (args) => {
      if (args[0] !== 'rev-parse') collectCalls += 1; // 仅允许仓库探测命令
      return base.run(args);
    };
    const hub = createProviders({ cwd: EMPTY, runGit });
    try {
      await waitFor(() => hub.repoInfo().isRepo === false, { what: '非仓库判定' });
      for (const kind of KINDS) {
        const snap = hub.snapshot(kind);
        assert.equal(snap.status, 'disabled', `${kind} 应 disabled`);
        assert.deepEqual(snap.items, []);
      }
      assert.equal(collectCalls, 0, '非仓库内不得调用采集命令');
      // 非仓库下 ensure 为空操作
      for (const kind of KINDS) hub.ensure(kind);
      assert.equal(collectCalls, 0);
    } finally { hub.close(); }
  });

  it('TTL：过期后 snapshot 返回 stale+旧数据，后台刷新出新数据', async () => {
    const hub = createProviders({
      cwd: WORK,
      runGit: createGitQuery({ cwd: WORK, env: GIT_ENV }).run,
      cacheTtlMs: 150,
    });
    try {
      await waitForSnapshot(hub, 'branch', 'ready');
      git(WORK, ['branch', 'ttl-branch']);
      await sleep(250); // 确保 TTL 过期后再访问快照
      const stale = hub.snapshot('branch');
      assert.equal(stale.status, 'stale');
      assert.equal(stale.updatedAt !== null, true);
      assert.ok(!stale.items.some((i) => i.value === 'ttl-branch'), 'stale 快照不得出现刷新后才有的新分支');
      const fresh = await waitForSnapshot(hub, 'branch', 'ready');
      assert.ok(fresh.items.some((i) => i.value === 'ttl-branch'), '后台刷新后应出现新分支');
    } finally {
      git(WORK, ['branch', '-D', 'ttl-branch']);
      hub.close();
    }
  });

  it('结构性命令失效（真实 git）：git branch <new> 后主动失效并重载', async () => {
    const hub = createProviders({
      cwd: WORK,
      runGit: createGitQuery({ cwd: WORK, env: GIT_ENV }).run,
      cacheTtlMs: 60_000,
    });
    try {
      const ready = await waitForSnapshot(hub, 'branch', 'ready');
      assert.ok(!ready.items.some((i) => i.value === 'struct-branch'));
      git(WORK, ['branch', 'struct-branch']);
      hub.invalidateAfterCommand('git branch struct-branch');
      const snap = hub.snapshot('branch'); // 触发后台重载
      assert.notEqual(snap.status, 'ready', '失效后旧缓存不得继续以 ready 提供');
      assert.deepEqual(snap.items, [], '失效后不得提供旧数据');
      const fresh = await waitForSnapshot(hub, 'branch', 'ready');
      assert.ok(fresh.items.some((i) => i.value === 'struct-branch'));
    } finally {
      git(WORK, ['branch', '-D', 'struct-branch']);
      hub.close();
    }
  });
});

// ---------------------------------------------------------------------------
// createProviders：fake runGit 注入（确定性时序/时钟/错误）
// ---------------------------------------------------------------------------
describe('M4 createProviders（fake runGit 注入）', () => {
  it('runGit=null：全部 kind 一律 disabled，repoInfo 保持未知（测试注入语义）', () => {
    const hub = createProviders({ runGit: null });
    try {
      for (const kind of KINDS) {
        const snap = hub.snapshot(kind);
        assert.equal(snap.status, 'disabled');
        assert.deepEqual(snap.items, []);
        assert.equal(snap.updatedAt, null);
      }
      const info = hub.repoInfo();
      assert.deepEqual(info, { isRepo: null, branch: null, cwd: process.cwd(), checkedAt: 0 });
      for (const kind of KINDS) hub.ensure(kind); // 空操作
      assert.equal(hub.snapshot('branch').status, 'disabled');
    } finally { hub.close(); }
  });

  it('启动即异步探测仓库；探测在途时 snapshot 为 loading', async () => {
    const pending = [];
    const runGit = (args) => new Promise((res) => pending.push({ args, res }));
    const hub = createProviders({ runGit });
    try {
      assert.equal(hub.repoInfo().isRepo, null);
      assert.equal(hub.snapshot('branch').status, 'loading'); // 仓库未知 → loading
      // 仓库探测两步：is-inside-work-tree → 仓库内再取当前分支名（symbolic-ref，unborn 亦可取）
      assert.equal(pending.length, 1, '启动应立即发起仓库探测');
      pending.shift().res({ code: 0, stdout: 'true\n', stderr: '' });
      await ticks();
      assert.equal(pending.length, 1, '仓库内应继续探测当前分支名');
      assert.deepEqual(pending[0].args, ['symbolic-ref', '--short', 'HEAD']);
      pending.shift().res({ code: 0, stdout: 'main\n', stderr: '' });
      await waitFor(() => hub.repoInfo().isRepo === true, { what: 'repo 探测完成' });
      assert.equal(hub.repoInfo().branch, 'main');
    } finally { hub.close(); }
  });

  it('并发 ensure 去重 + update 事件（加载完成广播 kind）', async () => {
    const pending = [];
    const runGit = (args) => new Promise((res) => pending.push({ args, res }));
    const hub = createProviders({ runGit });
    try {
      // 推进仓库探测两步
      await ticks();
      assert.equal(pending.length, 1);
      pending.shift().res({ code: 0, stdout: 'true\n', stderr: '' });
      await ticks();
      const branchNameCall = pending.shift();
      assert.deepEqual(branchNameCall.args, ['symbolic-ref', '--short', 'HEAD']);
      branchNameCall.res({ code: 0, stdout: 'main\n', stderr: '' });
      await waitFor(() => hub.repoInfo().isRepo === true, { what: 'repo 探测' });
      await ticks();
      assert.equal(pending.length, 0, '探测完成后不应有挂起调用');

      const events = [];
      hub.on('update', (kind) => events.push(kind));
      hub.ensure('branch');
      hub.ensure('branch');
      hub.ensure('branch');
      await ticks();
      assert.equal(pending.length, 1, '三次并发 ensure 只应发起一次采集');
      assert.equal(hub.snapshot('branch').status, 'loading');
      pending.shift().res({ code: 0, stdout: 'main\ndev\n', stderr: '' });
      const snap = await waitForSnapshot(hub, 'branch', 'ready');
      assert.deepEqual(snap.items.map((i) => i.value), ['main', 'dev']);
      assert.deepEqual(events, ['branch']);
    } finally { hub.close(); }
  });

  it('TTL 过期（注入时钟）：stale 携旧数据 → 后台刷新取新数据', async () => {
    const clock = { t: 1_000 };
    const { runGit, calls } = fakeGit({
      branch: [
        { code: 0, stdout: 'main\n', stderr: '' },
        { code: 0, stdout: 'main\ndev\n', stderr: '' },
      ],
    });
    const hub = createProviders({ runGit, cacheTtlMs: 30_000, now: () => clock.t });
    try {
      const first = await waitForSnapshot(hub, 'branch', 'ready');
      assert.deepEqual(first.items.map((i) => i.value), ['main']);
      const branchCalls = () => calls.filter((a) => argsKey(a) === 'branch').length;
      assert.equal(branchCalls(), 1);

      clock.t += 31_000; // 越过 TTL
      const stale = hub.snapshot('branch');
      assert.equal(stale.status, 'stale');
      assert.deepEqual(stale.items.map((i) => i.value), ['main'], 'stale 返回旧数据');
      const fresh = await waitForSnapshot(hub, 'branch', 'ready');
      assert.deepEqual(fresh.items.map((i) => i.value), ['main', 'dev']);
      assert.equal(branchCalls(), 2, 'TTL 过期应自动后台刷新一次');
    } finally { hub.close(); }
  });

  it('采集失败：status=error 且携带错误信息', async () => {
    const { runGit } = fakeGit({
      branch: { code: 128, stdout: '', stderr: 'fatal: bad object' },
    });
    const hub = createProviders({ runGit });
    try {
      const snap = await waitForSnapshot(hub, 'branch', 'error');
      assert.ok(snap.error && snap.error.includes('fatal: bad object'), `error 应含 stderr: ${snap.error}`);
      assert.deepEqual(snap.items, []);
    } finally { hub.close(); }
  });

  it('加载中失效（pending-invalidate）：完成即丢弃结果并立即重载', async () => {
    const pending = [];
    const runGit = (args) => {
      const key = argsKey(args);
      if (key === 'repo') return Promise.resolve({ code: 0, stdout: 'true\n', stderr: '' });
      if (key === 'branchname') return Promise.resolve({ code: 0, stdout: 'main\n', stderr: '' });
      return new Promise((res) => pending.push({ key, res })); // branch 采集挂起
    };
    const hub = createProviders({ runGit });
    try {
      await waitFor(() => hub.repoInfo().isRepo === true, { what: 'repo 探测' });
      hub.ensure('branch');
      await ticks();
      assert.equal(pending.length, 1, '应有一次在途采集');

      hub.invalidate('branch'); // 在途加载中失效
      assert.equal(hub.snapshot('branch').status, 'loading');
      pending.shift().res({ code: 0, stdout: 'old\n', stderr: '' }); // 旧结果应被丢弃
      await ticks();
      assert.equal(hub.snapshot('branch').status, 'loading', '旧结果丢弃后应仍在加载（重载中）');
      assert.equal(pending.length, 1, '丢弃后应立即重新采集');
      pending.shift().res({ code: 0, stdout: 'new\n', stderr: '' });
      const snap = await waitForSnapshot(hub, 'branch', 'ready');
      assert.deepEqual(snap.items.map((i) => i.value), ['new'], '最终只保留失效后的新数据');
    } finally { hub.close(); }
  });

  it('commit 派生：无独立 git 调用，branch/tag 各采集一次', async () => {
    const { runGit, calls } = fakeGit();
    const hub = createProviders({ runGit });
    try {
      const snap = await waitForSnapshot(hub, 'commit', 'ready');
      const values = snap.items.map((i) => i.value);
      assert.equal(values[0], 'HEAD');
      assert.ok(values.includes('dev') && values.includes('v1.0'));
      const branchCalls = calls.filter((a) => argsKey(a) === 'branch').length;
      const tagCalls = calls.filter((a) => argsKey(a) === 'tag').length;
      assert.equal(branchCalls, 1, 'commit 派生只应触发一次 branch 采集');
      assert.equal(tagCalls, 1, 'commit 派生只应触发一次 tag 采集');
    } finally { hub.close(); }
  });

  it('commit 派生联动：branch 后台刷新后 commit 随之重算并广播', async () => {
    const clock = { t: 0 };
    const { runGit } = fakeGit({
      branch: [
        { code: 0, stdout: 'main\n', stderr: '' },
        { code: 0, stdout: 'main\ndev\n', stderr: '' },
      ],
    });
    const hub = createProviders({ runGit, cacheTtlMs: 30_000, now: () => clock.t });
    try {
      const first = await waitForSnapshot(hub, 'commit', 'ready');
      assert.ok(!first.items.some((i) => i.value === 'dev'));
      clock.t += 31_000;
      hub.snapshot('branch'); // 触发 branch 过期刷新（并连带 commit 重算）
      await waitFor(() => hub.snapshot('commit').items.some((i) => i.value === 'dev'), { what: 'commit 联动刷新' });
      const refreshed = hub.snapshot('commit');
      assert.equal(refreshed.status, 'ready');
      assert.ok(refreshed.items.some((i) => i.value === 'dev'));
    } finally { hub.close(); }
  });

  it('结构性命令失效映射全表（逐行核对）', async () => {
    // 表内容与 STRUCTURAL_INVALIDATION 常量对照 + 行为验证（失效后自动重载）
    assert.deepEqual(STRUCTURAL_INVALIDATION.branch, ['branch', 'commit']);
    assert.equal(STRUCTURAL_INVALIDATION.init, 'all');
    const rows = [
      ['branch', ['branch', 'commit']],
      ['tag', ['tag', 'commit']],
      ['remote', ['remote', 'commit']],
      ['stash', ['stash']],
      ['fetch', ['branch', 'tag', 'remote', 'commit']],
      ['pull', ['branch', 'tag', 'remote', 'commit']],
      ['push', ['branch', 'tag', 'remote', 'commit']],
      ['checkout', ['branch', 'commit', 'pathspec']],
      ['switch', ['branch', 'commit', 'pathspec']],
      ['reset', ['pathspec', 'commit']],
      ['restore', ['pathspec', 'commit']],
      ['clean', ['pathspec', 'commit']],
      ['add', ['pathspec']],
      ['mv', ['pathspec']],
      ['commit', ['branch', 'commit', 'pathspec', 'stash']], // 首次提交创建分支：branch 列表随之变化
      ['merge', ['commit', 'pathspec', 'stash']],
      ['rebase', ['commit', 'pathspec', 'stash']],
      ['revert', ['commit', 'pathspec', 'stash']],
      ['cherry-pick', ['commit', 'pathspec', 'stash']],
      ['init', [...KINDS]],
      ['clone', [...KINDS]],
    ];
    const { runGit } = fakeGit();
    const hub = createProviders({ runGit, cacheTtlMs: 60_000 });
    try {
      for (const kind of KINDS) hub.ensure(kind);
      await waitFor(() => KINDS.every((k) => hub.snapshot(k).status === 'ready'), { what: '六 kind 全部 ready' });

      for (const [cmd, affected] of rows) {
        hub.invalidateAfterCommand(`git ${cmd} some-arg`);
        for (const kind of KINDS) {
          const snap = hub.snapshot(kind);
          if (affected.includes(kind)) {
            assert.notEqual(snap.status, 'ready', `git ${cmd} 应失效 ${kind}`);
            assert.deepEqual(snap.items, [], `git ${cmd} 失效 ${kind} 后不得提供旧数据`);
          } else {
            assert.equal(snap.status, 'ready', `git ${cmd} 不应失效 ${kind}`);
          }
        }
        // 等待自动重载恢复 ready，供下一行核对
        await waitFor(
          () => KINDS.every((k) => hub.snapshot(k).status === 'ready'),
          { what: `${cmd} 后六 kind 恢复 ready`, timeout: 8000 },
        );
      }

      // 非 git 前缀 / 空命令 / 未知子命令：不做任何失效
      hub.invalidateAfterCommand('ls -la');
      hub.invalidateAfterCommand('git');
      hub.invalidateAfterCommand('');
      hub.invalidateAfterCommand('git log --oneline'); // 非结构性命令
      for (const kind of KINDS) {
        assert.equal(hub.snapshot(kind).status, 'ready', `${kind} 不应被无关命令失效`);
      }
    } finally { hub.close(); }
  });

  it('探测失败视为非仓库：全部 disabled 且不调用采集命令', async () => {
    const { runGit, calls } = fakeGit({
      repo: { code: 128, stdout: '', stderr: 'fatal: not a git repository' },
    });
    const hub = createProviders({ runGit });
    try {
      await waitFor(() => hub.repoInfo().isRepo === false, { what: '探测失败判定' });
      for (const kind of KINDS) assert.equal(hub.snapshot(kind).status, 'disabled');
      assert.equal(calls.filter((a) => a[0] !== 'rev-parse').length, 0, '不得调用采集命令');
    } finally { hub.close(); }
  });

  it('close：关闭后不再发起加载与广播', async () => {
    const pending = [];
    const runGit = (args) => new Promise((res) => pending.push({ args, res }));
    const hub = createProviders({ runGit });
    let emitted = 0;
    hub.on('update', () => { emitted += 1; });
    hub.close();
    hub.ensure('branch');
    hub.invalidateAfterCommand('git branch x');
    hub.recheckRepo();
    await sleep(50);
    assert.equal(emitted, 0, 'close 后不得再广播 update');
    assert.equal(hub.snapshot('branch').status, 'loading'); // 仓库状态未定 → loading（不发起新探测）
    // 启动探测的挂起结果在 close 后被忽略
    assert.equal(pending.length, 1);
    pending.shift().res({ code: 0, stdout: 'true\n', stderr: '' });
    await ticks();
    assert.equal(hub.repoInfo().isRepo, null, 'close 后探测结果应被忽略');
  });

  it('invalidate 支持数组与未知 kind 容错', async () => {
    const { runGit } = fakeGit();
    const hub = createProviders({ runGit });
    try {
      await waitForSnapshot(hub, 'remote', 'ready');
      hub.invalidate(['remote', 'stash']);
      assert.notEqual(hub.snapshot('remote').status, 'ready');
      hub.invalidate('not-a-kind'); // 容错：不抛错
      const unknown = hub.snapshot('not-a-kind');
      assert.equal(unknown.status, 'disabled');
      assert.ok(unknown.error && unknown.error.includes('未知 kind'));
    } finally { hub.close(); }
  });
});
