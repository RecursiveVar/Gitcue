/**
 * 知识库数据·第一批 结构校验测试
 *
 * 覆盖命令：add branch checkout cherry-pick clone commit config diff
 *
 * 两组用例：
 *   1) 结构校验（纯数据，无外部依赖）：字段齐全、JSON 合法、文案长度与中文、
 *      Pattern 四类节点规则、param/kind/enum 规则、隐式否定展开集合两两不相交、
 *      positional 占位名全条目唯一（patternId 唯一性保障）、每命令选项数 ≥ 8。
 *   2) 官方一致性补充校验（只读、沙箱隔离）：
 *      - add/branch/checkout/cherry-pick/clone/commit：声明的选项形式须出现在
 *        本机 `git <cmd> -h` 输出中（双上下文并集 + `--[no-]x` 归一化 + `--no-x` 基名回退）；
 *      - diff：`git diff -h` 的仓库内外输出均不完整（仓库外仅 --no-index 形态、
 *        仓库内不含 --staged），故改用解析式校验（选项能被真实 git 接受）；
 *      - config：git 2.46+ 的 `git config -h` 改为新子命令式用法，不再列出旧式
 *        --global/--list/--get 等标志，同样改用解析式校验，并验证 --type 枚举与
 *        文件作用域互斥语义与建模一致。
 *
 * 安全边界：本测试不涉及用户级数据（无需 GITCUE_HOME）；
 * 所有 git 子进程均以 GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM 指向 .sandbox/data-1/
 * 内的空文件、GIT_TERMINAL_PROMPT=0 运行；所需仓库在 .sandbox/data-1/repo 用
 * git init 创建，绝不触碰工作区之外与真实全局配置。
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.join(import.meta.dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'commands');
const SB = path.join(ROOT, '.sandbox', 'data-1');
const REPO = path.join(SB, 'repo');
const COMMANDS = ['add', 'branch', 'checkout', 'cherry-pick', 'clone', 'commit', 'config', 'diff'];

// ---------- 文案度量 ----------
const cp = (s) => [...s].length; // Unicode 码点数
const sentenceCount = (s) => (s.match(/[。！？；]/g) ?? []).length; // 粗计句数
const hasCJK = (s) => /[\u4e00-\u9fff]/.test(s);

// ---------- Schema 常量 ----------
const OPTION_KEY_RE = /^(-[a-zA-Z0-9]|--[a-z0-9][a-z0-9-]*)$/;
const LITERAL_KEY_RE = /^[a-z][a-z0-9-]*$/;
const KINDS = new Set(['branch', 'tag', 'remote', 'commit', 'stash', 'pathspec', 'enum', 'text']);
const SINCE_RE = /^\d+\.\d+$/;

/** 读取并解析一个命令条目，同时校验文件编码约定（UTF-8 无 BOM、LF） */
function loadEntry(cmd) {
  const file = path.join(DATA_DIR, `${cmd}.json`);
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.startsWith('\uFEFF'), `${file} 不得带 BOM`);
  assert.ok(!raw.includes('\r'), `${file} 必须使用 LF 换行`);
  return { file, entry: JSON.parse(raw) };
}

/** 深度遍历 grammar 全部节点（含 group 成员与 literal.then），附带 JSON 路径 */
function walkPatterns(patterns, base, out = []) {
  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i];
    const at = `${base}[${i}]`;
    out.push({ p, at });
    if (p && p.type === 'group' && Array.isArray(p.members)) {
      p.members.forEach((m, j) => {
        out.push({ p: m, at: `${at}.members[${j}]` });
        if (m && m.type === 'literal' && Array.isArray(m.then)) walkPatterns(m.then, `${at}.members[${j}].then`, out);
      });
    }
    if (p && p.type === 'literal' && Array.isArray(p.then)) walkPatterns(p.then, `${at}.then`, out);
  }
  return out;
}

/** 校验 Param */
function checkParam(param, at, E) {
  if (typeof param !== 'object' || param === null) { E(at, 'param 须为对象'); return; }
  if (typeof param.name !== 'string' || param.name.length === 0 || /[<>]/.test(param.name)) {
    E(at, 'param.name 须为不含尖括号的非空字符串');
  }
  if (!KINDS.has(param.kind)) { E(at, `param.kind 非法：${param.kind}`); return; }
  if (param.kind === 'enum') {
    if (!Array.isArray(param.enum) || param.enum.length === 0 ||
        !param.enum.every((v) => typeof v === 'string' && v.length > 0)) {
      E(at, 'kind=enum 时 enum 须为非空字符串数组');
    }
  } else if (param.enum !== undefined) {
    E(at, '仅 kind=enum 允许携带 enum 字段');
  }
}

/** 校验单个 Pattern 公共字段（popularity/summary/detail/example/since/mutex） */
function checkCommonFields(p, at, E) {
  if (!Number.isInteger(p.popularity) || p.popularity < 1 || p.popularity > 5) {
    E(at, 'popularity 须为 1–5 整数');
  }
  if (typeof p.summary !== 'string' || cp(p.summary) > 40 || !hasCJK(p.summary)) {
    E(at, 'summary 须为 ≤40 码点且含中文');
  }
  if (p.detail !== undefined) {
    if (typeof p.detail !== 'string' || sentenceCount(p.detail) > 3 || !hasCJK(p.detail)) {
      E(at, 'detail 须为中文且 ≤3 句');
    }
  }
  if (p.example !== undefined) {
    if (typeof p.example !== 'string' || !p.example.startsWith(`git `)) {
      E(at, 'example 须为以 "git " 开头的命令串');
    }
  }
  if (p.since !== undefined && p.since !== null && !SINCE_RE.test(p.since)) {
    E(at, `since 须匹配 ^\\d+\\.\\d+$：${p.since}`);
  }
  if (p.mutex !== undefined && p.mutex !== null && typeof p.mutex !== 'string') {
    E(at, 'mutex 须为字符串');
  }
}

/**
 * 条目级结构校验：收集全部错误后返回，便于一次性汇总。
 * 额外返回 optionPatterns/positionalNames 供跨 pattern 检查复用。
 */
function validateEntry(cmd) {
  const { file, entry } = loadEntry(cmd);
  const errs = [];
  const E = (at, msg) => errs.push(`${path.basename(file)} ${at}: ${msg}`);

  // ---- 顶层字段 ----
  if (entry.schemaVersion !== '1.0') E('顶层', 'schemaVersion 必须为 "1.0"');
  if (entry.command !== cmd) E('顶层', `command 须与文件名一致（期望 ${cmd}）`);
  if (!['porcelain', 'plumbing', 'custom'].includes(entry.category)) E('顶层', 'category 非法');
  if (!Number.isInteger(entry.popularity) || entry.popularity < 1 || entry.popularity > 5) {
    E('顶层', 'popularity 须为 1–5 整数');
  }
  if (typeof entry.summary !== 'string' || cp(entry.summary) > 40 || !hasCJK(entry.summary)) {
    E('顶层', 'summary 须为 ≤40 码点且含中文');
  }
  if (!Array.isArray(entry.grammar) || entry.grammar.length === 0) {
    return { errs, optionPatterns: [], positionalNames: [] }; // 后续无法继续
  }

  // ---- 逐 Pattern 校验 ----
  const nodes = walkPatterns(entry.grammar, 'grammar');
  for (const { p, at } of nodes) {
    if (!p || typeof p !== 'object' || typeof p.type !== 'string') { E(at, 'pattern 须为带 type 的对象'); continue; }
    if (p.optional !== undefined && typeof p.optional !== 'boolean') E(at, 'optional 须为布尔');
    if (p.repeatable !== undefined && typeof p.repeatable !== 'boolean') E(at, 'repeatable 须为布尔');
    switch (p.type) {
      case 'option': {
        if (typeof p.key !== 'string' || !OPTION_KEY_RE.test(p.key)) E(at, `option.key 格式非法：${p.key}`);
        if (p.aliases !== undefined) {
          if (!Array.isArray(p.aliases) || p.aliases.some((a) => typeof a !== 'string' || !OPTION_KEY_RE.test(a))) {
            E(at, 'aliases 须为合法选项形式数组');
          } else if (p.aliases.includes(p.key)) {
            E(at, 'aliases 不得包含 key 本身');
          }
        }
        if (p.param !== undefined && p.param !== null) checkParam(p.param, `${at}.param`, E);
        checkCommonFields(p, at, E);
        break;
      }
      case 'positional': {
        checkParam(p.param, `${at}.param`, E);
        checkCommonFields(p, at, E);
        break;
      }
      case 'literal': {
        if (typeof p.key !== 'string' || !LITERAL_KEY_RE.test(p.key)) E(at, `literal.key 格式非法：${p.key}`);
        if (p.then !== undefined && (!Array.isArray(p.then) || p.then.length === 0)) {
          E(at, 'literal.then 须为非空数组');
        }
        checkCommonFields(p, at, E);
        break;
      }
      case 'group': {
        if (p.mode !== 'mutex' && p.mode !== 'repeat') E(at, `group.mode 非法：${p.mode}`);
        if (!Array.isArray(p.members) || p.members.length === 0) {
          E(at, 'group.members 须为非空数组');
        } else if (p.members.some((m) => m && m.type === 'group')) {
          E(at, 'group 成员不得再嵌 group');
        }
        break;
      }
      default:
        E(at, `未知 pattern.type：${p.type}`);
    }
  }

  // ---- 跨 pattern 检查 ----
  const optionPatterns = nodes.filter((n) => n.p && n.p.type === 'option');
  if (optionPatterns.length < 8) {
    E('grammar', `常用选项应 ≥8 个，实际 ${optionPatterns.length}`);
  }

  // positional 占位名全条目唯一（patternId = <command>:pos:<name>，重名会撞 id）
  const positionalNames = nodes.filter((n) => n.p && n.p.type === 'positional')
    .map((n) => (n.p.param && n.p.param.name) || '');
  const dup = positionalNames.filter((n, i) => n && positionalNames.indexOf(n) !== i);
  if (dup.length > 0) E('grammar', `positional 占位名重复（patternId 会冲突）：${[...new Set(dup)].join(', ')}`);

  // 隐式否定镜像：key 为长选项 --x 且 --no-x 未被显式认领时生成隐式否定；
  // 校验（key ∪ aliases ∪ 隐式否定）展开集合两两不相交。
  const claimed = new Set();
  for (const { p } of optionPatterns) {
    claimed.add(p.key);
    for (const a of p.aliases ?? []) claimed.add(a);
  }
  const seen = new Map(); // 形式 -> 出处
  for (const { p, at } of optionPatterns) {
    const forms = [p.key, ...(p.aliases ?? [])];
    if (typeof p.key === 'string' && p.key.startsWith('--') && !p.key.startsWith('--no-')) {
      const neg = `--no-${p.key.slice(2)}`;
      if (!claimed.has(neg)) forms.push(neg);
    }
    for (const f of forms) {
      if (seen.has(f)) E(at, `选项形式 "${f}" 与 ${seen.get(f)} 冲突（展开集合须两两不相交）`);
      else seen.set(f, at);
    }
  }

  // ---- 条目级 examples / notes（1–3 个带中文注释） ----
  if (!Array.isArray(entry.examples) || entry.examples.length < 1 || entry.examples.length > 3) {
    E('examples', '条目示例须为 1–3 个');
  } else {
    entry.examples.forEach((ex, i) => {
      const at = `examples[${i}]`;
      if (!ex || typeof ex.cmd !== 'string' || !ex.cmd.startsWith(`git ${cmd}`)) {
        E(at, `cmd 须以 "git ${cmd}" 开头`);
      }
      if (typeof ex.note !== 'string' || ex.note.length === 0 || !hasCJK(ex.note)) {
        E(at, 'note 须为非空中文说明');
      }
    });
  }
  if (entry.notes !== undefined) {
    if (!Array.isArray(entry.notes)) E('notes', 'notes 须为字符串数组');
    else entry.notes.forEach((n, i) => {
      if (typeof n !== 'string' || cp(n) > 40 || !hasCJK(n)) E(`notes[${i}]`, '每条 note 须为 ≤40 码点中文');
    });
  }
  return { errs, optionPatterns, positionalNames };
}

// ================================================================
// 1) 结构校验
// ================================================================
describe('知识库数据·第一批：结构校验', () => {
  it('8 个命令条目文件齐全', () => {
    const files = new Set(readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')));
    for (const cmd of COMMANDS) assert.ok(files.has(`${cmd}.json`), `缺少 ${cmd}.json`);
  });

  for (const cmd of COMMANDS) {
    it(`${cmd}.json 字段齐全、文案合规、pattern 无冲突`, () => {
      const { errs } = validateEntry(cmd);
      assert.deepEqual(errs, [], `结构校验发现 ${errs.length} 处问题：\n  - ${errs.join('\n  - ')}`);
    });
  }
});

// ================================================================
// 2) 官方一致性补充校验（离线、只读、沙箱隔离）
// ================================================================
const gitOk = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

/** git 子进程隔离环境：全局/系统配置指向沙箱空文件，禁凭据提示 */
const gitEnv = () => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(SB, 'git-global.cfg'),
  GIT_CONFIG_SYSTEM: path.join(SB, 'git-system.cfg'),
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
});

const runGit = (args, cwd = REPO) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(), windowsHide: true });

/** 取 `git <cmd> -h` 输出：仓库外与沙箱仓库内两种上下文并集，并归一化 --[no-]x → --x */
function helpText(cmd) {
  const parts = [ROOT, REPO].map((cwd) => {
    const r = runGit([cmd, '-h'], cwd);
    return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  });
  return parts.join('\n').replace(/\[no-\]/g, '');
}

/** token 边界匹配：避免 "-p" 命中 "--patch" 之类的子串误判 */
function tokenPresent(text, tok) {
  const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${esc}(?![\\w-])`).test(text);
}

const declaredOptionForms = (cmd) => {
  const { entry } = loadEntry(cmd);
  return walkPatterns(entry.grammar, 'grammar')
    .filter((n) => n.p && n.p.type === 'option')
    .flatMap((n) => [n.p.key, ...(n.p.aliases ?? [])]);
};

describe('知识库数据·第一批：与本机 git（2.55）比对', { skip: !gitOk && '本机无 git，跳过' }, () => {
  before(() => {
    // 安全自检：沙箱目录必须位于工作区内
    assert.ok(path.resolve(SB).startsWith(path.resolve(ROOT) + path.sep), '沙箱目录越界，拒绝运行');
    rmSync(SB, { recursive: true, force: true });
    mkdirSync(SB, { recursive: true });
    writeFileSync(path.join(SB, 'git-global.cfg'), '');
    writeFileSync(path.join(SB, 'git-system.cfg'), '');
    const r = runGit(['-c', 'init.defaultBranch=main', 'init', '-q', 'repo'], SB);
    assert.equal(r.status, 0, `沙箱仓库初始化失败：${r.stderr}`);
  });

  // ---- 帮助文本比对（这 6 个命令的 -h 与仓库上下文无关） ----
  for (const cmd of ['add', 'branch', 'checkout', 'cherry-pick', 'clone', 'commit']) {
    it(`声明的选项形式均出现在 git ${cmd} -h`, () => {
      const text = helpText(cmd);
      const missing = declaredOptionForms(cmd).filter((form) => {
        let ok = tokenPresent(text, form);
        // parse-options 将可否定选项合并显示为 --[no-]x；--no-x 形式回退用基名匹配
        if (!ok && form.startsWith('--no-')) ok = tokenPresent(text, `--${form.slice(5)}`);
        return !ok;
      });
      assert.deepEqual(missing, [], `以下形式未见于 git ${cmd} -h：${missing.join(', ')}`);
    });
  }

  // ---- diff：解析式校验（-h 两种上下文都不完整，见文件头说明） ----
  it('diff：声明的选项形式均能被真实 git 解析', () => {
    // 注意：git 2.55 的 diff 走旧式选项解析，-U/--unified 只接受附着形式
    //（-U3、--unified=3），分离形式会被当作修订号；--diff-filter 两种形式均可。
    const withArg = new Map([
      ['-U', ['-U3']],
      ['--unified', ['--unified=3']],
      ['--diff-filter', ['--diff-filter', 'M']],
    ]);
    const bad = [];
    for (const form of declaredOptionForms('diff')) {
      const args = ['-C', REPO, 'diff', ...(withArg.get(form) ?? [form])];
      const r = runGit(args);
      const errText = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      if (r.status !== 0 || /invalid option|unknown option|unknown switch/.test(errText)) {
        bad.push(`${form} (exit=${r.status})`);
      }
    }
    assert.deepEqual(bad, [], `以下形式不能被 git diff 解析：${bad.join(', ')}`);
  });

  // ---- config：解析式校验（git 2.46+ 的 -h 已不列旧式标志） ----
  it('config：声明的选项形式均能被真实 git 解析', () => {
    // 每个声明形式对应一条无副作用（或仅写沙箱仓库）的调用
    const invocations = new Map([
      ['--global', ['--global', '--list']],
      ['--local', ['--local', '--list']],
      ['--system', ['--system', '--list']],
      ['--list', ['--list']],
      ['-l', ['-l']],
      ['--get', ['--get', 'gitcue.probe']],
      ['--unset', ['--unset', 'gitcue.probe']],
      ['--add', ['--add', 'gitcue.probe', 'v']],
      ['-e', ['-e']],
      ['--edit', ['--edit']],
      ['--type', ['--type', 'bool', '--get', 'gitcue.probe']],
      ['--show-origin', ['--show-origin', '--list']],
      ['--show-scope', ['--show-scope', '--list']],
      ['--get-regexp', ['--get-regexp', 'gitcue\\.probe']],
      ['--default', ['--default', 'v', '--get', 'gitcue.probe']],
    ]);
    const bad = [];
    for (const form of declaredOptionForms('config')) {
      const args = invocations.get(form);
      if (!args) { bad.push(`${form} (测试未提供调用形态)`); continue; }
      const r = runGit(['config', ...args]);
      if (/unknown option/.test(`${r.stdout ?? ''}${r.stderr ?? ''}`)) bad.push(form);
    }
    assert.deepEqual(bad, [], `以下形式不能被 git config 解析：${bad.join(', ')}`);
  });

  it('config：--type 枚举取值与真实 git 一致', () => {
    const { entry } = loadEntry('config');
    const typePat = walkPatterns(entry.grammar, 'grammar').find((n) => n.p?.key === '--type');
    assert.ok(typePat, '未找到 --type 选项');
    const values = typePat.p.param.enum;
    // 用独立探测键，避免被上面 --add 用例写入的值干扰（其值 'v' 非 bool）
    for (const v of values) {
      const r = runGit(['config', '--type', v, '--get', 'gitcue.type-probe']);
      assert.equal(r.status, 1, `--type ${v} 应被接受（干净未命中，exit 1）`);
    }
    // 判别力自检：非法类型必须被 git 拒绝，证明上面的断言有意义
    const bogus = runGit(['config', '--type', 'bogus', '--get', 'gitcue.type-probe']);
    assert.match(bogus.stderr, /unrecognized --type argument/);
  });

  it('config：--global/--local/--system 互斥语义与建模一致', () => {
    const r = runGit(['config', '--global', '--local', '--list']);
    assert.notEqual(r.status, 0, '并用两个文件作用域应报错');
    assert.match(r.stderr, /only one config file at a time/);
  });
});
