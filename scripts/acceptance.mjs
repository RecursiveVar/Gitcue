#!/usr/bin/env node
/**
 * GitCue 验收测试（13 个场景）。
 *
 * 运行：node scripts/acceptance.mjs（需先 npm install——验收用到 devDependencies 的
 * ink-testing-library；启动即检测，缺失报错退出）
 *  - 逐场景打印「场景 N: ✔/✘ 描述」，全部通过退出码 0，任一失败退出码 1 并打印明细；
 *  - 场景 1–4/6/7/11：无头等价覆盖——真实知识库 + 真实 suggest 管线 + 真实 reducer/controller
 *    （controller.input(key) 与真实按键路径等价），动态数据用真实 ProviderHub
 *    （场景 2/9）或 fake（性能场景），执行器用 fake（立即结算）或真实 runner（场景 5）；
 *  - 渲染断言一律走无头渲染契约 renderAppLines（src/ui/testHarness.mjs：直接委托
 *    renderPlainLines 单一真源，与生产 plain 路径零漂移）；view 注入（captureView 捕获状态帧）；
 *  - 场景 5：子进程驱动真实入口；5c 为真 REPL 端到端（spawn bin/gitcue.mjs + stdin 管道驱动）；
 *  - 场景 10：固定种子（mulberry32, 0x20261010）随机按键 10 万次回放 suggest 管线，
 *    测 P95 < 50ms 且 P99 < 100ms（计算层口径，异步 exec 回调不计入）；叠加生产模式渲染
 *    抽样断言（createRenderSampler，单次 < 50ms——禁止以 itl 计时）；冷启动两路径：
 *    单次模式 20 次中位 < 300ms + 知识库加载 < 200ms 日志断言；REPL 首帧无头测量
 *    （20 次中位），< 1500ms 工程防回归硬断言 + 300ms 目标判定照算照报（超标记入发现
 *    清单，不计入通过/失败）；
 *  - 场景 13：旧名残留核查——步骤 0 清理陈旧沙箱产物 .sandbox/m6/repl/；产品文件集与
 *    .sandbox/ 在工作区路径形态归一化后大小写不敏感查旧名零命中；react/ink import 白名单。
 *
 * 安全边界（最高优先级）：
 *  1. 只在工作区（本文件上两级）内读写；所有绝对路径经 path.resolve 后必须以工作区根开头；
 *  2. 测试仓库一律在工作区 .sandbox/accept/ 内 git init 创建（bare origin 充当远程、
 *     work 仓库含 main/feature 分支/tag/stash、clone、empty 非仓库目录），全程无网络；
 *  3. 禁止 git --global/--system；一切 git 子进程附加 -c user.name=gitcue-test -c
 *     user.email=test@gitcue.local，并以 GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM 指向沙箱内空文件隔离；
 *  4. 用户级数据一律经 GITCUE_HOME 指向 .sandbox/accept/home 下的用例独占目录，
 *     启动即自检：GITCUE_HOME 必须位于 .sandbox/accept/ 内，否则拒绝运行；
 *  5. 只允许固定版本的依赖（ink@8.0.0 / react@19.3.0 / ink-testing-library@4.0.0
 *     及其传递依赖），不引入其它包。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

// ───────── 工作区根与启动前置：依赖与入口核查 ─────────

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

if (!existsSync(path.join(ROOT_DIR, 'node_modules', 'ink-testing-library'))) {
  console.error(
    '缺少 devDependencies：node_modules/ink-testing-library 不存在。验收需要完整安装（npm install）。',
  );
  process.exit(1);
}
if (!existsSync(path.join(ROOT_DIR, 'bin', 'gitcue.mjs'))) {
  console.error('入口缺失：bin/gitcue.mjs 不存在（package.json bin 字段指向该文件）');
  process.exit(1);
}

// ───────── 工作区与沙箱（安全自检） ─────────
const SB = path.join(ROOT_DIR, '.sandbox', 'accept');
const HOME = path.join(SB, 'home');
const WORK = path.join(SB, 'work');
const ORIGIN = path.join(SB, 'origin.git');
const CLONE = path.join(SB, 'clone');
const EMPTY = path.join(SB, 'empty');
const TMP = path.join(SB, 'tmp');

/** 所有绝对路径必须位于工作区内（防越界自检） */
function assertInWorkspace(p, what) {
  const r = path.resolve(p);
  if (r !== ROOT_DIR && !r.startsWith(ROOT_DIR + path.sep)) {
    throw new Error(`安全边界违规：${what} 路径 ${r} 不在工作区 ${ROOT_DIR} 内`);
  }
  return r;
}
for (const [p, w] of [
  [SB, '沙箱'],
  [HOME, 'GITCUE_HOME'],
  [WORK, 'work 仓库'],
  [ORIGIN, 'bare origin'],
  [CLONE, 'clone'],
  [EMPTY, '非仓库目录'],
]) {
  assertInWorkspace(p, w);
}

// 启动即自检：GITCUE_HOME 未设或不在 .sandbox/accept/ 内 → 拒绝运行。
// 本脚本统一把 GITCUE_HOME 钉在沙箱内；若外部传入的真实主目录值则直接拒绝。
const externalHome = process.env.GITCUE_HOME;
if (externalHome && path.resolve(externalHome) !== path.resolve(HOME)) {
  const r = path.resolve(externalHome);
  if (!r.startsWith(path.join(SB) + path.sep)) {
    console.error(`安全边界违规：外部 GITCUE_HOME=${r} 不在 ${SB} 内，拒绝运行`);
    process.exit(1);
  }
}
process.env.GITCUE_HOME = HOME;
process.env.GIT_TERMINAL_PROMPT = '0';
// git 配置隔离：全局/系统配置指向沙箱内空文件
mkdirSync(TMP, { recursive: true });
const GIT_GLOBAL_CFG = path.join(TMP, 'git-global.cfg');
const GIT_SYSTEM_CFG = path.join(TMP, 'git-system.cfg');
writeFileSync(GIT_GLOBAL_CFG, '', 'utf8');
writeFileSync(GIT_SYSTEM_CFG, '', 'utf8');
process.env.GIT_CONFIG_GLOBAL = GIT_GLOBAL_CFG;
process.env.GIT_CONFIG_SYSTEM = GIT_SYSTEM_CFG;
// 阻止 git 向上发现工作区根仓库：沙箱中的「非仓库」目录必须真正判定为非仓库
// （本工作区本身是 git 仓库时——克隆即如此——empty/ 会被父仓库吞掉）。
// 设在 process.env 上：进程内创建的 ProviderHub 与 spawn 出的子进程都继承
process.env.GIT_CEILING_DIRECTORIES = ROOT_DIR;

/** 子进程统一环境（含 GITCUE_HOME 与 git 隔离变量） */
function childEnv(extra = {}) {
  return {
    ...process.env,
    GITCUE_HOME: HOME,
    GIT_CONFIG_GLOBAL: GIT_GLOBAL_CFG,
    GIT_CONFIG_SYSTEM: GIT_SYSTEM_CFG,
    GIT_TERMINAL_PROMPT: '0',
    // 阻止 git 向上发现工作区根仓库：沙箱中的「非仓库」目录必须真正判定为非仓库
    // （本工作区本身是 git 仓库时——克隆即如此——empty/ 会被父仓库吞掉）
    GIT_CEILING_DIRECTORIES: ROOT_DIR,
    NO_COLOR: '1',
    ...extra,
  };
}

const IDENTITY = ['-c', 'user.name=gitcue-test', '-c', 'user.email=test@gitcue.local'];
const git = (args, opts = {}) =>
  spawnSync('git', [...IDENTITY, ...args], {
    cwd: opts.cwd ?? ROOT_DIR,
    env: childEnv(),
    encoding: 'utf8',
    timeout: 60_000,
  });

// ───────── 夹具准备（全程无网络） ─────────

function rmRetry(p) {
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(p, { recursive: true, force: true });
      return;
    } catch {
      /* Windows 句柄延迟：退避重试 */
      spawnSync(process.execPath, ['-e', '']); // 让出一拍
    }
  }
  rmSync(p, { recursive: true, force: true });
}

function buildFixture() {
  rmRetry(SB);
  mkdirSync(HOME, { recursive: true });
  mkdirSync(TMP, { recursive: true });
  mkdirSync(EMPTY, { recursive: true });

  const run = (args, opts) => {
    const r = git(args, opts);
    if (r.status !== 0) throw new Error(`夹具命令失败: git ${args.join(' ')}\n${r.stderr}`);
    return r;
  };

  run(['init', '-q', '--bare', ORIGIN]);
  run(['init', '-q', '-b', 'main', WORK]);
  // work：两个提交 + main/feature 分支 + tag + stash + 远程 origin（本地 bare，无网络）
  writeFileSync(path.join(WORK, 'README.md'), '# demo\n', 'utf8');
  writeFileSync(path.join(WORK, 'a.txt'), 'line1\nline2\n', 'utf8');
  run(['add', '.'], { cwd: WORK });
  run(['commit', '-q', '-m', 'init'], { cwd: WORK });
  run(['commit', '-q', '--allow-empty', '-m', 'second'], { cwd: WORK });
  run(['checkout', '-q', '-b', 'feature'], { cwd: WORK });
  writeFileSync(path.join(WORK, 'f.txt'), 'feat\n', 'utf8');
  run(['add', 'f.txt'], { cwd: WORK });
  run(['commit', '-q', '-m', 'feature work'], { cwd: WORK });
  run(['checkout', '-q', 'main'], { cwd: WORK });
  run(['tag', 'v1.0'], { cwd: WORK });
  writeFileSync(path.join(WORK, 'wip.txt'), 'wip\n', 'utf8');
  run(['add', 'wip.txt'], { cwd: WORK });
  run(['stash', '-q'], { cwd: WORK });
  run(['remote', 'add', 'origin', '../origin.git'], { cwd: WORK });
  run(['push', '-q', '-u', 'origin', 'main'], { cwd: WORK });
  // bare HEAD 指向 main 后本地 file 克隆（模拟协作者视角）
  run(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: ORIGIN });
  run(['clone', '-q', ORIGIN, CLONE]);

  // 断言自检
  const inside = run(['rev-parse', '--is-inside-work-tree'], { cwd: WORK }).stdout.trim();
  if (inside !== 'true') throw new Error('夹具自检失败：work 不是 git 仓库');
  const branches = run(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: WORK }).stdout;
  for (const b of ['main', 'feature']) {
    if (!branches.split(/\r?\n/).includes(b)) throw new Error(`夹具自检失败：缺少分支 ${b}`);
  }
  if (run(['tag'], { cwd: WORK }).stdout.trim() !== 'v1.0') throw new Error('夹具自检失败：缺少 tag v1.0');
  if (!run(['stash', 'list'], { cwd: WORK }).stdout.includes('stash@{0}')) throw new Error('夹具自检失败：缺少 stash');
  if (run(['remote'], { cwd: WORK }).stdout.trim() !== 'origin') throw new Error('夹具自检失败：缺少远程 origin');
}

// ───────── 场景执行框架 ─────────

/** @type {Map<number, {ok: boolean, failures: string[], asserts: number, ms: number}>} */
const results = new Map();
/** 发现清单（如实上报，不计入通过/失败） */
const FINDINGS = [];
const DESCS = {
  1: '输入 git reb + Tab 补全为 rebase，语法骨架与当前位置标注',
  2: 'git push 后候选为远程名，选 origin 后切换为分支名',
  3: '输入 -- 后选项候选附中文一行说明，选中项详情含作用与示例',
  4: '已输入 -i 后 --interactive 不再出现（互斥/已用剔除）',
  5: 'Enter 执行 git status：历史区捕获输出与直接执行逐字节一致、完成即回输入态、状态栏 ✔ exit 0；真 REPL 端到端：孙进程输出流入历史区 + 执行期用户按键经转发抵达孙进程并被回显',
  6: 'git chekcout → 纠错建议 Did you mean: checkout',
  7: '会话内第二次以后 ↑ 可回溯历史并再次执行',
  8: 'gitcue "git log --on" 稳定纯文本建议、退出码 0、两次输出逐字节一致',
  9: '非 git 目录启动：动态候选禁用并有一行提示，静态功能正常',
  10: '性能：10 万次随机按键回放 P95 < 50ms、P99 < 100ms + 生产模式渲染抽样 < 50ms；冷启动单次模式 < 300ms 且知识库加载 < 200ms；REPL 首帧 < 1500ms（300ms 目标判定照算照报，超标记入发现清单）',
  11: '未收录命令 git mytool 不报错、提示未收录，--exec 可直接执行',
  12: '附加：知识库完整性——25 个命令全部加载、schema 校验通过、validate-data 退出码 0',
  13: '旧名残留核查：孤儿产物清除；产品文件集与 .sandbox/ 路径归一化后零旧名残留；react/ink import 白名单；入口与环境现值核查',
};

async function runScenario(id, fn) {
  const rec = { ok: true, failures: [], asserts: 0, ms: 0 };
  results.set(id, rec);
  const t0 = performance.now();
  const ok = (cond, msg) => {
    rec.asserts += 1;
    if (!cond) {
      rec.ok = false;
      rec.failures.push(msg);
      throw new Error(msg);
    }
  };
  const soft = (cond, msg) => {
    // 计入断言但失败不中断场景（用于同场景内多条独立断言）
    rec.asserts += 1;
    if (!cond) {
      rec.ok = false;
      rec.failures.push(msg);
    }
  };
  try {
    await fn({ ok, soft });
  } catch (err) {
    if (rec.failures.length === 0) {
      rec.ok = false;
      rec.failures.push(`场景异常中止：${err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err)}`);
    }
  }
  rec.ms = Math.round(performance.now() - t0);
  const mark = rec.ok ? '✔' : '✘';
  console.log(`场景 ${id}: ${mark} ${DESCS[id]}（${rec.asserts} 断言，${rec.ms}ms）`);
  if (!rec.ok) for (const f of rec.failures) console.log(`      ✘ ${f}`);
}

// ───────── 无头驱动公共件 ─────────

const { loadKnowledgeBase } = await import(pathToFileURL(path.join(ROOT_DIR, 'src/kb/loader.mjs')).href);
const { createSuggest } = await import(pathToFileURL(path.join(ROOT_DIR, 'src/parser/suggest.mjs')).href);
const { createController } = await import(pathToFileURL(path.join(ROOT_DIR, 'src/ui/controller.mjs')).href);
const { createHistory } = await import(pathToFileURL(path.join(ROOT_DIR, 'src/history.mjs')).href);
const { createProviders } = await import(pathToFileURL(path.join(ROOT_DIR, 'src/providers/hub.mjs')).href);
// 无头渲染契约：行级断言唯一入口 renderAppLines + 生产模式采样器
const { renderAppLines, createRenderSampler } = await import(
  pathToFileURL(path.join(ROOT_DIR, 'src/ui/testHarness.mjs')).href
);

const KB = loadKnowledgeBase({ dataDir: path.join(ROOT_DIR, 'data') });
if (!KB || KB.names().length === 0) {
  console.error('知识库加载失败，无法继续验收');
  process.exit(1);
}

/** 无脑 usage（验收不考频率加权时注入，保证确定性） */
const FAKE_USAGE = { count: () => 0, bump() {}, flush() {} };
/**
 * 捕获发布帧的视图（view 契约注入：捕获状态帧，
 * 行级断言经 renderAppLines(state) 复原）
 */
function captureView() {
  const frames = [];
  return {
    frames,
    view: {
      publish(st) {
        frames.push(st);
      },
      suspend() {},
      resume(st) {
        frames.push(st);
      },
      close() {},
    },
  };
}
/** 立即结算的执行器（记录收到的原文） */
function fakeExec(code = 0) {
  const calls = { runs: [] };
  return {
    calls,
    exec: {
      run(cmd) {
        calls.runs.push(cmd);
        return Promise.resolve({ code, durationMs: 0 });
      },
      cancel() {
        return true;
      },
      active() {
        return false;
      },
    },
  };
}
/** 用例独占 home（隔离历史/统计等用户级数据） */
function caseHome(name) {
  const h = path.join(HOME, name);
  rmRetry(h);
  mkdirSync(h, { recursive: true });
  return h;
}
/**
 * 真实 suggest + 可选 providers 的 controller。
 * 不注入 plain 旗标：renderAppLines 与 state.plain 无关（恒为 plain 行形态），
 * 而 state.plain=false 使 GitcueApp 走五区 Ink 树——场景 10 的 createRenderSampler
 * 采样与真实 ANSI REPL 每键渲染同构。
 */
function makeController({ providers = null, exec, historyFile = null, usage = FAKE_USAGE, gitVersion = null }) {
  const { suggest } = createSuggest({ kb: KB, providers, usage, gitVersion });
  const history = historyFile
    ? createHistory({ file: historyFile, limit: 1000, enabled: true, now: () => 1000 })
    : null;
  const cv = captureView();
  const ctl = createController({
    suggest,
    providers,
    exec,
    history,
    usage,
    config: {},
    i18n: { t: (k) => k },
    view: cv.view,
    gitVersion,
    dangerCheck: null,
    home: caseHome('ctl'),
    showGuide: false,
    now: () => 1000,
  });
  return { ctl, cv, suggest };
}
const typeText = (ctl, text) => {
  for (const ch of text) ctl.input({ type: 'printable', ch });
};
const settle = async () => {
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};
/** 轮询等待条件成立（异步 providers 加载/仓库探测） */
async function waitFor(cond, { timeoutMs = 8000, what = '条件' } = {}) {
  const t0 = performance.now();
  for (;;) {
    if (cond()) return true;
    if (performance.now() - t0 > timeoutMs) throw new Error(`等待超时（${what}，${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const PCTL = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const fmt = (x) => (x >= 10 ? x.toFixed(1) : x.toFixed(3));
const hasCJK = (s) => /[\u4e00-\u9fff]/.test(String(s));

// ═══════════════ 场景 1：git reb + Tab → 骨架与当前位置标注 ═══════════════

async function scenario1({ ok }) {
  const { ctl } = makeController({ exec: fakeExec().exec });
  typeText(ctl, 'git reb');
  ok(ctl.state.line === 'git reb', `输入后 line 应为 'git reb'，实际 ${JSON.stringify(ctl.state.line)}`);
  const cands = ctl.state.view.candidates;
  ok(cands.length === 1 && cands[0].text === 'rebase' && cands[0].kind === 'command',
    `'git reb' 前缀过滤后应唯一命中命令候选 rebase，实际 [${cands.map((c) => c.text + ':' + c.kind).join(', ')}]`);

  // 子命令候选应携带详情区数据（作用详述回退 summary、典型示例取条目 examples 首条、
  // 注意事项透传条目 notes），条目级数据不得在 UI 层断链
  ok(typeof cands[0].example === 'string' && /git\s+rebase/.test(cands[0].example),
    `命令候选 rebase 应携带典型示例（条目 examples 首条），实际 ${JSON.stringify(cands[0].example)}`);
  ok(Array.isArray(cands[0].notes) && cands[0].notes.length > 0,
    `命令候选 rebase 应携带注意事项（条目 notes），实际 ${JSON.stringify(cands[0].notes)}`);
  ctl.input({ type: 'function', n: 1 }); // F1 展开详情
  const detailLines = renderAppLines({ ...ctl.state, now: 1000 });
  ok(detailLines.some((l) => /例：\s*git\s+rebase/.test(l)), 'F1 展开后详情区应渲染典型示例行（例：git rebase …）');
  ok(detailLines.some((l) => l.includes('注意：')), 'F1 展开后详情区应渲染注意事项行（注意：…）');
  ctl.input({ type: 'function', n: 1 }); // 收回详情，恢复默认一行

  ctl.input({ type: 'tab' });
  ok(ctl.state.line === 'git rebase ', `Tab 补全后 line 应为 'git rebase '，实际 ${JSON.stringify(ctl.state.line)}`);

  const v = ctl.state.view;
  const sk = v.skeleton;
  ok(sk.text === 'git rebase [-i] [--onto <newbase>] [<upstream>] [<branch>]',
    `语法骨架应与官方骨架逐字一致（验收锚点），实际 ${JSON.stringify(sk.text)}`);
  const upstreamAt = sk.text.indexOf('[<upstream>]');
  ok(sk.cursor === upstreamAt, `光标位应标注在 [<upstream>] 之前（offset ${upstreamAt}），实际 ${sk.cursor}`);
  const upMark = sk.marks.find((m) => m.patternId === 'rebase:pos:<upstream>');
  ok(upMark && upMark.state === 'available', '当前位置对应的 <upstream> 段应标记为 available（光标位标注）');
  // 命令头应在 consumed 标注内（「已输入」高亮）
  const cmdMark = sk.marks.find((m) => m.patternId === 'rebase:cmd:rebase');
  ok(cmdMark && cmdMark.state === 'consumed',
    `骨架应含命令头 rebase 的 consumed 标注（Tab 补全后「已输入」），实际 ${JSON.stringify(cmdMark)}`);
  ok(cmdMark && sk.text.slice(cmdMark.start, cmdMark.end) === 'rebase',
    `命令头 consumed 标注应恰好覆盖文本段 'rebase'，实际覆盖 ${cmdMark ? JSON.stringify(sk.text.slice(cmdMark.start, cmdMark.end)) : '无'}`);

  // 渲染层：标注行（两空格缩进，区别于输入行光标 ▏）含 ▏（当前位置）与 └ 当前位置 说明；
  // 命令头 consumed → 「└ 已输入」标注行
  const lines = renderAppLines({ ...ctl.state, now: 1000 });
  const marker = lines.find((l) => l.startsWith('  ') && l.includes('▏'));
  ok(marker !== undefined, '渲染应含当前位置标注行 ▏（骨架下方标注）');
  if (marker) {
    const col = marker.indexOf('▏');
    ok(col === 2 + upstreamAt, `标注行 ▏ 应对齐骨架 [<upstream>] 前（列 ${2 + upstreamAt}），实际列 ${col}`);
  }
  ok(lines.some((l) => l.includes('└ 当前位置')), '标注行应含「└ 当前位置」中文说明');
  ok(lines.some((l) => l.includes('└ 已输入')), '标注行应含「└ 已输入」（命令头 rebase 已输入标注）');
}

// ═══════════════ 场景 2：git push 远程 → 分支（真实 ProviderHub） ═══════════════

async function scenario2({ ok }) {
  const providers = createProviders({ cwd: WORK, cacheTtlMs: 30_000 });
  const { ctl } = makeController({ providers, exec: fakeExec().exec });
  try {
    typeText(ctl, 'git push ');
    await waitFor(() => providers.snapshot('remote').status === 'ready', { what: 'remote 候选就绪' });
    await waitFor(() => ctl.state.view.candidates.some((c) => c.kind === 'dynamic' && c.text === 'origin'),
      { what: '界面出现 origin 动态候选' });
    const v1 = ctl.state.view.candidates;
    ok(v1.some((c) => c.kind === 'dynamic' && c.text === 'origin'),
      `'git push ' 候选应列出本仓库全部远程名（origin，dynamic），实际 [${v1.filter((c) => c.kind === 'dynamic').map((c) => c.text).join(', ')}]`);
    ok(v1.some((c) => c.kind === 'placeholder' && c.text === '<repository>'),
      '候选应含 <repository> 占位符');

    typeText(ctl, 'o');
    const v2 = ctl.state.view.candidates;
    ok(v2.length === 1 && v2[0].text === 'origin' && v2[0].kind === 'dynamic',
      `输入 o 后应唯一过滤出 origin，实际 [${v2.map((c) => c.text).join(', ')}]`);
    ctl.input({ type: 'tab' });
    ok(ctl.state.line === 'git push origin ', `Tab 选定 origin 后 line 应为 'git push origin '，实际 ${JSON.stringify(ctl.state.line)}`);

    await waitFor(() => providers.snapshot('branch').status === 'ready', { what: 'branch 候选就绪' });
    await waitFor(() => ctl.state.view.candidates.some((c) => c.kind === 'dynamic' && c.text === 'main'),
      { what: '界面出现分支动态候选' });
    const v3 = ctl.state.view.candidates.filter((c) => c.kind === 'dynamic');
    const texts = v3.map((c) => c.text);
    ok(texts.includes('main') && texts.includes('feature'),
      `选定 origin 后候选应切换为分支名（含 main、feature），实际 [${texts.join(', ')}]`);
    ok(!texts.includes('origin'), '选定 origin 后不应再出现远程名 origin 作为动态候选');
  } finally {
    providers.close();
  }
}

// ═══════════════ 场景 3：-- 选项候选中文说明 + 详情（作用与示例） ═══════════════

async function scenario3({ ok, soft }) {
  const { ctl } = makeController({ exec: fakeExec().exec });
  typeText(ctl, 'git rebase --');
  const v = ctl.state.view;
  const cands = v.candidates;
  ok(cands.length >= 8, `输入 -- 后应列出 rebase 的全部长选项（≥8 条），实际 ${cands.length} 条`);
  ok(cands.every((c) => c.kind === 'option'), '候选应全为选项（kind=option）');
  ok(cands.every((c) => c.text.startsWith('--')), '选项候选均应以 -- 开头');
  ok(cands.every((c) => hasCJK(c.summary) && c.summary.trim() !== ''),
    '每个选项候选应附带非空中文一行说明');
  const onto = cands.find((c) => c.text === '--onto');
  ok(onto && onto.paramHint === '<newbase>', '--onto 候选应带参数位提示 <newbase>');
  const kbSel = cands.find((c) => c.text === '--keep-base');
  ok(kbSel !== undefined, '候选应含 --keep-base');
  ok(kbSel && kbSel.summary.includes('共同祖先'), `--keep-base 一行说明应含「共同祖先」，实际 ${kbSel && kbSel.summary}`);

  // 高亮 --keep-base（↓ 移动），断言候选行渲染与详情区
  const idx = cands.findIndex((c) => c.text === '--keep-base');
  for (let i = 0; i < idx; i += 1) ctl.input({ type: 'arrow', dir: 'down' });
  ok(ctl.state.selected === idx, `↓ 移动后高亮应落在 --keep-base（${idx}），实际 ${ctl.state.selected}`);
  const lines0 = renderAppLines({ ...ctl.state, now: 1000 });
  const rowLine = lines0.find((l) => l.includes('--keep-base') && l.includes('共同祖先'));
  ok(rowLine !== undefined, '高亮候选行应同时含关键字 --keep-base 与其中文说明');

  // 详情区：作用（含详述）与示例
  const detailLines = lines0.filter((l) => l.startsWith('说明:') || l.startsWith('详情'));
  ok(detailLines.some((l) => l.includes('共同祖先')), '详情区默认行应含作用说明（共同祖先）');
  ctl.input({ type: 'function', n: 1 }); // F1 展开详情
  const lines1 = renderAppLines({ ...ctl.state, now: 1000 });
  // 严格断言：详情含作用详述与示例——选项候选携带 pattern 级 detail/example
  //（src/parser/suggest.mjs buildOptionCandidates 透传），appView detailZone 渲染。
  soft(
    kbSel && typeof kbSel.detail === 'string' && kbSel.detail.includes('不移动到 <upstream>'),
    `--keep-base 候选应携带作用详述 detail（含「不移动到 <upstream>」），实际 ${JSON.stringify(kbSel && kbSel.detail)}`,
  );
  soft(
    kbSel && typeof kbSel.example === 'string' && /git\s+rebase\s+--keep-base/.test(kbSel.example),
    `--keep-base 候选应携带示例 example（git rebase --keep-base …），实际 ${JSON.stringify(kbSel && kbSel.example)}`,
  );
  soft(
    lines1.some((l) => /例：\s*git\s+rebase\s+--keep-base/.test(l)),
    'F1 展开后详情区应渲染示例行（例：git rebase --keep-base …）',
  );
  const detailFull = lines1.find((l) => l.startsWith('说明:'));
  soft(detailFull && detailFull.includes('不移动到'), 'F1 展开后详情区应显示作用详述全文（含「不移动到 <upstream>」）');
}

// ═══════════════ 场景 4：互斥/已用剔除 ═══════════════

async function scenario4({ ok }) {
  const { suggest } = makeController({ exec: fakeExec().exec });
  for (const line of ['git rebase -i ', 'git rebase --interactive ']) {
    const r = suggest(line, line.length);
    const texts = r.candidates.map((c) => c.text);
    ok(!texts.includes('-i'), `输入 ${JSON.stringify(line)} 后候选不应再出现 -i（已用剔除）`);
    ok(!texts.includes('--interactive'), `输入 ${JSON.stringify(line)} 后候选不应再出现 --interactive（互斥联动）`);
  }
  const r = suggest('git rebase -i ', 14);
  const mark = r.skeleton.marks.find((m) => m.patternId === 'rebase:opt:-i');
  ok(mark && mark.state === 'consumed', '骨架中 -i 段应标记为已消耗（consumed，动态收缩）');
  const cands = suggest('git rebase ', 12).candidates.map((c) => c.text);
  ok(cands.includes('-i') && cands.includes('--interactive'), '未输入时 -i 与 --interactive 均应出现（对照）');
}

// ═══════════════ 场景 5：Enter 执行 git status（真实执行入口 + 真 REPL 端到端） ═══════════════

async function scenario5({ ok }) {
  // 5a. 子进程驱动「controller(真实 runner) → Enter → git status」（内联形态，与 bin 默认一致）：
  //     子进程 stdout/stderr 经 pipe 捕获进历史区条目；执行完成直接回输入态。
  //     helper 以 view 契约注入，状态帧经 renderAppLines 复原行断言。
  const helper = path.join(TMP, 's5-exec.mjs');
  writeFileSync(
    helper,
    `import { pathToFileURL } from 'node:url';
const ROOT = ${JSON.stringify(ROOT_DIR)};
const WORK = ${JSON.stringify(WORK)};
const HOME = ${JSON.stringify(caseHome('s5'))};
const { loadKnowledgeBase } = await import(pathToFileURL(ROOT + '/src/kb/loader.mjs').href);
const { createSuggest } = await import(pathToFileURL(ROOT + '/src/parser/suggest.mjs').href);
const { createController } = await import(pathToFileURL(ROOT + '/src/ui/controller.mjs').href);
const { createRunner } = await import(pathToFileURL(ROOT + '/src/exec/runner.mjs').href);
const { renderAppLines } = await import(pathToFileURL(ROOT + '/src/ui/testHarness.mjs').href);
const kb = loadKnowledgeBase({ dataDir: ROOT + '/data' });
const { suggest } = createSuggest({ kb });
const frames = [];
const runner = createRunner({ cwd: WORK, env: process.env, capture: true });
const ctl = createController({
  suggest, providers: null, exec: runner, history: null, usage: null,
  config: { exec_output: 'inline' }, i18n: { t: (k) => k },
  view: { publish(st) { frames.push(st); }, suspend() {}, resume(st) { frames.push(st); }, close() {} },
  gitVersion: null, home: HOME, showGuide: false, now: () => 1000,
});
for (const ch of 'git status') ctl.input({ type: 'printable', ch });
ctl.input({ type: 'enter' });
const t0 = Date.now();
while (ctl.state.lastExit === null && Date.now() - t0 < 15000) {
  await new Promise((r) => setTimeout(r, 25));
}
const s = ctl.state;
process.stderr.write('S5RESULT ' + JSON.stringify({
  mode: s.mode,
  line: s.line,
  exit: s.lastExit ? s.lastExit.code : null,
  statusShown: frames.some((st) => renderAppLines(st).some((l) => String(l).includes('✔ exit 0'))),
  logShown: frames.some((st) => renderAppLines(st).some((l) => String(l).includes('$ git status'))),
  logOutput: s.execLog && s.execLog[0] ? s.execLog[0].output : null,
}) + '\\n');
process.exitCode = s.lastExit ? s.lastExit.code : 1;
`,
    'utf8',
  );
  const viaEntry = spawnSync(process.execPath, [helper], { cwd: WORK, env: childEnv(), timeout: 60_000 });
  ok(viaEntry.status === 0, `经执行入口运行 git status 退出码应为 0，实际 ${viaEntry.status}`);
  const s5line = viaEntry.stderr.toString('utf8').split(/\r?\n/).find((l) => l.startsWith('S5RESULT '));
  ok(s5line !== undefined, '执行入口 helper 应输出 S5RESULT 状态行');
  if (s5line) {
    const st = JSON.parse(s5line.slice('S5RESULT '.length));
    ok(st.mode === 'input', `执行完成应直接回输入态（内联形态，命令在历史区），实际 ${st.mode}`);
    ok(st.line === '', `执行后输入行应自动清空，实际 ${JSON.stringify(st.line)}`);
    ok(st.exit === 0, `状态栏退出码应为 0，实际 ${st.exit}`);
    ok(st.statusShown === true, '界面应呈现「✔ exit 0」状态');
    ok(st.logShown === true, '历史区应渲染「$ git status」命令行');
  }

  // 5b. 历史区捕获的输出与直接执行逐字节一致（内联捕获不改写输出）
  const direct = spawnSync('git', ['status'], { cwd: WORK, env: childEnv(), timeout: 60_000, encoding: 'utf8' });
  ok(direct.status === 0, `直接执行 git status 退出码应为 0，实际 ${direct.status}`);
  if (s5line) {
    const st = JSON.parse(s5line.slice('S5RESULT '.length));
    ok(st.logOutput === direct.stdout,
      `历史区捕获输出应与直接执行逐字节一致（捕获 ${st.logOutput === null ? 'null' : st.logOutput.length} 字符 vs 直接 ${direct.stdout.length} 字符）\n` +
        `捕获: ${JSON.stringify(String(st.logOutput).slice(0, 200))}\n直接: ${JSON.stringify(direct.stdout.slice(0, 200))}`);
  }

  // 5c. 忠实交互（真 REPL 端到端：执行期用户按键经 controller 解码重建字节写入子进程
  //     pipe stdin，孙进程可实际读到并回显）。
  //     孙进程用脚本文件驱动（node <path>.mjs）——不用 node -e 内联脚本：Windows cmd 对
  //     嵌套双引号参数的解析会切坏 -e 脚本体（历史区渲染的命令行文本与 SyntaxError
  //     输出的假阳性污染，脚本文件形态杜绝两类假阳性）。
  //     断言：① Enter 经真实键路径触发执行（…运行中帧）；② 孙进程 stdout（CHILD-STARTED/
  //     CHILD-DONE）流式进入窗口历史区；③ 执行期按键 hello 经转发抵达孙进程并被回显
  //     （CHILD-GOT，逐键分块形态不锁死）；④ 完成帧呈现「✔ exit 0」。
  const replHome = caseHome('s5c');
  // 本场景专测内联形态（默认已是 passthrough）：经沙箱 GITCUE_HOME 的 config.toml 钉住
  writeFileSync(path.join(replHome, 'config.toml'), 'exec_output = "inline"\n', 'utf8');
  const childScript = path.join(TMP, 's5-child.mjs');
  writeFileSync(
    childScript,
    [
      "process.stdout.write('CHILD-STARTED\\n');",
      "process.stdin.on('data', (d) => process.stdout.write('CHILD-GOT:' + JSON.stringify(d.toString()) + '\\n'));",
      "setTimeout(() => { process.stdout.write('CHILD-DONE\\n'); process.exit(0); }, 3000);",
      '',
    ].join('\n'),
    'utf8',
  );
  const grandchild = `node ${childScript.split(path.sep).join('/')}`;
  const repl = spawn(
    process.execPath,
    [path.join(ROOT_DIR, 'bin', 'gitcue.mjs')],
    { cwd: ROOT_DIR, env: childEnv({ GITCUE_HOME: replHome }), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let replOut = '';
  const replErr = [];
  repl.stdout.on('data', (d) => (replOut += d.toString('utf8')));
  repl.stderr.on('data', (d) => replErr.push(d.toString('utf8')));
  // 等首帧（mount 完成、键监听已挂）后再注入命令行 + Enter
  await waitFor(() => replOut.length > 0, { timeoutMs: 20_000, what: 'REPL 首帧（mount 完成）' });
  repl.stdin.write(grandchild + '\r');
  // 等真实孙进程输出（标记词不在命令行内，历史区渲染命令行不会造成假阳性）
  await waitFor(() => replOut.includes('CHILD-STARTED'), { timeoutMs: 20_000, what: '孙进程启动（CHILD-STARTED 流入历史区）' });
  // 执行期按键（hello + Enter）：解码为 printable×5 + enter，controller 重建字节逐键写入
  try {
    repl.stdin.write('hello\r');
  } catch {
    /* REPL 已退出则由断言暴露 */
  }
  // 轮询完整生命周期：按键转发回显 → 孙进程收尾 → 完成帧 ✔ exit 0
  await waitFor(
    () => replOut.includes('CHILD-GOT:') && replOut.includes('CHILD-DONE') && replOut.includes('✔ exit 0'),
    { timeoutMs: 30_000, what: '真 REPL 端到端（按键转发回显/孙进程输出/完成帧）' },
  );
  try {
    repl.stdin.end();
  } catch {
    /* 忽略 */
  }
  repl.kill();
  ok(replOut.includes('…运行中'), `Enter 经真实键路径应触发执行态（…运行中 帧），实际输出尾段 ${JSON.stringify(replOut.slice(-400))}`);
  ok(replOut.includes('CHILD-STARTED') && replOut.includes('CHILD-DONE'),
    `孙进程应启动且其输出应流式进入窗口历史区（CHILD-STARTED/CHILD-DONE，内联捕获），实际 ${JSON.stringify(replOut.slice(-400))}`);
  const gotEcho = [...replOut.matchAll(/CHILD-GOT:(?:"[^\n]*")/g)].map((m) => m[0]).join('');
  const gotPlain = gotEcho.replace(/CHILD-GOT:|["\\]/g, '');
  ok(
    gotPlain.includes('hello'),
    `执行期用户按键应经转发抵达孙进程并被回显（CHILD-GOT 分块拼接后含 hello，忠实交互），实际 ${JSON.stringify(gotEcho.slice(0, 200))}`,
  );
  ok(replOut.includes('✔ exit 0'),
    `执行完成后窗口应呈现「✔ exit 0」并回到输入态，实际 ${JSON.stringify(replOut.slice(-400))}（stderr: ${replErr.join('').trim().slice(0, 200)}）`);
}

// ═══════════════ 场景 6：纠错建议 ═══════════════

async function scenario6({ ok }) {
  const { ctl } = makeController({ exec: fakeExec().exec });
  typeText(ctl, 'git chekcout ');
  const v = ctl.state.view;
  ok(v.corrections.length > 0 && v.corrections[0].suggestions.includes('checkout'),
    `git chekcout 应给出纠错建议 checkout（编辑距离 ≤2），实际 ${JSON.stringify(v.corrections)}`);
  const corr = v.candidates.find((c) => c.kind === 'correction' && c.text === 'checkout');
  ok(corr !== undefined, '候选区应置顶 correction 候选 checkout');
  const lines = renderAppLines({ ...ctl.state, now: 1000 });
  ok(lines.some((l) => l.includes('Did you mean: checkout')), '渲染应含「Did you mean: checkout」提示');
  // Tab 采纳：替换错拼 Token
  ctl.input({ type: 'tab' });
  ok(ctl.state.line === 'git checkout ', `Tab 采纳纠错后 line 应为 'git checkout '，实际 ${JSON.stringify(ctl.state.line)}`);
}

// ═══════════════ 场景 7：历史回溯并再次执行 ═══════════════

async function scenario7({ ok, soft }) {
  const fx = fakeExec();
  const { ctl } = makeController({ exec: fx.exec, historyFile: path.join(caseHome('s7'), 'history.jsonl') });
  const type = (s) => typeText(ctl, s);
  // 执行 A、B 两条命令
  type('git status');
  ctl.input({ type: 'enter' });
  await settle();
  type('git log');
  ctl.input({ type: 'enter' });
  await settle();
  ok(JSON.stringify(ctl.state.historyList) === JSON.stringify(['git log', 'git status']),
    `两次执行后历史应为 [git log, git status]（最近在前），实际 ${JSON.stringify(ctl.state.historyList)}`);
  ok(ctl.state.mode === 'input' && ctl.state.line === '',
    `执行完成应直接回输入态且输入行清空（内联形态），实际 mode=${ctl.state.mode} line=${JSON.stringify(ctl.state.line)}`);

  // 完成即输入态：空行无候选，首个 ↑ 直接进入回溯；↑↑↓ 浏览。
  // 回溯进行中（historyIndex 非空）时 ↑↓ 持续浏览历史，不被回溯行的候选高亮抢占
  //（src/ui/reducer.mjs arrow 分支：historyIndex 判定先于候选高亮）。
  ctl.input({ type: 'arrow', dir: 'up' });
  soft(ctl.state.line === 'git log', `第一次 ↑ 应回溯最近一条 git log，实际 ${JSON.stringify(ctl.state.line)}`);
  ctl.input({ type: 'arrow', dir: 'up' });
  soft(ctl.state.line === 'git status', `第二次 ↑ 应继续回溯更早一条 git status（第二次以后 ↑ 可回溯），实际 ${JSON.stringify(ctl.state.line)}`);
  ctl.input({ type: 'arrow', dir: 'down' });
  soft(ctl.state.line === 'git log', `↓ 应后退回 git log，实际 ${JSON.stringify(ctl.state.line)}`);
  ctl.input({ type: 'enter' });
  await settle();
  const last = fx.calls.runs[fx.calls.runs.length - 1];
  ok(last === 'git log', `回溯后 Enter 应再次执行 git log，exec 收到 ${JSON.stringify(last)}`);
  ok(fx.calls.runs.length === 3, `exec 应共收到 3 次执行（A、B、回溯再执行），实际 ${fx.calls.runs.length}`);
}

// ═══════════════ 场景 8：单次模式稳定输出 ═══════════════

async function scenario8({ ok }) {
  const run = () =>
    spawnSync(
      process.execPath,
      [path.join(ROOT_DIR, 'bin', 'gitcue.mjs'), 'git log --on', '--plain'],
      { cwd: WORK, env: childEnv(), encoding: 'utf8', timeout: 60_000 },
    );
  const r1 = run();
  const r2 = run();
  ok(r1.status === 0 && r2.status === 0, `单次模式退出码应为 0，实际 ${r1.status}/${r2.status}`);
  const out = r1.stdout;
  ok(out.startsWith('语法: git log'), `输出应以「语法: git log」开头（稳定行前缀），实际开头 ${JSON.stringify(out.slice(0, 40))}`);
  ok(out.includes('候选(1):'), `输出应含候选区标题「候选(1):」，实际含「候选(」=${out.includes('候选(')}`);
  ok(out.includes('--oneline'), '候选应含 --oneline（前缀 --on 过滤）');
  ok(out.includes('每条提交压成一行显示'), '候选应附带中文一行说明');
  ok(out.includes('提示: （无）'), '无纠错时应输出「提示: （无）」');
  ok(r1.stdout === r2.stdout, '同输入两次运行输出应逐字节一致（输出稳定性）');
}

// ═══════════════ 场景 9：非 git 目录 ═══════════════

async function scenario9({ ok }) {
  // 9a. REPL 等价：真实 ProviderHub 在非仓库目录探测 → 禁用动态候选 + 一行提示
  const providers = createProviders({ cwd: EMPTY, cacheTtlMs: 30_000 });
  const { ctl } = makeController({ providers, exec: fakeExec().exec });
  try {
    await waitFor(() => providers.repoInfo().isRepo === false, { what: '非仓库探测完成' });
    typeText(ctl, 'git push ');
    await waitFor(() => providers.snapshot('remote').status === 'disabled', { what: 'remote 候选禁用' });
    const v = ctl.state.view;
    const dyn = v.candidates.filter((c) => c.kind === 'dynamic');
    ok(dyn.length === 0, `非仓库目录动态候选应禁用（dynamic=0），实际 [${dyn.map((c) => c.text).join(', ')}]`);
    ok(v.candidates.some((c) => c.kind === 'placeholder' && c.text === '<repository>'),
      '占位符候选仍应出现');
    ok(v.candidates.some((c) => c.kind === 'option' && c.text === '--force'),
      '静态候选（选项）应不受影响');
    const lines = renderAppLines({ ...ctl.state, now: 1000 });
    ok(lines.some((l) => l.includes('（当前目录不是 git 仓库）')), '界面应有一行「（当前目录不是 git 仓库）」提示');
  } finally {
    providers.close();
  }

  // 9b. CLI：非仓库目录下单次模式静态功能正常
  const r = spawnSync(
    process.execPath,
    [path.join(ROOT_DIR, 'bin', 'gitcue.mjs'), 'git push ', '--plain'],
    { cwd: EMPTY, env: childEnv(), encoding: 'utf8', timeout: 60_000 },
  );
  ok(r.status === 0, `非仓库目录单次模式退出码应为 0，实际 ${r.status}`);
  ok(r.stdout.includes('候选(') && r.stdout.includes('--force'), '非仓库目录静态候选应正常输出');
}

// ═══════════════ 场景 10：性能 ═══════════════

async function scenario10({ ok, soft }) {
  // 10a. 固定种子随机按键 10 万次回放 suggest 管线（样本量 100,000；计算层
  //      P95 < 50ms 且 P99 < 100ms 双阈值）。
  //      两段分布（合计 100,000 键，固定种子可复现）：
  //       A. 原始分布（字符集 'git albcheoupstnri-=/d'）；
  //       B. git 加权分布（真实子命令字母集），保证已收录命令的解析/候选/渲染路径被实质覆盖
  //          ——仅用 A 时绝大多数样本走 passthrough 短路，测不到知识库管线（如实注明）。
  const N_A = 60_000;
  const N_B = 40_000;
  const mulberry32 = (seed) => {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const rnd = mulberry32(0x20261010);
  const CHARSET_A = 'git albcheoupstnri-=/d';
  const CHARSET_B = 'git rebaspushlogcommitstash-branchcheck=';
  // fake providers：branch/tag 各 200 项模拟大仓库
  const bigItems = (kind, n) =>
    Array.from({ length: n }, (_, i) => ({
      value: `${kind}${i}`, label: `${kind}${i}`, summary: `${kind} 候选 ${i}`, popularity: 3, kind,
    }));
  const snapshots = {
    branch: { status: 'ready', items: bigItems('b', 200), updatedAt: 1, error: null },
    tag: { status: 'ready', items: bigItems('t', 200), updatedAt: 1, error: null },
    remote: { status: 'ready', items: [{ value: 'origin', label: 'origin', summary: '远程', popularity: 3, kind: 'remote' }], updatedAt: 1, error: null },
    commit: { status: 'ready', items: [], updatedAt: 1, error: null },
    stash: { status: 'ready', items: [], updatedAt: 1, error: null },
    pathspec: { status: 'ready', items: [], updatedAt: 1, error: null },
  };
  const fakeProviders = {
    snapshot: (kind) => snapshots[kind] ?? { status: 'disabled', items: [], updatedAt: null, error: null },
    repoInfo: () => ({ isRepo: true, branch: 'main', checkedAt: 1 }),
    ensure() {}, invalidate() {}, invalidateAfterCommand() {}, recheckRepo() {}, on() {}, close() {},
  };
  const fx = fakeExec();
  const { ctl } = makeController({
    providers: fakeProviders, exec: fx.exec,
    historyFile: path.join(caseHome('s10'), 'history.jsonl'),
  });
  const samples = [];
  const samplesA = [];
  const samplesB = [];
  const coveredSamples = [];
  let crashed = 0;

  // 10a-2. 生产模式渲染抽样：createRenderSampler 常驻生产模式 Ink 实例（真实 render、
  //        哑 stdout、debug:false，构造已丢弃前 2 次预热 sample）；回放期间每 500 键同步
  //        采样一次（rerender 耗时，与真实 ANSI REPL 每键渲染同构），断言单次最大 < 50ms
  //        （渲染上限）。禁止以 itl（renderAppFrame）做耗时断言——itl 固定 debug:true，
  //        单次 mount ≈100–122ms 属 debug 伪影。每次抽样同时做 renderAppLines(state)
  //        非空内容契约守卫（不计时）。
  const sampler = createRenderSampler();
  const renderMs = [];
  let replayCount = 0;
  const maybeRenderSample = () => {
    replayCount += 1;
    if (replayCount % 500 !== 0) return;
    renderMs.push(sampler.sample(ctl.state));
    soft(
      renderAppLines(ctl.state).length > 0,
      `渲染抽样点 #${replayCount} 的 renderAppLines(state) 应非空（内容契约守卫，exited 态除外——回放无退出键）`,
    );
  };

  /** 单键回放：计时同步链路（handleKey + attachView(suggest) + view.publish），异步 exec 回调不计入 */
  function replay(key) {
    const t0 = performance.now();
    try {
      ctl.input(key);
    } catch {
      crashed += 1;
    }
    const dt = performance.now() - t0;
    samples.push(dt);
    (charset === 'A' ? samplesA : samplesB).push(dt);
    const v = ctl.state.view;
    if (v && v.covered === true) coveredSamples.push(dt);
  }
  let charset = 'A';
  try {
    for (let i = 0; i < N_A; i += 1) {
      const r = rnd();
      let key;
      if (r < 0.7) key = { type: 'printable', ch: CHARSET_A[Math.floor(rnd() * CHARSET_A.length)] };
      else if (r < 0.8) key = { type: 'tab' };
      else if (r < 0.88) {
        const dirs = ['up', 'down', 'left', 'right'];
        key = rnd() < 0.75
          ? { type: 'arrow', dir: dirs[Math.floor(rnd() * dirs.length)] }
          : { type: 'page', dir: rnd() < 0.5 ? 'up' : 'down' };
      } else if (r < 0.93) key = { type: 'enter' };
      else if (r < 0.97) key = rnd() < 0.5 ? { type: 'backspace' } : { type: 'escape' };
      else if (rnd() < 0.5) key = { type: 'function', n: 1 };
      else key = { type: 'ctrl', ch: ['u', 'w', 'a', 'e'][Math.floor(rnd() * 4)] };
      replay(key);
      maybeRenderSample();
      sanity(i);
      if (key.type === 'enter') await settle(); // 让 fake exec 结算，output 态可被后续按键返回输入态
    }
    charset = 'B';
    const CMDS = ['rebase', 'push', 'log', 'commit', 'stash', 'branch', 'checkout', 'remote', 'reset', 'tag', 'merge', 'pull', 'fetch', 'switch', 'restore'];
    for (let i = 0; i < N_B; i += 1) {
      // 空行（输入态）时高概率注入完整 'git <cmd> ' 前缀（printable 键），确保已收录命令的
      // 解析/候选/渲染路径被实质覆盖——纯随机字母命中完整子命令的概率可忽略（如实注明）
      if (ctl.state.line === '' && ctl.state.mode === 'input' && rnd() < 0.8) {
        const cmd = CMDS[Math.floor(rnd() * CMDS.length)];
        for (const ch of `git ${cmd} `) {
          replay({ type: 'printable', ch });
          maybeRenderSample();
          i += 1;
        }
      }
      const r = rnd();
      let key;
      if (r < 0.75) key = { type: 'printable', ch: CHARSET_B[Math.floor(rnd() * CHARSET_B.length)] };
      else if (r < 0.85) key = { type: 'tab' };
      else if (r < 0.92) {
        const dirs = ['up', 'down', 'left', 'right'];
        key = { type: 'arrow', dir: dirs[Math.floor(rnd() * dirs.length)] };
      } else if (r < 0.96) key = { type: 'enter' };
      else if (r < 0.99) key = rnd() < 0.5 ? { type: 'backspace' } : { type: 'escape' };
      else key = { type: 'function', n: 1 };
      replay(key);
      maybeRenderSample();
      sanity(i);
      if (key.type === 'enter') await settle();
    }
  } finally {
    sampler.close();
  }
  function sanity(i) {
    if (i % 1000 === 0) {
      // 稳定性抽样：state 无 NaN/undefined 关键字段
      const s = ctl.state;
      if (typeof s.line !== 'string' || Number.isNaN(s.cursor) || typeof s.selected !== 'number') {
        crashed += 1;
      }
    }
  }
  ok(crashed === 0, `回放过程不应抛异常或产生非法 state（${crashed} 次）`);
  ok(samples.length >= 100_000, `随机按键样本应 ≥100000（样本 100,000 次），实际 ${samples.length}`);
  const stat = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  };
  const p50 = stat(samples, 50);
  const p95 = stat(samples, 95);
  const p99 = stat(samples, 99);
  ok(p95 < 50, `按键回放 P95 应 < 50ms，实测 P95=${fmt(p95)}ms（P50=${fmt(p50)}ms，P99=${fmt(p99)}ms）`);
  ok(p99 < 100, `P99 应 < 100ms（双阈值），实测 P99=${fmt(p99)}ms`);
  ok(coveredSamples.length >= 500,
    `随机回放应实质覆盖已收录命令路径（covered≥500 键），实际 ${coveredSamples.length} 键`);
  console.log(
    `      性能明细：N=${samples.length}（A=${samplesA.length}，B=${samplesB.length}，其中已收录命令路径 ${coveredSamples.length} 键），` +
      `P50=${fmt(p50)}ms，P95=${fmt(p95)}ms，P99=${fmt(p99)}ms（计算层同步链路口径，异步 exec 回调不计入）`,
  );

  // 渲染抽样断言：单次最大 < 50ms
  const renderMax = renderMs.length ? Math.max(...renderMs) : Number.POSITIVE_INFINITY;
  const renderAvg = renderMs.length ? renderMs.reduce((a, b) => a + b, 0) / renderMs.length : Number.POSITIVE_INFINITY;
  ok(renderMs.length >= 200,
    `生产模式渲染抽样应 ≥200 次（每 500 键一次，回放 ${samples.length} 键），实际 ${renderMs.length} 次`);
  ok(renderMax < 50,
    `生产模式渲染抽样单次耗时应 < 50ms（渲染上限；createRenderSampler 生产路径，非 itl debug 伪影），实测 max=${fmt(renderMax)}ms / 均值=${fmt(renderAvg)}ms（${renderMs.length} 次）`);
  console.log(
    `      渲染抽样明细（createRenderSampler 生产模式，前 2 次预热已丢弃）：N=${renderMs.length}，max=${fmt(renderMax)}ms，均值=${fmt(renderAvg)}ms`,
  );

  // 10b. 冷启动（单次模式完成 KB 加载并输出首屏建议，20 次取中位数）。
  //      该 300ms 硬断言同时是「单次路径未误载 react/ink」的回归守卫（误载必增 ~350ms 而超标）。
  const cold = [];
  for (let i = 0; i < 20; i += 1) {
    const t0 = performance.now();
    const r = spawnSync(
      process.execPath,
      [path.join(ROOT_DIR, 'bin', 'gitcue.mjs'), 'git status', '--plain'],
      { cwd: ROOT_DIR, env: childEnv(), encoding: 'utf8', timeout: 60_000 },
    );
    cold.push(performance.now() - t0);
    if (r.status !== 0) {
      ok(false, `冷启动代理命令退出码应为 0，实际 ${r.status}`);
      return;
    }
  }
  const coldSorted = [...cold].sort((a, b) => a - b);
  const median = coldSorted[Math.floor(coldSorted.length / 2)];
  ok(median < 300, `冷启动中位数应 < 300ms，实测 ${median.toFixed(0)}ms（20 次：${cold.map((t) => t.toFixed(0)).join(',')}ms）`);
  console.log(
    `      冷启动明细（单次模式）：中位 ${median.toFixed(0)}ms，最快 ${coldSorted[0].toFixed(0)}ms，最慢 ${coldSorted[coldSorted.length - 1].toFixed(0)}ms` +
      `（口径：spawn node bin/gitcue.mjs "git status" --plain 墙钟；20 次取中位数）`,
  );

  // 10c. 附加断言：GITCUE_LOG=debug 下知识库加载耗时日志 < 200ms。
  //      bin/gitcue.mjs 以 [gitcue:debug] 知识库加载完成 {"commands":N,"costMs":X} 输出于 stderr。
  const dbg = spawnSync(
    process.execPath,
    [path.join(ROOT_DIR, 'bin', 'gitcue.mjs'), 'git status', '--plain'],
    { cwd: ROOT_DIR, env: childEnv({ GITCUE_LOG: 'debug' }), encoding: 'utf8', timeout: 60_000 },
  );
  const costMatch = /知识库加载完成[^\n]*?"costMs":([0-9]+(?:\.[0-9]+)?)/.exec(dbg.stderr);
  ok(
    costMatch !== null,
    `GITCUE_LOG=debug 应输出知识库加载耗时日志（[gitcue:debug] 知识库加载完成 {...costMs}），实际 stderr=${JSON.stringify(dbg.stderr.slice(0, 200))}`,
  );
  const kbCostMs = costMatch ? Number(costMatch[1]) : Number.POSITIVE_INFINITY;
  ok(kbCostMs < 200, `知识库加载耗时应 < 200ms，实测 ${costMatch ? kbCostMs + 'ms' : '缺失'}`);
  console.log(`      知识库加载耗时（GITCUE_LOG=debug 日志口径）：${costMatch ? kbCostMs + 'ms' : '缺失'} < 200ms`);

  // 10d. REPL 冷启动首帧（无头测量方法）：spawn bin/gitcue.mjs
  //      （cwd=ROOT、stdio=['pipe','pipe','pipe']、GITCUE_HOME=沙箱独占目录、stdin 哑管道），
  //      t0=spawn 前 performance.now()，stdout 首个非空字节时刻 t1，首帧 = t1 - t0；20 次取中位。
  //      双层处置：① 硬断言中位 < 1500ms（工程防回归线）；
  //      ② 300ms 目标判定照算照报——超标记入发现清单（如实上报，不计入通过/失败）。
  const replHome = caseHome('s10-repl');
  // 预写 guide-shown 标记：20 次测量统一为「非首次启动」主屏首帧（确定性口径，如实注明）
  writeFileSync(path.join(replHome, 'guide-shown'), '', 'utf8');
  const measureReplFirstFrame = () =>
    new Promise((resolve) => {
      const t0 = performance.now();
      const child = spawn(
        process.execPath,
        [path.join(ROOT_DIR, 'bin', 'gitcue.mjs')],
        { cwd: ROOT_DIR, env: childEnv({ GITCUE_HOME: replHome }), stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          child.kill();
        } catch {
          /* 忽略 */
        }
        resolve(v);
      };
      const timer = setTimeout(() => finish(-1), 10_000); // 10s 超时判失败
      child.stdout.on('data', (d) => {
        if (d.length > 0) finish(performance.now() - t0); // 首个非空字节 = 首帧就绪
      });
      child.on('error', () => finish(-1));
      child.on('exit', () => {
        if (!settled) finish(-1); // 未出首帧即退出 → 判失败
      });
    });
  const replFrames = [];
  for (let i = 0; i < 20; i += 1) replFrames.push(await measureReplFirstFrame());
  ok(
    replFrames.every((v) => v > 0),
    `REPL 首帧测量 20 次应全部在 10s 内出帧（-1 = 超时/未出帧即退出），实测 [${replFrames.map((v) => v.toFixed(0)).join(',')}ms]`,
  );
  const rfSorted = [...replFrames].sort((a, b) => a - b);
  const rfMedian = rfSorted[Math.floor(rfSorted.length / 2)];
  ok(
    rfMedian < 1500,
    `REPL 冷启动首帧中位数应 < 1500ms（工程防回归硬线，不替代、不混同 300ms 目标判定），实测 ${rfMedian.toFixed(0)}ms（20 次：${replFrames.map((v) => v.toFixed(0)).join(',')}ms）`,
  );
  console.log(
    `      REPL 首帧明细：中位 ${rfMedian.toFixed(0)}ms，最快 ${rfSorted[0].toFixed(0)}ms，最慢 ${rfSorted[rfSorted.length - 1].toFixed(0)}ms` +
      `（口径：spawn 管道 stdout 首个非空字节，guide-shown 预写——非首次启动主屏首帧；20 次取中位）`,
  );
  if (rfMedian >= 300) {
    FINDINGS.push(
      `REPL 冷启动首帧中位 ${rfMedian.toFixed(0)}ms ≥ 300ms 目标——超标（Ink 8 依赖导入地板 ≈334ms + node 启动 ≈90ms），如实上报，不计入通过/失败`,
    );
    console.log(
      `      300ms 目标判定（照算照报）：REPL 首帧中位 ${rfMedian.toFixed(0)}ms ≥ 300ms——超标，已记入发现清单（不计入通过/失败）`,
    );
  } else {
    console.log(`      300ms 目标判定（照算照报）：REPL 首帧中位 ${rfMedian.toFixed(0)}ms < 300ms，达标`);
  }
}

// ═══════════════ 场景 11：未收录命令 ═══════════════

async function scenario11({ ok }) {
  // 11a. REPL 等价：输入不报错、未收录骨架提示、Enter 原文执行
  const fx = fakeExec();
  const { ctl } = makeController({ exec: fx.exec });
  typeText(ctl, 'git mytool ');
  const v = ctl.state.view;
  ok(v.covered === false && v.phase === 'uncovered', `git mytool 应判为未收录（uncovered），实际 covered=${v.covered} phase=${v.phase}`);
  ok(v.skeleton.text === 'git <command> [args...]（未收录，直接执行）',
    `语法区应显示未收录降级文案，实际 ${JSON.stringify(v.skeleton.text)}`);
  ctl.input({ type: 'enter' });
  await settle();
  ok(fx.calls.runs[fx.calls.runs.length - 1] === 'git mytool ',
    `Enter 应按输入行原文直接执行（严格一致，含尾随空格），exec 收到 ${JSON.stringify(fx.calls.runs[fx.calls.runs.length - 1])}`);

  // 11b. CLI --exec：输出建议后附带执行（退出码透传）。
  //      命令行带尾随空格使 mytool 成为已完成 Token（活动词不参与匹配），才进入未收录路径。
  const r = spawnSync(
    process.execPath,
    [path.join(ROOT_DIR, 'bin', 'gitcue.mjs'), 'git mytool ', '--exec', '--plain'],
    { cwd: WORK, env: childEnv(), encoding: 'utf8', timeout: 60_000 },
  );
  ok(r.stdout.includes('未收录'), `--exec 应先输出未收录建议，实际 stdout=${JSON.stringify(r.stdout.slice(0, 160))}`);
  const combined = r.stdout + r.stderr;
  ok(/is not a git command/.test(combined), '应真实执行到 git 本体（git 报 mytool 非法子命令）');
  ok(r.status === 1, `退出码应透传 git 的退出码 1，实际 ${r.status}`);
}

// ═══════════════ 附加：知识库完整性 ═══════════════

async function scenario12({ ok }) {
  const EXPECTED = [
    'add', 'branch', 'checkout', 'cherry-pick', 'clone', 'commit', 'config', 'diff', 'fetch',
    'init', 'log', 'merge', 'mv', 'pull', 'push', 'rebase', 'remote', 'reset', 'restore',
    'revert', 'show', 'stash', 'status', 'switch', 'tag',
  ];
  const names = KB.names();
  ok(names.length === 25, `知识库应加载 25 个命令，实际 ${names.length}`);
  for (const n of EXPECTED) {
    ok(names.includes(n), `知识库应含命令 ${n}`);
  }
  ok(KB.warnings.length === 0, `加载不应产生告警，实际 ${JSON.stringify(KB.warnings)}`);

  const { validateData } = await import(pathToFileURL(path.join(ROOT_DIR, 'src/kb/validate.mjs')).href);
  const res = validateData({ dataDir: path.join(ROOT_DIR, 'data'), customDir: null });
  ok(res.ok === true && res.errors.length === 0, `validateData 应通过（errors=0），实际 ${JSON.stringify(res.errors.slice(0, 3))}`);
  ok(res.passed === 25, `validateData 通过条目应为 25，实际 ${res.passed}`);

  const r = spawnSync(
    process.execPath,
    [path.join(ROOT_DIR, 'bin', 'gitcue.mjs'), 'validate-data'],
    { cwd: ROOT_DIR, env: childEnv(), encoding: 'utf8', timeout: 60_000 },
  );
  ok(r.status === 0, `gitcue validate-data 退出码应为 0，实际 ${r.status}（stderr=${JSON.stringify(r.stderr.slice(0, 200))}）`);
  ok(r.stdout.includes('25 个条目通过') && r.stdout.includes('0 个错误'), 'validate-data 汇总应报告 25 通过 0 错误');
}

// ═══════════════ 场景 13：旧名残留核查（零旧名命中） ═══════════════

/**
 * 旧名 needle 运行时拼装（'git'+'hint'）：本脚本自身在核查集内（scripts/**），
 * 源码不得出现旧名连续字面量，否则自扫描必然命中（自指涉消解）。
 */
const OLD_NAME = ['git', 'hint'].join('');
/** 工作区根路径的文本形态（含 JSON/字面量双反斜杠转义形态与正斜杠形态；大小写不敏感替换） */
const ROOT_BS = ROOT_DIR.split(path.sep).join('\\');
const ROOT_FORMS = [ROOT_BS.split('\\').join('\\\\'), ROOT_BS, ROOT_DIR.split(path.sep).join('/')];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ROOT_RES = ROOT_FORMS.map((f) => new RegExp(escapeRe(f), 'gi'));
/** 工作区路径形态归一化（工作区目录名本身可能含旧名，绝对路径引用不算产品名残留） */
const normalizeRootPaths = (s) => ROOT_RES.reduce((acc, re) => acc.replace(re, '<ROOT>'), s);

/** 递归收集文件（剔除 node_modules 与 zlib 二进制目录 .git/objects） */
function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      if (e.name === 'objects' && path.basename(path.dirname(p)) === '.git') continue;
      walkFiles(p, out);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

/** 扫描单个文件：归一化后大小写不敏感查旧名；返回命中行（file:line: 摘录，至多 5 条） */
function scanFileForOldName(file) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    return [];
  }
  if (buf.includes(0)) return []; // 二进制（内容含 NUL 判定）
  const text = normalizeRootPaths(buf.toString('utf8'));
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].toLowerCase().includes(OLD_NAME)) {
      hits.push(`${path.relative(ROOT_DIR, file).split(path.sep).join('/')}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
      if (hits.length >= 5) break;
    }
  }
  return hits;
}

async function scenario13({ ok }) {
  // 步骤 0：清理陈旧沙箱产物 .sandbox/m6/repl/（含旧名引导文的输出快照；grep 核实
  // test/ scripts/ src/ bin/ 无任何代码引用，重跑测试不重写也不再生成——不删则步骤 2 必命中）。
  const orphan = path.join(ROOT_DIR, '.sandbox', 'm6', 'repl');
  if (existsSync(orphan)) {
    rmRetry(orphan);
    console.log('      步骤 0：已删除孤儿产物 .sandbox/m6/repl/（旧名引导文输出快照；grep 核实无代码引用、重跑不再生）');
  } else {
    console.log('      步骤 0：孤儿产物 .sandbox/m6/repl/ 不存在（此前已清除）');
  }
  ok(!existsSync(orphan), '步骤 0：孤儿产物 .sandbox/m6/repl/ 删除后应不存在');

  // 入口与环境现值核查：bin 入口与 GITCUE_HOME 现值一致
  const pkg = JSON.parse(readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  ok(pkg.name === 'gitcue', `package.json name 应为 gitcue，实际 ${JSON.stringify(pkg.name)}`);
  ok(
    pkg.bin && pkg.bin.gitcue === 'bin/gitcue.mjs',
    `package.json bin.gitcue 应指向 bin/gitcue.mjs，实际 ${JSON.stringify(pkg.bin)}`,
  );
  const { resolveHome } = await import(pathToFileURL(path.join(ROOT_DIR, 'src/config.mjs')).href);
  ok(
    resolveHome({ GITCUE_HOME: path.join(SB, 'env-check') }) === path.join(SB, 'env-check'),
    'resolveHome 应以 GITCUE_HOME 环境变量为用户级数据根',
  );
  ok(
    resolveHome({}) === path.join(os.homedir(), '.gitcue'),
    `GITCUE_HOME 缺省回退应为 ~/.gitcue（不残留旧名目录），实际 ${resolveHome({})}`,
  );

  // 步骤 1：产品文件集（src/bin/scripts/test/data + 根级文件）零旧名命中。
  //   核查规则载体——本脚本自身必须以旧名指称被查对象，经运行时拼装避免自扫描命中（自指涉消解）。
  const productFiles = [];
  for (const d of ['src', 'bin', 'scripts', 'test', 'data']) {
    walkFiles(path.join(ROOT_DIR, d), productFiles);
  }
  for (const f of ['README.md', 'package.json', 'package-lock.json', 'LICENSE']) {
    const p = path.join(ROOT_DIR, ...f.split('/'));
    if (existsSync(p)) productFiles.push(p);
  }
  ok(productFiles.length >= 50, `产品文件集应收集到 ≥50 个文件（src/bin/scripts/test/data + 根级文件），实际 ${productFiles.length}`);
  const productHits = productFiles.flatMap((f) => scanFileForOldName(f));
  ok(
    productHits.length === 0,
    `产品文件集不得残留旧名（工作区路径形态归一化后，大小写不敏感，命中即失败）：\n        ${productHits.join('\n        ')}`,
  );
  console.log(`      步骤 1：产品文件集 ${productFiles.length} 个文件，旧名命中 ${productHits.length} 处`);

  // 步骤 2：.sandbox/**（夹具已由 buildFixture 重建 + 步骤 0 完成后；再生内容同样不允许）
  const sandboxFiles = walkFiles(path.join(ROOT_DIR, '.sandbox'));
  ok(sandboxFiles.length >= 30, `.sandbox 文件集应收集到 ≥30 个文件（夹具已重建），实际 ${sandboxFiles.length}`);
  const sandboxHits = sandboxFiles.flatMap((f) => scanFileForOldName(f));
  ok(
    sandboxHits.length === 0,
    `.sandbox/ 不得残留旧名（含本运行再生内容；路径归一化后大小写不敏感，命中即失败）：\n        ${sandboxHits.join('\n        ')}`,
  );
  console.log(`      步骤 2：.sandbox 文件集 ${sandboxFiles.length} 个文件，旧名命中 ${sandboxHits.length} 处`);

  // 步骤 3：react/ink import 白名单（仅 appView/repl/testHarness 三文件；
  // controller/reducer/keys 保持零第三方 import——保障单次模式与无头驱动不载 react/ink）
  const importRe = /\bfrom\s+['"](ink|react)['"]/;
  const whitelist = new Set(['src/ui/appView.mjs', 'src/ui/repl.mjs', 'src/ui/testHarness.mjs']);
  const matched = [];
  for (const f of productFiles) {
    const rel = path.relative(ROOT_DIR, f).split(path.sep).join('/');
    if (!rel.startsWith('src/') && !rel.startsWith('bin/')) continue;
    let buf;
    try {
      buf = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (importRe.test(buf)) matched.push(rel);
  }
  const illegal = matched.filter((m) => !whitelist.has(m));
  ok(
    illegal.length === 0,
    `src/bin 中 from 'ink'/'react' 的命中文件集必须 ⊆ 白名单 {${[...whitelist].join(', ')}}，越权命中：[${illegal.join(', ')}]，全部命中：[${matched.join(', ')}]`,
  );
  for (const frozen of ['src/ui/controller.mjs', 'src/ui/reducer.mjs', 'src/ui/keys.mjs']) {
    ok(!matched.includes(frozen), `${frozen} 应保持零第三方 import（冻结契约）`);
  }
  console.log(`      步骤 3：react/ink import 命中 [${matched.join(', ')}] ⊆ 白名单`);
}

// ───────── 主流程 ─────────

console.log(`GitCue 验收测试（工作区 ${ROOT_DIR}）`);
console.log(`Node ${process.version}，沙箱 ${SB}\n`);

const gitVer = spawnSync('git', ['--version'], { encoding: 'utf8' });
if (gitVer.status !== 0) {
  console.error('本机未检测到 git，验收无法进行');
  process.exit(1);
}
console.log(`本机 ${gitVer.stdout.trim()}\n`);

console.log('—— 准备夹具（.sandbox/accept：bare origin / work（main+feature+tag+stash）/ clone / empty）——');
try {
  buildFixture();
} catch (err) {
  console.error(`夹具创建失败：${err && err.message ? err.message : err}`);
  process.exit(1);
}
console.log('夹具就绪\n');

const tAll = performance.now();
await runScenario(1, scenario1);
await runScenario(2, scenario2);
await runScenario(3, scenario3);
await runScenario(4, scenario4);
await runScenario(5, scenario5);
await runScenario(6, scenario6);
await runScenario(7, scenario7);
await runScenario(8, scenario8);
await runScenario(9, scenario9);
await runScenario(10, scenario10);
await runScenario(11, scenario11);
await runScenario(12, scenario12);
// 场景 13 必须最后运行：核查集包含此前全部场景再生的夹具产物（步骤 2 的前置）
await runScenario(13, scenario13);
const totalMs = Math.round(performance.now() - tAll);

console.log('\n—— 验收汇总 ——');
let failed = 0;
let totalAsserts = 0;
for (const [id, rec] of [...results.entries()].sort((a, b) => a[0] - b[0])) {
  totalAsserts += rec.asserts;
  const mark = rec.ok ? '✔' : '✘';
  if (!rec.ok) failed += 1;
  console.log(`${mark} 场景 ${id}（${rec.asserts} 断言，${rec.ms}ms）${rec.ok ? '' : `—— ${rec.failures.length} 项失败`}`);
}
console.log(`\n共 ${results.size} 个场景 / ${totalAsserts} 条断言，失败 ${failed} 个，总耗时 ${totalMs}ms`);
if (FINDINGS.length > 0) {
  console.log('\n—— 发现（如实上报，不计入通过/失败）——');
  for (const f of FINDINGS) console.log(`  • ${f}`);
}
if (failed > 0) {
  console.log('验收未通过');
  process.exit(1);
}
console.log('验收全部通过');
process.exit(0);
