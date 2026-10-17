/**
 * 知识库数据·第三批 单元测试（reset/restore/revert/show/stash/status/switch/tag）。
 *
 * 实现说明：
 * - 本文件自包含，不 import src/* 模块，而是按 schema 规则实现等价校验；
 * - 本机 git 2.55 的 `git show -h` 输出被官方截断（仅 15 行，不含 --stat/--oneline 等），
 *   因此 show 不做 -h 文本比对，改为在沙箱仓库中真实执行验证选项可被 git 接受；
 * - git 子进程一律使用隔离环境（GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM 指向沙箱内空文件、
 *   GIT_TERMINAL_PROMPT=0），仓库只建在 .sandbox/ 内，绝不触碰工作区之外；
 * - GITCUE_HOME 指向 .sandbox/home/data-3/（本测试不写用户级数据，此为安全自检兜底）。
 */

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------- 路径常量（全部限定在工作区内） ----------

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'commands');
/** 本批独占沙箱：git 夹具仓库根。 */
const SB = path.join(ROOT, '.sandbox', 'data-3');
/** GITCUE_HOME（位于 .sandbox/home 之下，且为本批独占子目录）。 */
const HOME = path.join(ROOT, '.sandbox', 'home', 'data-3');
const REPO = path.join(SB, 'repo');

const COMMANDS = ['reset', 'restore', 'revert', 'show', 'stash', 'status', 'switch', 'tag'];

// ---------- 校验常量 ----------

const PARAM_KINDS = new Set(['branch', 'tag', 'remote', 'commit', 'stash', 'pathspec', 'enum', 'text']);
const OPTION_KEY_RE = /^(-[a-zA-Z0-9]|--[a-z0-9][a-z0-9-]*)$/;
const LITERAL_KEY_RE = /^[a-z][a-z0-9-]*$/;
const COMMAND_NAME_RE = /^[a-z][a-z0-9-]*$/;
const SINCE_RE = /^\d+\.\d+$/;
const CJK_RE = /[\u4e00-\u9fff]/;
/** 选项按官方 SYNOPSIS 挑常用 ≥ 8 个。 */
const MIN_OPTION_COUNT = 8;

// ---------- git 隔离环境 ----------

/** 沙箱内提交身份（禁止 --global/--system，一律 -c 附加）。 */
const ID = ['-c', 'user.name=gitcue-test', '-c', 'user.email=test@gitcue.local'];

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(SB, 'git-global.cfg'),
  GIT_CONFIG_SYSTEM: path.join(SB, 'git-system.cfg'),
  GIT_TERMINAL_PROMPT: '0',
  GITCUE_HOME: HOME,
};

/** 本机是否有可用 git（无则跳过涉及真实 git 的用例，如实标注）。 */
const GIT_OK = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
})();

// ---------- 小工具 ----------

/** Unicode 码点数。 */
const cps = (s) => [...s].length;

/** 按 。！？； 粗计句数。 */
const sentences = (s) => [...s].filter((ch) => '。！？；'.includes(ch)).length;

function readEntry(name) {
  const file = path.join(DATA_DIR, `${name}.json`);
  assert.ok(fs.existsSync(file), `缺少知识库文件 ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 递归收集 grammar 中的全部 pattern 及其作用域。
 * scope 为 literal 路径数组（根序列为 []，stash push 分支为 ['push']）。
 * 递归进入 literal.then 与 group.members（编译后 group 摊平，成员仍是独立 pattern）。
 * literal 匹配后只在 then 序列内匹配——命名唯一性按作用域判定。
 */
function collectPatterns(grammar, scope = []) {
  const out = [];
  for (const p of grammar ?? []) {
    out.push({ p, scope });
    if (p.type === 'literal' && Array.isArray(p.then)) {
      out.push(...collectPatterns(p.then, [...scope, p.key]));
    } else if (p.type === 'group') {
      out.push(...collectPatterns(p.members, scope));
    }
  }
  return out;
}

/** 展开 pattern 的显示名集合（key ∪ aliases）。 */
function namesOf(p) {
  return [p.key, ...(p.aliases ?? [])];
}

/** 条目内全部显式占名（供“--no-x 未被显式认领”判定）。 */
function explicitClaims(entry) {
  const set = new Set();
  for (const { p } of collectPatterns(entry.grammar)) {
    if (p.type === 'option' || p.type === 'literal') {
      for (const n of namesOf(p)) set.add(n);
    }
  }
  return set;
}

/**
 * 互斥组表：group(mode:"mutex") 成员与显式 mutex 字段统一归并为 组ID → 成员名集合。
 * （两种写法语义等价。）
 */
function mutexGroups(entry) {
  const groups = new Map();
  let seq = 0;
  const add = (id, memberNames) => {
    if (!groups.has(id)) groups.set(id, new Set());
    for (const n of memberNames) groups.get(id).add(n);
  };
  const walk = (patterns) => {
    for (const p of patterns ?? []) {
      if (p.type === 'group') {
        if (p.mode === 'mutex') add(`#grp${++seq}`, p.members.flatMap(namesOf));
        walk(p.members);
      } else if (p.type === 'literal') {
        walk(p.then);
      } else if (p.mutex) {
        add(p.mutex, namesOf(p));
      }
    }
  };
  walk(entry.grammar);
  return groups;
}

/** 断言给定名字集合两两处于同一互斥组。 */
function assertSameMutex(groups, names, label) {
  const ok = [...groups.values()].some((g) => names.every((n) => g.has(n)));
  assert.ok(ok, `${label}: ${names.join('、')} 应处于同一互斥组`);
}

/** 校验 Param。 */
function checkParam(param, label) {
  if (param === undefined || param === null) return; // option 可无参数
  assert.ok(typeof param === 'object' && !Array.isArray(param), `${label}: 必须为对象`);
  assert.ok(PARAM_KINDS.has(param.kind), `${label}: kind 枚举非法（${param.kind}）`);
  assert.ok(
    typeof param.name === 'string' && param.name.length > 0 && !/[<>]/.test(param.name),
    `${label}: name 应为不含尖括号的非空字符串`,
  );
  if (param.kind === 'enum') {
    assert.ok(Array.isArray(param.enum) && param.enum.length > 0, `${label}: enum 须为非空数组`);
    assert.equal(new Set(param.enum).size, param.enum.length, `${label}: enum 值不得重复`);
    for (const v of param.enum) assert.ok(typeof v === 'string' && v.length > 0, `${label}: enum 值须为非空字符串`);
  } else {
    assert.equal(param.enum, undefined, `${label}: 仅 kind:"enum" 允许 enum 字段`);
  }
}

/** 校验单个 Pattern（四类）。label 用于断言消息定位。 */
function checkPattern(p, label) {
  assert.ok(typeof p === 'object' && p !== null && !Array.isArray(p), `${label}: pattern 必须是对象`);
  if (p.type === 'group') {
    // group 仅有 type/mode/optional/members 四个字段，无 popularity/summary
    assert.ok(p.mode === 'mutex' || p.mode === 'repeat', `${label}: group.mode 应为 mutex|repeat`);
    assert.ok(Array.isArray(p.members) && p.members.length > 0, `${label}: members 须为非空数组`);
    for (const m of p.members) {
      assert.notEqual(m.type, 'group', `${label}: group 成员不得再嵌 group`);
    }
    return;
  }
  // option / positional / literal 的公共质量字段
  assert.ok(
    Number.isInteger(p.popularity) && p.popularity >= 1 && p.popularity <= 5,
    `${label}: popularity 需为 1–5 的整数`,
  );
  assert.ok(typeof p.summary === 'string' && p.summary.length > 0, `${label}: summary 必填`);
  assert.ok(cps(p.summary) <= 40, `${label}: summary 超 40 码点（实际 ${cps(p.summary)}）`);
  assert.ok(CJK_RE.test(p.summary), `${label}: summary 应为中文说明`);
  if (p.detail !== undefined) {
    assert.ok(typeof p.detail === 'string', `${label}: detail 应为字符串`);
    assert.ok(sentences(p.detail) <= 3, `${label}: detail 不得超过 3 句`);
  }
  if (p.example !== undefined) {
    assert.ok(typeof p.example === 'string' && p.example.length > 0, `${label}: example 应为非空字符串`);
  }
  if (p.since !== undefined && p.since !== null) {
    assert.match(p.since, SINCE_RE, `${label}: since 应形如 2.35`);
  }
  switch (p.type) {
    case 'option': {
      assert.match(p.key, OPTION_KEY_RE, `${label}: 选项 key 格式非法（${p.key}）`);
      const aliases = p.aliases ?? [];
      assert.ok(Array.isArray(aliases), `${label}: aliases 应为数组`);
      for (const a of aliases) {
        assert.match(a, OPTION_KEY_RE, `${label}: 别名 ${a} 格式非法`);
        assert.notEqual(a, p.key, `${label}: 别名不得等于 key`);
      }
      assert.equal(new Set(aliases).size, aliases.length, `${label}: 别名不得重复`);
      checkParam(p.param, `${label}.param`);
      if (p.mutex !== undefined && p.mutex !== null) {
        assert.ok(typeof p.mutex === 'string' && p.mutex.length > 0, `${label}: mutex 应为非空字符串`);
      }
      break;
    }
    case 'positional': {
      assert.ok(p.param !== undefined && p.param !== null, `${label}: positional 必须有 param`);
      checkParam(p.param, `${label}.param`);
      break;
    }
    case 'literal': {
      assert.match(p.key, LITERAL_KEY_RE, `${label}: literal key 格式非法（${p.key}）`);
      if (p.then !== undefined) assert.ok(Array.isArray(p.then), `${label}: then 应为数组`);
      break;
    }
    default:
      assert.fail(`${label}: 未知 pattern type「${p.type}」`);
  }
}

/** 在条目中查找选项：按 key 或别名匹配；可限定作用域（如 ['push']）。 */
function findOption(entry, keyOrAlias, scope = null) {
  return collectPatterns(entry.grammar).find(
    ({ p, scope: s }) =>
      p.type === 'option' &&
      (p.key === keyOrAlias || (p.aliases ?? []).includes(keyOrAlias)) &&
      (scope === null || s.join('/') === scope.join('/')),
  )?.p;
}

/** 顶层（根作用域）positional 序列。 */
function rootPositionals(entry) {
  return entry.grammar.filter((p) => p.type === 'positional');
}

/** 统计全条目 option pattern 数（含 group 成员与 literal 分支，常用选项 ≥8 的口径）。 */
function countOptions(entry) {
  return collectPatterns(entry.grammar).filter(({ p }) => p.type === 'option').length;
}

// ---------- 最低建模要求（按命令） ----------

const MINIMUM = {
  reset(e, groups) {
    // positional：commit(可选) → pathspec(repeat,可选)
    const pos = rootPositionals(e);
    assert.deepEqual(pos.map((p) => p.param.kind), ['commit', 'pathspec'], 'reset: positional 序列应为 commit、pathspec');
    assert.equal(pos[0].optional, true, 'reset: <commit> 应可选');
    assert.equal(pos[1].repeatable, true, 'reset: <pathspec> 应可重复');
    assert.equal(pos[1].optional, true, 'reset: <pathspec> 应可选');
    // --soft/--mixed/--hard 三者互斥组
    assertSameMutex(groups, ['--soft', '--mixed', '--hard'], 'reset');
    assert.ok(findOption(e, '-p') && findOption(e, '--patch'), 'reset: 应含 -p/--patch');
  },
  restore(e, groups) {
    const pos = rootPositionals(e);
    assert.equal(pos.length, 1, 'restore: 应只有 1 个 positional');
    assert.equal(pos[0].param.kind, 'pathspec', 'restore: positional 应为 pathspec');
    assert.equal(pos[0].repeatable, true, 'restore: <pathspec> 应可重复');
    assert.notEqual(pos[0].optional, true, 'restore: <pathspec> 应必填');
    const s = findOption(e, '-s');
    assert.ok(s, 'restore: 应含 -s/--source');
    assert.equal(s.param?.kind, 'commit', 'restore: -s 的参数 kind 应为 commit');
    assertSameMutex(groups, ['--staged', '--worktree'], 'restore（-S/-W 互斥组）');
    assert.ok(findOption(e, '-p'), 'restore: 应含 -p');
  },
  revert(e, groups) {
    const pos = rootPositionals(e);
    assert.deepEqual(pos.map((p) => p.param.kind), ['commit'], 'revert: positional 应为 commit');
    assert.equal(pos[0].repeatable, true, 'revert: <commit> 应可重复');
    assert.notEqual(pos[0].optional, true, 'revert: <commit> 应必填');
    assert.ok(findOption(e, '-e') && findOption(e, '--edit'), 'revert: 应含 -e/--edit');
    const n = findOption(e, '-n');
    assert.ok(n && (n.aliases ?? []).includes('--no-commit'), 'revert: -n 应以 --no-commit 为别名');
    assertSameMutex(groups, ['--continue', '--abort', '--skip'], 'revert（序列控制互斥组）');
  },
  show(e) {
    const pos = rootPositionals(e);
    assert.deepEqual(pos.map((p) => p.param.kind), ['commit', 'pathspec'], 'show: positional 序列应为 commit、pathspec');
    assert.equal(pos[0].optional, true, 'show: <object> 应可选');
    assert.equal(pos[1].optional, true, 'show: <pathspec> 应可选');
    assert.equal(pos[1].repeatable, true, 'show: <pathspec> 应可重复');
    assert.ok(findOption(e, '--stat') && findOption(e, '-s') && findOption(e, '--oneline'), 'show: 应含 --stat/-s/--oneline');
    assert.ok(findOption(e, '--name-only'), 'show: 应含 --name-only');
    const fmt = findOption(e, '--format');
    assert.ok(fmt && fmt.param?.kind === 'text', 'show: --format 应为 text 参数');
  },
  stash(e) {
    const literals = e.grammar.filter((p) => p.type === 'literal').map((p) => p.key);
    for (const k of ['push', 'pop', 'apply', 'drop', 'list', 'show', 'clear', 'branch']) {
      assert.ok(literals.includes(k), `stash: 应含 literal 分支 ${k}`);
    }
    // 根 -p/--patch
    assert.ok(findOption(e, '-p', []) && findOption(e, '--patch', []), 'stash: 根作用域应含 -p/--patch');
    // push 分支：-m(text)、-p、pathspec(repeat)
    const m = findOption(e, '-m', ['push']);
    assert.ok(m && m.param?.kind === 'text', 'stash push: -m 参数应为 text');
    assert.ok(findOption(e, '-p', ['push']), 'stash push: 应含 -p');
    const pushPos = (e.grammar.find((p) => p.key === 'push')?.then ?? []).filter((x) => x.type === 'positional');
    assert.equal(pushPos.length, 1, 'stash push: 应只有 1 个 positional');
    assert.equal(pushPos[0].param.kind, 'pathspec', 'stash push: positional 应为 pathspec');
    assert.equal(pushPos[0].repeatable, true, 'stash push: <pathspec> 应可重复');
    assert.equal(pushPos[0].optional, true, 'stash push: <pathspec> 应可选');
    // pop 分支：[<stash>]
    const popPos = (e.grammar.find((p) => p.key === 'pop')?.then ?? []).filter((x) => x.type === 'positional');
    assert.deepEqual(popPos.map((x) => x.param.kind), ['stash'], 'stash pop: positional 应为 stash');
    assert.equal(popPos[0].optional, true, 'stash pop: <stash> 应可选');
    // branch 分支：<branchname>（必填）+ [<stash>]
    const brPos = (e.grammar.find((p) => p.key === 'branch')?.then ?? []).filter((x) => x.type === 'positional');
    assert.deepEqual(brPos.map((x) => x.param.kind), ['branch', 'stash'], 'stash branch: positional 应为 branch、stash');
    assert.notEqual(brPos[0].optional, true, 'stash branch: <branchname> 应必填');
    assert.equal(brPos[1].optional, true, 'stash branch: <stash> 应可选');
  },
  status(e) {
    const pos = rootPositionals(e);
    assert.deepEqual(pos.map((p) => p.param.kind), ['pathspec'], 'status: positional 应为 pathspec');
    assert.equal(pos[0].repeatable, true, 'status: <pathspec> 应可重复');
    assert.equal(pos[0].optional, true, 'status: <pathspec> 应可选');
    assert.ok(findOption(e, '-s') && findOption(e, '--short'), 'status: 应含 -s/--short');
    assert.ok(findOption(e, '-b') && findOption(e, '--branch'), 'status: 应含 -b/--branch');
    assert.ok(findOption(e, '--long') && findOption(e, '--porcelain'), 'status: 应含 --long/--porcelain');
    const u = findOption(e, '-u');
    assert.ok(u && (u.aliases ?? []).includes('--untracked-files'), 'status: 应含 -u/--untracked-files');
  },
  switch(e) {
    const pos = rootPositionals(e);
    assert.deepEqual(pos.map((p) => p.param.kind), ['branch'], 'switch: positional 应为 branch');
    assert.notEqual(pos[0].optional, true, 'switch: <branch> 应必填');
    const c = findOption(e, '-c');
    assert.ok(c && c.param?.kind === 'branch', 'switch: -c 参数 kind 应为 branch');
    assert.ok(findOption(e, '-C'), 'switch: 应含 -C');
    assert.ok(findOption(e, '--detach'), 'switch: 应含 --detach');
    assert.ok(findOption(e, '-f') && findOption(e, '--force'), 'switch: 应含 -f/--force');
    const orphan = findOption(e, '--orphan');
    assert.ok(orphan && orphan.param?.kind === 'branch', 'switch: --orphan 参数 kind 应为 branch');
  },
  tag(e) {
    const pos = rootPositionals(e);
    assert.deepEqual(pos.map((p) => p.param.kind), ['tag', 'commit'], 'tag: positional 序列应为 tag、commit');
    assert.equal(pos[0].optional, true, 'tag: <tagname> 应可选');
    assert.equal(pos[1].optional, true, 'tag: <commit> 应可选');
    assert.ok(findOption(e, '-a') && findOption(e, '--annotate'), 'tag: 应含 -a/--annotate');
    const m = findOption(e, '-m');
    assert.ok(m && m.param?.kind === 'text', 'tag: -m 参数应为 text');
    assert.ok(findOption(e, '-d') && findOption(e, '--delete'), 'tag: 应含 -d/--delete');
    assert.ok(findOption(e, '-l') && findOption(e, '--list'), 'tag: 应含 -l/--list');
    assert.ok(findOption(e, '-f') && findOption(e, '--force'), 'tag: 应含 -f/--force');
    const contains = findOption(e, '--contains');
    assert.ok(contains && contains.param?.kind === 'commit', 'tag: --contains 参数 kind 应为 commit');
  },
};

// ---------- 全局安全自检 ----------

before(() => {
  // 沙箱与 home 必须位于工作区内（防越界自检）
  for (const p of [SB, HOME, REPO, DATA_DIR]) {
    assert.ok(
      path.resolve(p).startsWith(ROOT + path.sep),
      `安全自检失败：${p} 不在工作区 ${ROOT} 内`,
    );
  }
  // GITCUE_HOME 显式指向 .sandbox/home 下本批独占目录（绝不写真实主目录）
  process.env.GITCUE_HOME = HOME;
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(SB, { recursive: true });
  // git 隔离配置指向沙箱内空文件（不读真实全局/系统配置）
  fs.writeFileSync(GIT_ENV.GIT_CONFIG_GLOBAL, '');
  fs.writeFileSync(GIT_ENV.GIT_CONFIG_SYSTEM, '');
});

// ---------- 用例 1：schema 与文案质量（全 8 命令） ----------

describe('知识库条目：schema 与文案质量', () => {
  for (const name of COMMANDS) {
    test(`${name}.json：顶层字段与全量 pattern 合法`, () => {
      const e = readEntry(name);
      assert.equal(e.schemaVersion, '1.0', 'schemaVersion 应为 1.0');
      assert.equal(e.command, name, 'command 字段应与文件名一致');
      assert.match(e.command, COMMAND_NAME_RE, 'command 命名格式');
      assert.ok(['porcelain', 'plumbing', 'custom'].includes(e.category), 'category 枚举非法');
      assert.ok(
        Number.isInteger(e.popularity) && e.popularity >= 1 && e.popularity <= 5,
        '命令级 popularity 需为 1–5 整数',
      );
      assert.ok(typeof e.summary === 'string' && cps(e.summary) <= 40 && CJK_RE.test(e.summary), 'summary 中文且 ≤ 40 码点');
      assert.ok(Array.isArray(e.grammar) && e.grammar.length > 0, 'grammar 须为非空数组');

      // 全量 pattern 递归校验（含 literal 分支与 group 成员）
      for (const { p, scope } of collectPatterns(e.grammar)) {
        const label = `${name}${scope.length ? ` ${scope.join(' ')} 分支` : ''}`;
        checkPattern(p, label);
      }
      // 常用选项 ≥ 8 个
      assert.ok(
        countOptions(e) >= MIN_OPTION_COUNT,
        `${name}: option pattern 共 ${countOptions(e)} 个，应 ≥ ${MIN_OPTION_COUNT}`,
      );
      // 条目级 examples / notes（可选字段，存在则校验质量）
      if (e.examples !== undefined) {
        assert.ok(Array.isArray(e.examples) && e.examples.length > 0, 'examples 应为非空数组');
        for (const ex of e.examples) {
          assert.ok(typeof ex.cmd === 'string' && ex.cmd.startsWith('git '), '示例 cmd 应以 "git " 开头');
          assert.ok(typeof ex.note === 'string' && ex.note.length > 0, '示例 note 非空');
        }
      }
      if (e.notes !== undefined) {
        for (const n of e.notes) assert.ok(cps(n) <= 40, `note 超 40 码点：「${n}」`);
      }
    });

    test(`${name}.json：选项命名在作用域内两两不相交（互斥展开后）`, () => {
      const e = readEntry(name);
      const claims = explicitClaims(e);
      // 按 literal 分支作用域分组（不同分支的可用集合互不相干）
      const byScope = new Map();
      for (const { p, scope } of collectPatterns(e.grammar)) {
        if (p.type !== 'option') continue;
        const key = scope.join('/') || '(root)';
        const names = new Set(namesOf(p));
        // 长选项 key 的 --no-x 隐式否定（未被显式认领时）同样参与唯一性
        if (p.key.startsWith('--') && !p.key.startsWith('--no-')) {
          const neg = `--no-${p.key.slice(2)}`;
          if (!claims.has(neg)) names.add(neg);
        }
        if (!byScope.has(key)) byScope.set(key, []);
        byScope.get(key).push({ names: [...names], key: p.key });
      }
      for (const [scope, opts] of byScope) {
        const seen = new Map(); // 名字 → 首次出现的 key
        for (const { names, key } of opts) {
          for (const n of names) {
            assert.ok(
              !seen.has(n),
              `${name} ${scope}: 名字「${n}」同时属于 ${seen.get(n)} 与 ${key}（违反两两不相交）`,
            );
            seen.set(n, key);
          }
        }
      }
    });

    test(`${name}.json：满足最低建模要求`, () => {
      const e = readEntry(name);
      MINIMUM[name](e, mutexGroups(e));
    });
  }
});

// ---------- 用例 2：离线比对 git <cmd> -h（show 因 -h 截断除外） ----------

describe('离线比对：选项名见于本机 git <cmd> -h（git 2.55，只读帮助命令）', () => {
  // git 2.55 的 `git show -h` 输出被截断（仅 15 行），show 改走真实执行验证（见下个 describe）
  for (const name of COMMANDS.filter((c) => c !== 'show')) {
    test(
      `git ${name} -h 覆盖 ${name}.json 的全部选项与 literal`,
      { skip: GIT_OK ? false : '本机无 git，跳过离线比对' },
      () => {
        const r = spawnSync('git', [name, '-h'], {
          cwd: ROOT, // 工作区根（非仓库目录），-h 为只读帮助命令
          env: GIT_ENV,
          encoding: 'utf8',
          maxBuffer: 4 << 20,
        });
        assert.ok(r.stdout || r.stderr, `git ${name} -h 无输出`);
        // --[no-]xxx 形式归一化为 --xxx 后再比对
        const help = (r.stdout + r.stderr).replaceAll('[no-]', '');
        const e = readEntry(name);
        for (const { p, scope } of collectPatterns(e.grammar)) {
          const where = scope.length ? `（${scope.join(' ')} 分支）` : '';
          if (p.type === 'option') {
            for (const n of namesOf(p)) {
              assert.ok(help.includes(n), `git ${name} -h 未收录「${n}」${where}`);
            }
          } else if (p.type === 'literal') {
            assert.ok(help.includes(p.key), `git ${name} -h 未出现子命令「${p.key}」`);
          }
        }
      },
    );
  }
});

// ---------- 用例 3：show 真实执行验证（弥补 -h 截断） ----------

describe('show 真实执行验证（沙箱仓库，选项可被本机 git 接受）', () => {
  before(() => {
    if (!GIT_OK) return; // 无 git 时仅跳过用例，夹具不建
    // 每次运行重建夹具仓库（.sandbox/data-3/repo，绝不在工作区外建库）
    fs.rmSync(REPO, { recursive: true, force: true });
    fs.mkdirSync(SB, { recursive: true });
    const g = (args, cwd = SB) =>
      spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', maxBuffer: 4 << 20 });
    assert.equal(g(['init', '-q', '-b', 'main', 'repo']).status, 0, 'git init 夹具失败');
    fs.writeFileSync(path.join(REPO, 'README.md'), '# data-3 fixture\n');
    assert.equal(g(['-C', REPO, ...ID, 'add', '-A']).status, 0, 'git add 夹具失败');
    assert.equal(g(['-C', REPO, ...ID, 'commit', '-q', '-m', 'init']).status, 0, 'git commit 夹具失败');
    // 夹具自检：确实是工作区内的 git 仓库
    const probe = g(['-C', REPO, 'rev-parse', '--is-inside-work-tree']);
    assert.equal(probe.stdout.trim(), 'true', '夹具仓库探测失败');
  });

  test(
    'show.json 全部选项真实执行退出码为 0',
    { skip: GIT_OK ? false : '本机无 git，跳过执行验证' },
    () => {
      const runs = [
        [],               // 基线：git show 默认输出
        ['--stat'],
        ['-s'],
        ['--no-patch'],   // -s 的别名
        ['--oneline'],
        ['--name-only'],
        ['--name-status'],
        ['--format=%s'],  // --format 带 text 参数
        ['--abbrev-commit'],
        ['-q'],
      ];
      for (const args of runs) {
        const r = spawnSync('git', ['-C', REPO, 'show', ...args], {
          env: GIT_ENV,
          encoding: 'utf8',
          maxBuffer: 4 << 20,
        });
        assert.equal(r.status, 0, `git show ${args.join(' ')} 退出码 ${r.status}：${r.stderr}`);
      }
    },
  );

  test(
    '阴性对照：未知选项应被 git 拒绝（证明上面的退出码检查有效）',
    { skip: GIT_OK ? false : '本机无 git，跳过执行验证' },
    () => {
      const r = spawnSync('git', ['-C', REPO, 'show', '--definitely-not-an-option'], {
        env: GIT_ENV,
        encoding: 'utf8',
        maxBuffer: 4 << 20,
      });
      assert.notEqual(r.status, 0, '未知选项不应退出码 0');
    },
  );
});
