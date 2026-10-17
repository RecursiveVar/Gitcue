// 知识库数据·第二批 单元测试
// 覆盖命令：fetch init log merge mv pull push remote
//
// 校验层次：
//   1. 条目基本约定（schemaVersion/command/category/popularity/summary/examples/notes）
//   2. Pattern 结构（四类节点 + Param kind 枚举 + 文案长度/句数 + since 格式）
//   3. 冲突模拟（key ∪ aliases ∪ 隐式 --no-x 否定，两两不相交）
//   4. 信息性检查（repeatable positional 后随 positional 仅 mv 允许）
//   5. git -h 离线比对（log 因 revision 层选项不在 -h 输出而跳过，见注释）
//   6. 沙箱仓库功能验证：每个选项形式被本机 git 真实接受
//   7. 每命令最低建模要求断言
//
// 安全边界：只在 D:/Code/GitCue 内读写；仓库夹具建于 .sandbox/data-2/；
// git 调用一律隔离 GIT_CONFIG_GLOBAL/SYSTEM 并附加测试身份；GITCUE_HOME 指向沙箱。

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------- 常量与路径 ----------

const ROOT = path.resolve(import.meta.dirname, '..');            // 工作区根 D:/Code/GitCue
const DATA_DIR = path.join(ROOT, 'data', 'commands');
const SB = path.join(ROOT, '.sandbox', 'data-2');                // 本模块独占沙箱
const HOME = path.join(SB, 'home');
const REPO = path.join(SB, 'repo');                              // 功能验证用仓库

const COMMANDS = ['fetch', 'init', 'log', 'merge', 'mv', 'pull', 'push', 'remote'];

/** git 子进程统一环境：全局/系统配置指向沙箱空文件，禁止凭据交互 */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(SB, 'git-global.cfg'),
  GIT_CONFIG_SYSTEM: path.join(SB, 'git-system.cfg'),
  GIT_TERMINAL_PROMPT: '0',
  GITCUE_HOME: HOME,
};
/** 沙箱内提交身份 */
const ID = ['-c', 'user.name=gitcue-test', '-c', 'user.email=test@gitcue.local'];

/** git <cmd> -h 输出缓存 */
const helpCache = new Map();

function runGit(args, { cwd = REPO } = {}) {
  return spawnSync('git', args, { encoding: 'utf8', env: GIT_ENV, cwd, timeout: 20_000 });
}

function helpText(cmd) {
  if (!helpCache.has(cmd)) {
    const r = spawnSync('git', [cmd, '-h'], { encoding: 'utf8', env: GIT_ENV, cwd: ROOT, timeout: 20_000 });
    // 部分 git 版本（如 2.45 的 merge）把 -h usage 写到 stderr，两个流都并入再提取
    if (r.error) helpCache.set(cmd, null);
    else helpCache.set(cmd, `${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  }
  return helpCache.get(cmd);
}

// ---------- 数据读取与遍历 ----------

function loadEntry(cmd) {
  const file = path.join(DATA_DIR, `${cmd}.json`);
  const buf = fs.readFileSync(file);          // 不存在则抛错 → 测试失败（预期行为）
  return { file, buf, entry: JSON.parse(buf.toString('utf8')) };
}

/**
 * 递归收集全部 Pattern。
 * @returns {{ pattern: object, branch: string }[]} branch 为 'root' 或 literal 分支 key
 */
function collectPatterns(grammar, branch = 'root', out = []) {
  for (const p of grammar) {
    out.push({ pattern: p, branch });
    if (p.type === 'literal' && Array.isArray(p.then)) collectPatterns(p.then, `${branch}::${p.key}`, out);
    if (p.type === 'group') for (const m of p.members) out.push({ pattern: m, branch });
  }
  return out;
}

/** 收集 option pattern 的全部匹配形式（key + aliases），供冲突检测与 -h/功能比对 */
function optionForms(entry) {
  return collectPatterns(entry.grammar)
    .filter(({ pattern }) => pattern.type === 'option')
    .map(({ pattern, branch }) => ({ pattern, branch, forms: [pattern.key, ...(pattern.aliases ?? [])] }));
}

function positionalList(entry) {
  return collectPatterns(entry.grammar)
    .filter(({ pattern }) => pattern.type === 'positional')
    .map(({ pattern, branch }) => ({ pattern, branch }));
}

// ---------- 校验辅助 ----------

const OPTION_KEY_RE = /^(-[a-zA-Z0-9]|--[a-z0-9][a-z0-9-]*)$/;
const LITERAL_KEY_RE = /^[a-z][a-z0-9-]*$/;
const PARAM_KINDS = new Set(['branch', 'tag', 'remote', 'commit', 'stash', 'pathspec', 'enum', 'text']);
const SENTENCE_ENDS = [...'。！？；'];            // 按全角句末符号粗计
const cp = (s) => [...String(s)].length;         // Unicode 码点数

/** Pattern 结构校验（递归 literal.then / group.members），错误写入 errors */
function validatePattern(p, where, errors) {
  const at = `${where}(${p.type})`;
  if (!p || typeof p !== 'object') { errors.push(`${at}: 节点非对象`); return; }
  switch (p.type) {
    case 'option': {
      if (!OPTION_KEY_RE.test(p.key ?? '')) errors.push(`${at}: key 非法: ${p.key}`);
      for (const a of p.aliases ?? []) {
        if (!OPTION_KEY_RE.test(a)) errors.push(`${at}: alias 非法: ${a}`);
        if (a === p.key) errors.push(`${at}: alias 与 key 重复: ${a}`);
      }
      break;
    }
    case 'positional': break;
    case 'literal': {
      if (!LITERAL_KEY_RE.test(p.key ?? '')) errors.push(`${at}: literal key 非法: ${p.key}`);
      if (p.then !== undefined) {
        if (!Array.isArray(p.then) || p.then.length === 0) errors.push(`${at}: then 须为非空数组`);
        else for (const t of p.then) validatePattern(t, `${where}::${p.key}`, errors);
      }
      return; // literal 的 summary/popularity 在下方公共段已检查，此处提前返回避免重复
    }
    case 'group': {
      if (p.mode !== 'mutex' && p.mode !== 'repeat') errors.push(`${at}: mode 非法: ${p.mode}`);
      if (!Array.isArray(p.members) || p.members.length === 0) errors.push(`${at}: members 须为非空数组`);
      else for (const m of p.members) {
        validatePattern(m, `${where}(grp)`, errors);
        if (m?.type === 'group') errors.push(`${at}: group 不得嵌套 group`);
      }
      return; // group 无 popularity/summary/param 要求
    }
    default:
      errors.push(`${at}: 未知 type: ${p.type}`);
      return;
  }
  // option / positional 公共字段
  if (p.type === 'positional' && !p.param) errors.push(`${at}: positional 缺 param`);
  if (p.param !== undefined && p.param !== null) {
    const pm = p.param;
    if (!PARAM_KINDS.has(pm.kind)) errors.push(`${at}: param.kind 非法: ${pm.kind}`);
    if (typeof pm.name !== 'string' || pm.name === '' || /[<>]/.test(pm.name) || /\s/.test(pm.name))
      errors.push(`${at}: param.name 非法: ${JSON.stringify(pm.name)}`);
    if (pm.kind === 'enum') {
      if (!Array.isArray(pm.enum) || pm.enum.length === 0 || pm.enum.some((v) => typeof v !== 'string' || v === ''))
        errors.push(`${at}: enum 须为非空字符串数组`);
    }
  }
}

/** 公共标量字段校验（所有非 group pattern） */
function validateCommonFields(p, where, errors) {
  const at = `${where}(${p.type}:${p.key ?? p.param?.name})`;
  if (!Number.isInteger(p.popularity) || p.popularity < 1 || p.popularity > 5)
    errors.push(`${at}: popularity 须为 1–5 整数，实际 ${p.popularity}`);
  if (typeof p.summary !== 'string' || p.summary === '') errors.push(`${at}: summary 缺失`);
  else if (cp(p.summary) > 40) errors.push(`${at}: summary 超 40 码点（${cp(p.summary)}）`);
  if (p.detail !== undefined && p.detail !== null) {
    if (typeof p.detail !== 'string') errors.push(`${at}: detail 须为字符串`);
    else {
      const n = [...p.detail].filter((c) => SENTENCE_ENDS.includes(c)).length;
      if (n > 3) errors.push(`${at}: detail 超 3 句（${n}）`);
    }
  }
  if (p.example !== undefined && p.example !== null && typeof p.example !== 'string')
    errors.push(`${at}: example 须为字符串`);
  if (p.since !== undefined && p.since !== null && !/^\d+\.\d+$/.test(p.since))
    errors.push(`${at}: since 格式非法: ${p.since}`);
}

// ---------- 测试夹具 ----------

before(() => {
  // 安全自检：沙箱与 home 必须位于工作区 .sandbox 内
  const sandboxRoot = path.join(ROOT, '.sandbox');
  for (const p of [SB, HOME, REPO]) {
    assert.ok(path.resolve(p).startsWith(sandboxRoot + path.sep), `越界路径: ${p}`);
  }
  process.env.GITCUE_HOME = HOME;

  // 重建沙箱（用例级隔离：整体重建，保证可重复运行）
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(SB, 'git-global.cfg'), '');
  fs.writeFileSync(path.join(SB, 'git-system.cfg'), '');

  // 功能验证夹具：沙箱内 git init + 两个提交（无 remote，任何 fetch/push 快速失败、不联网）
  fs.mkdirSync(REPO, { recursive: true });
  fs.writeFileSync(path.join(REPO, 'README.md'), 'hello gitcue\n');
  const run = (args) => runGit(ID.concat(args), { cwd: REPO });
  assert.equal(run(['init', '-q', '-b', 'main']).status, 0, 'git init 夹具失败');
  assert.equal(run(['add', 'README.md']).status, 0, 'git add 夹具失败');
  assert.equal(run(['commit', '-q', '-m', 'init']).status, 0, 'git commit 夹具失败');
  assert.equal(run(['commit', '-q', '--allow-empty', '-m', 'second']).status, 0, 'git commit(2) 夹具失败');
  assert.equal(runGit(['rev-parse', '--is-inside-work-tree']).stdout.trim(), 'true', '夹具仓库自检失败');
});

after(() => {
  // 自建自清
  fs.rmSync(SB, { recursive: true, force: true });
});

// ---------- 1. 条目基本约定 ----------

describe('条目基本约定', () => {
  for (const cmd of COMMANDS) {
    test(`${cmd}.json 存在、UTF-8 无 BOM、LF、可解析`, () => {
      const { file, buf, entry } = loadEntry(cmd);
      assert.ok(buf.length > 0);
      assert.ok(!buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), '文件不得含 BOM');
      assert.ok(!buf.includes(0x0d), '换行须为 LF（不得含 CR）');
      assert.equal(entry.command, cmd, 'command 字段必须与文件名一致');
      assert.equal(entry.schemaVersion, '1.0', 'schemaVersion 须为 1.0');
      assert.equal(entry.category, 'porcelain');
      assert.ok(Number.isInteger(entry.popularity) && entry.popularity >= 1 && entry.popularity <= 5);
      assert.ok(typeof entry.summary === 'string' && entry.summary.length > 0);
      assert.ok(cp(entry.summary) <= 40, `summary 超 40 码点: ${entry.summary}`);
      assert.ok(Array.isArray(entry.grammar) && entry.grammar.length > 0, 'grammar 不得为空');
      assert.ok(Array.isArray(entry.examples) && entry.examples.length >= 1, '每条目至少 1 个示例');
      for (const ex of entry.examples) {
        assert.equal(typeof ex.cmd, 'string');
        assert.ok(ex.cmd.startsWith('git '), '示例须为 git 命令');
        assert.equal(typeof ex.note, 'string');
      }
      for (const n of entry.notes ?? []) {
        assert.equal(typeof n, 'string');
        assert.ok(cp(n) <= 40, `notes 条目超 40 码点: ${n}`);
      }
      assert.ok(file.length > 0);
    });
  }
});

// ---------- 2. Pattern 结构校验 ----------

describe('Pattern 结构', () => {
  for (const cmd of COMMANDS) {
    test(`${cmd}: 全部节点结构合法`, () => {
      const { entry } = loadEntry(cmd);
      const errors = [];
      for (const { pattern } of collectPatterns(entry.grammar)) {
        validatePattern(pattern, cmd, errors);
        if (pattern.type !== 'group') validateCommonFields(pattern, cmd, errors);
      }
      assert.deepEqual(errors, [], `结构错误:\n${errors.join('\n')}`);
    });
  }
});

// ---------- 3. 冲突模拟 ----------

describe('互斥/隐式否定冲突检测', () => {
  for (const cmd of COMMANDS) {
    test(`${cmd}: key∪aliases∪隐式否定 两两不相交`, () => {
      const { entry } = loadEntry(cmd);
      const forms = optionForms(entry);
      // 显式认领全集（含跨分支，保守口径：比按分支作用域更严格）
      const claimed = new Set(forms.flatMap((f) => f.forms));
      // 模拟隐式否定：长选项 key 生成 --no-x，仅当未被显式认领
      const expansion = forms.map((f) => {
        const set = new Set(f.forms);
        if (f.pattern.key.startsWith('--')) {
          const neg = `--no-${f.pattern.key.slice(2)}`;
          if (!claimed.has(neg)) set.add(neg);
        }
        return { what: `${cmd} ${f.branch}`, set };
      });
      const seen = new Map(); // form -> 归属
      const conflicts = [];
      for (const { what, set } of expansion) {
        for (const form of set) {
          if (seen.has(form)) conflicts.push(`${form} 同时属于 ${seen.get(form)} 与 ${what}`);
          else seen.set(form, what);
        }
      }
      assert.deepEqual(conflicts, [], `互斥冲突:\n${conflicts.join('\n')}`);
    });
  }
  test('显式认领 --no-x 的正反形式须同互斥组（--tags/--no-tags、--rebase/--no-rebase）', () => {
    const pairs = [
      ['remote', 'add', ['--tags', '--no-tags']],
      ['pull', 'root', ['--rebase', '--no-rebase']],
    ];
    for (const [cmd, branch, [a, b]] of pairs) {
      const { entry } = loadEntry(cmd);
      const hits = optionForms(entry).filter(
        (f) => f.branch === (branch === 'root' ? 'root' : `root::${branch}`) && f.forms.some((x) => x === a || x === b)
      );
      assert.equal(hits.length, 2, `${cmd} ${branch}: ${a}/${b} 应为两个独立 pattern`);
      assert.equal(hits[0].pattern.mutex, hits[1].pattern.mutex, `${cmd}: ${a}/${b} 须同 mutex 组`);
      assert.ok(hits[0].pattern.mutex, `${cmd}: 互斥组 ID 不得为空`);
    }
  });
});

// ---------- 4. repeatable positional 信息性检查 ----------

describe('repeatable positional 规则（保留必填余数）', () => {
  for (const cmd of COMMANDS) {
    test(`${cmd}: repeatable positional 后随 positional 仅 mv 允许`, () => {
      const { entry } = loadEntry(cmd);
      const off = [];
      // 逐分支（root 与每个 literal then）内按声明序检查
      const branches = new Map();
      for (const { pattern, branch } of collectPatterns(entry.grammar)) {
        if (pattern.type !== 'positional') continue;
        if (!branches.has(branch)) branches.set(branch, []);
        branches.get(branch).push(pattern);
      }
      for (const [branch, list] of branches) {
        for (let i = 0; i < list.length - 1; i++) {
          if (list[i].repeatable) off.push(`${branch}#${i}(${list[i].param.name})`);
        }
      }
      if (cmd === 'mv') {
        // mv 是有意建模：sources... + destination（保留必填余数）
        assert.deepEqual(off, ['root#0(source)'], 'mv 应恰为 <source>... + <destination> 结构');
        const list = branches.get('root');
        assert.equal(list[0].optional, false);
        assert.equal(list[1].optional, false);
      } else {
        assert.deepEqual(off, [], `非预期 repeatable-后随-positional: ${off.join(', ')}`);
      }
    });
  }
});

// ---------- 5. git -h 离线比对 ----------

/** 从 -h 输出提取选项 token 集（先归一化 --[no-]x → "--x --no-x"，再提取长短选项） */
function extractHelpOptions(text) {
  const set = new Set();
  const normalized = text.replace(/--\[no-\]([a-z0-9][a-z0-9-]*)/g, (_m, x) => `--${x} --no-${x}`);
  for (const m of normalized.matchAll(/--[a-z0-9][a-z0-9-]*/g)) set.add(m[0]);
  for (const m of normalized.matchAll(/(?<![-\w])-[a-zA-Z0-9](?![\w=])/g)) set.add(m[0]);
  return set;
}

describe('git -h 离线比对', () => {
  // git log 的 -h 仅输出 parse_options 层注册的选项（本机实测 16 行），
  // --oneline/-n/-p 等属 revision-walker 层、不在 -h 输出中，
  // 故 log 跳过本组比对，由「沙箱仓库功能验证」组全量兜底（判据更严格：git 真实接受）。
  const SKIP_HELP_COMPARE = new Set(['log']);
  // git remote -h 的 usage 行对 add 子命令仅列短形式（[-t <branch>] [-f]），
  // --track/--fetch 长形式见官方 man；已由功能验证组确认本机 git 接受。
  const HELP_EXTRA_FORMS = { remote: new Set(['--fetch', '--track']) };

  for (const cmd of COMMANDS) {
    if (SKIP_HELP_COMPARE.has(cmd)) continue;
    test(`${cmd}: 数据中全部选项形式均出现在 git ${cmd} -h 输出`, () => {
      const text = helpText(cmd);
      assert.ok(text !== null, 'git 不可用，应跳过本组');
      const truth = extractHelpOptions(text);
      const extras = HELP_EXTRA_FORMS[cmd] ?? new Set();
      const missing = [];
      for (const { forms } of optionForms(loadEntry(cmd).entry)) {
        for (const f of forms) if (!truth.has(f) && !extras.has(f)) missing.push(f);
      }
      assert.deepEqual(missing, [], `未见于 git ${cmd} -h 的选项:\n${missing.join('\n')}`);
    });
  }
});

// ---------- 6. 沙箱仓库功能验证（ground truth 兜底） ----------

/** 为选项形式构造功能探测参数值 */
function probeValue(param) {
  if (!param) return null;
  if (param.kind === 'enum') return param.enum[0];
  const name = param.name.toLowerCase();
  if (/num|^n$|depth|jobs/.test(name)) return '1';
  if (name.includes('date')) return '2020-01-01';
  if (name === 'format') return 'oneline';
  if (name.includes('option=value')) return 'theirs';
  if (name === 'branch') return 'main';
  return 'x';
}

/**
 * 构造「git 接受该选项」的探测命令行。
 * 判据：stderr 不含 unknown option / unknown switch（多数命令）
 *      或 unrecognized argument（git log 的 revision 层报错文本）。
 * 夹具仓库无 remote：fetch/pull/push 立即快速失败，绝不联网。
 */
function buildProbe(cmd, form, param, seq) {
  const v = probeValue(param);
  const withValue = v === null ? [form] : form.startsWith('--') ? [`${form}=${v}`] : [form, v];
  switch (cmd) {
    case 'fetch':
    case 'pull':
    case 'push':
      return [cmd, ...withValue];                       // 无 remote → fatal，选项解析先行
    case 'merge':
      return ['merge', ...withValue];                   // 干净仓库 → Already up to date / fatal
    case 'log':
      return ['log', ...withValue, '-1'];               // 限定 1 条，避免大输出
    case 'mv':
      return ['mv', '-n', ...withValue, 'README.md', `t${seq}.md`]; // 始终 dry-run，不改现场
    case 'init':                                        // 目标目录落在沙箱内，cwd 用 SB（非仓库）
      return ['init', ...withValue, `tmp-init-${seq}`];
    default:
      throw new Error(`未预期的命令: ${cmd}`);
  }
}

/** remote 的分支选项按子命令语境构造探测命令 */
function buildRemoteProbe(branch, form, param, seq) {
  const v = probeValue(param);
  const withValue = v === null ? [form] : form.startsWith('--') ? [`${form}=${v}`] : [form, v];
  const name = `probe-${seq}`;
  switch (branch) {
    case 'root': return ['remote', ...withValue];        // -v/--verbose 只读列出远程
    case 'add': return ['remote', 'add', ...withValue, name, `../null-${seq}.git`];
    case 'set-url': return ['remote', 'set-url', ...withValue, name, `../u-${seq}.git`];
    case 'get-url': return ['remote', 'get-url', ...withValue, name];
    case 'prune': return ['remote', 'prune', ...withValue, name];
    default: throw new Error(`remote 分支 ${branch} 无选项需探测`);
  }
}

const UNKNOWN_RE = /unknown option|unknown switch|unrecognized argument/;

describe('沙箱仓库功能验证：每个选项形式被本机 git 接受', () => {
  test('判据自检：伪造选项必须被检出（防假绿）', () => {
    const bad = runGit(['log', '--zz-bogus-option']).stderr;
    assert.match(bad, UNKNOWN_RE, 'git 报错文本变化时判据失效，需更新 UNKNOWN_RE');
    const badShort = runGit(['merge', '-Z']).stderr;
    assert.match(badShort, UNKNOWN_RE);
  });

  for (const cmd of COMMANDS) {
    test(`${cmd}: 全部选项形式通过真实 git 接受性探测`, () => {
      const { entry } = loadEntry(cmd);
      const failures = [];
      let seq = 0;
      for (const { branch, forms, pattern } of optionForms(entry)) {
        for (const form of forms) {
          seq += 1;
          const args = cmd === 'remote'
            ? buildRemoteProbe(branch.split('::').pop(), form, pattern.param, seq)
            : buildProbe(cmd, form, pattern.param, seq);
          const r = runGit(args, { cwd: cmd === 'init' ? SB : REPO });
          const errText = (r.stderr || '') + (r.stdout || '');
          if (UNKNOWN_RE.test(errText)) failures.push(`git ${args.join(' ')} → ${errText.split('\n')[0]}`);
          assert.ok(r.stderr !== undefined, 'spawnSync 异常');
        }
      }
      assert.deepEqual(failures, [], `下列选项未被本机 git 接受:\n${failures.join('\n')}`);
    });
  }
});

// ---------- 7. 每命令最低建模要求 ----------

describe('最低建模要求', () => {
  const formsOf = (entry) => new Set(optionForms(entry).flatMap((f) => f.forms));
  const findOpt = (entry, form) => optionForms(entry).find((f) => f.forms.includes(form));

  test('fetch: remote(可选)+branch(repeat)；--all --prune --depth --tags --dry-run', () => {
    const { entry } = loadEntry('fetch');
    const pos = positionalList(entry).map((p) => p.pattern);
    assert.equal(pos[0].param.kind, 'remote');
    assert.equal(pos[0].optional, true);
    assert.equal(pos[1].param.kind, 'branch');
    assert.equal(pos[1].repeatable, true);
    for (const f of ['--all', '--prune', '--depth', '--tags', '--dry-run']) {
      assert.ok(findOpt(entry, f), `缺少 ${f}`);
    }
  });

  test('init: text 目录(可选)；-b/--initial-branch param branch since 2.28；--bare', () => {
    const { entry } = loadEntry('init');
    const pos = positionalList(entry)[0].pattern;
    assert.equal(pos.param.kind, 'text');
    assert.equal(pos.optional, true);
    const b = findOpt(entry, '-b');
    assert.ok(b, '缺少 -b');
    assert.equal(b.pattern.param.kind, 'branch');
    assert.deepEqual(b.pattern.aliases, ['--initial-branch']);
    assert.equal(b.pattern.since, '2.28');
    assert.ok(findOpt(entry, '--bare'), '缺少 --bare');
  });

  test('log: commit(可选)+pathspec(repeat)；八个必含选项', () => {
    const { entry } = loadEntry('log');
    const pos = positionalList(entry).map((p) => p.pattern);
    assert.equal(pos[0].param.kind, 'commit');
    assert.equal(pos[0].optional, true);
    assert.equal(pos[1].param.kind, 'pathspec');
    assert.equal(pos[1].repeatable, true);
    for (const f of ['--oneline', '-n', '--graph', '--all', '--author', '--since', '--until', '-p']) {
      assert.ok(findOpt(entry, f), `缺少 ${f}`);
    }
  });

  test('merge: commit(可选)；--no-ff --ff-only --squash -m；--abort/--continue 互斥组', () => {
    const { entry } = loadEntry('merge');
    const pos = positionalList(entry)[0].pattern;
    assert.equal(pos.param.kind, 'commit');
    assert.equal(pos.optional, true);
    for (const f of ['--no-ff', '--ff-only', '--squash', '-m', '-s']) {
      assert.ok(findOpt(entry, f), `缺少 ${f}`);
    }
    assert.deepEqual(findOpt(entry, '-s').pattern.param.enum, ['ort', 'recursive', 'octopus', 'ours', 'subtree']);
    const grp = entry.grammar.find((p) => p.type === 'group' && p.mode === 'mutex');
    assert.ok(grp, '缺少互斥组');
    const keys = grp.members.map((m) => m.key);
    assert.ok(keys.includes('--continue') && keys.includes('--abort'), `互斥组须含 --continue/--abort: ${keys}`);
  });

  test('mv: <source>...(pathspec,必填)+<destination>(必填)；-f -k -n', () => {
    const { entry } = loadEntry('mv');
    const pos = positionalList(entry).map((p) => p.pattern);
    assert.equal(pos.length, 2);
    assert.equal(pos[0].param.kind, 'pathspec');
    assert.equal(pos[0].repeatable, true);
    assert.equal(pos[0].optional, false);
    assert.equal(pos[1].param.kind, 'pathspec');
    assert.equal(pos[1].optional, false);
    for (const f of ['-f', '-k', '-n']) assert.ok(findOpt(entry, f), `缺少 ${f}`);
  });

  test('pull: remote(可选)+branch(可选)；--rebase/--no-rebase/--ff-only/--autostash/-s(enum)', () => {
    const { entry } = loadEntry('pull');
    const pos = positionalList(entry).map((p) => p.pattern);
    assert.equal(pos[0].param.kind, 'remote');
    assert.equal(pos[0].optional, true);
    assert.equal(pos[1].param.kind, 'branch');
    assert.equal(pos[1].optional, true);
    for (const f of ['--rebase', '--no-rebase', '--ff-only', '--autostash', '-s']) {
      assert.ok(findOpt(entry, f), `缺少 ${f}`);
    }
    assert.ok(findOpt(entry, '-s').pattern.param.enum.length > 0, '-s 须为 enum');
  });

  test('push: remote(可选)+refspec(branch,repeat)；-f/--force-with-lease/-u/--all/--tags/-d；force 互斥组', () => {
    const { entry } = loadEntry('push');
    const pos = positionalList(entry).map((p) => p.pattern);
    assert.equal(pos[0].param.kind, 'remote');
    assert.equal(pos[0].optional, true);
    assert.equal(pos[1].param.name, 'refspec');
    assert.equal(pos[1].param.kind, 'branch');
    assert.equal(pos[1].repeatable, true);
    assert.equal(pos[1].optional, true);
    for (const f of ['-f', '--force', '--force-with-lease', '-u', '--set-upstream', '--all', '--tags', '-d', '--delete']) {
      assert.ok(findOpt(entry, f), `缺少 ${f}`);
    }
    const f1 = findOpt(entry, '-f');
    const f2 = findOpt(entry, '--force-with-lease');
    assert.equal(f1.pattern.mutex, f2.pattern.mutex, '-f 与 --force-with-lease 须同互斥组');
    assert.ok(f1.pattern.mutex, '互斥组 ID 不得为空');
  });

  test('remote: 8 个 literal 分支 + 根 -v；add 分支含 <name> <url>', () => {
    const { entry } = loadEntry('remote');
    const literals = entry.grammar.filter((p) => p.type === 'literal').map((p) => p.key);
    assert.deepEqual(
      [...literals].sort(),
      ['add', 'get-url', 'prune', 'remove', 'rename', 'rm', 'set-url', 'show'].sort(),
      'literal 分支集合与建模要求不符'
    );
    assert.ok(findOpt(entry, '-v'), '根缺少 -v/--verbose');
    const addThen = entry.grammar.find((p) => p.key === 'add').then;
    const addPos = addThen.filter((p) => p.type === 'positional');
    assert.deepEqual(addPos.map((p) => p.param.name), ['name', 'url']);
    assert.equal(addPos.every((p) => p.optional === false), true);
    // literal 分支一旦进入即不回退父序列：根序列不应再有 positional
    assert.equal(entry.grammar.some((p) => p.type === 'positional'), false);
  });

  test('选项规模：通用 ≥8；受官方选项集限制的 mv/init 如实下修并全量收录', () => {
    const { entry: mv } = loadEntry('mv');
    const { entry: init } = loadEntry('init');
    // git mv -h 全部选项：-v -n -f -k --sparse（5 个，全收录）
    assert.equal(optionForms(mv).length, 5);
    // git init -h 全部选项：--bare -q -b --separate-git-dir --template --shared --object-format --ref-format（8 个，全收录）
    assert.equal(optionForms(init).length, 8);
    for (const cmd of ['fetch', 'log', 'merge', 'pull', 'push', 'remote']) {
      const n = optionForms(loadEntry(cmd).entry).length;
      assert.ok(n >= 8, `${cmd} 选项 pattern 数 ${n} < 8`);
    }
  });
});

// ---------- 8. 文案质量 ----------

describe('文案质量', () => {
  const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
  for (const cmd of COMMANDS) {
    test(`${cmd}: 全部 pattern summary 为非空中文`, () => {
      const { entry } = loadEntry(cmd);
      const bad = [];
      for (const { pattern } of collectPatterns(entry.grammar)) {
        if (pattern.type === 'group') continue;
        if (!CJK.test(pattern.summary ?? '')) bad.push(`${pattern.key ?? pattern.param?.name}: ${pattern.summary}`);
      }
      assert.deepEqual(bad, [], '以下 summary 不含中文:\n' + bad.join('\n'));
      assert.ok(CJK.test(entry.summary), '条目 summary 须为中文');
    });
  }
});

// ---------- 9. 安全天检 ----------

describe('安全边界自检', () => {
  test('GITCUE_HOME 位于工作区沙箱内', () => {
    assert.equal(process.env.GITCUE_HOME, HOME);
    assert.ok(path.resolve(process.env.GITCUE_HOME).startsWith(path.join(ROOT, '.sandbox') + path.sep));
  });
  test('本测试全部读写路径均位于工作区内', () => {
    for (const p of [DATA_DIR, SB, HOME, REPO]) {
      assert.ok(path.resolve(p).startsWith(ROOT + path.sep), `越界: ${p}`);
    }
  });
});
