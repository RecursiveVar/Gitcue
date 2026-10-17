/**
 * bin/gitcue.mjs 端到端测试：CLI 分派与退出码。
 * 覆盖：--version/--help/用法错误 exit 2/--reset-usage/config 子命令输出与告警；
 * 单次模式与 validate-data 在依赖模块（知识库/建议/执行）就绪时执行真实断言，
 * 未就绪时显式 skip，绝不伪造通过。
 *
 * 安全边界：所有子进程 GITCUE_HOME 一律指向 .sandbox/m1/home/<用例名>/；
 * 涉及 git 的夹具在 .sandbox/m1/repo 内创建，git 配置指向沙箱空文件。
 */

import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createUsage } from '../src/usage.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'bin', 'gitcue.mjs');
const SB = path.join(ROOT, '.sandbox', 'm1');

/** 单次模式依赖的模块（知识库 loader/validate、建议、执行 runner）是否就绪 */
const KB_READY =
  existsSync(path.join(ROOT, 'src', 'kb', 'loader.mjs')) &&
  existsSync(path.join(ROOT, 'src', 'parser', 'suggest.mjs'));
const VALIDATE_READY = existsSync(path.join(ROOT, 'src', 'kb', 'validate.mjs'));
const RUNNER_READY = existsSync(path.join(ROOT, 'src', 'exec', 'runner.mjs'));

/** 建立独占用例 home 目录 */
function freshCase(name) {
  mkdirSync(SB, { recursive: true });
  const dir = path.join(SB, 'home', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 运行 CLI（捕获输出与退出码） */
function runBin(argv, { home, cwd = ROOT } = {}) {
  assert.ok(home, '必须显式提供沙箱 home（安全边界）');
  return spawnSync(process.execPath, [BIN, ...argv], {
    encoding: 'utf8',
    cwd,
    env: {
      ...process.env,
      GITCUE_HOME: home,
      GIT_TERMINAL_PROMPT: '0',
      GITCUE_LOG: '', // 默认关闭日志，保持 stdout 纯净
    },
  });
}

// —— 安全自检 ——
before(() => {
  process.env.GITCUE_HOME = path.join(SB, 'home');
  const resolved = path.resolve(process.env.GITCUE_HOME);
  assert.ok(resolved.startsWith(path.resolve(ROOT)), `GITCUE_HOME 越界：${resolved}`);
});

describe('bin 分派：version / help / 用法错误', () => {
  test('--version 与 -V 输出 "gitcue 0.1.0"，退出码 0', () => {
    for (const flag of ['--version', '-V']) {
      const r = runBin([flag], { home: freshCase('version') });
      assert.equal(r.status, 0, flag);
      assert.equal(r.stdout, 'gitcue 0.1.0\n');
    }
  });

  test('--help 输出帮助文本，退出码 0', () => {
    const r = runBin(['--help'], { home: freshCase('help') });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('用法'));
    assert.ok(r.stdout.includes('validate-data'));
    assert.ok(r.stdout.includes('--reset-usage'));
  });

  test('-h 等价 --help；--lang en-US 输出英文帮助', () => {
    const zh = runBin(['-h'], { home: freshCase('help-zh') });
    assert.equal(zh.status, 0);
    assert.ok(zh.stdout.includes('用法'));
    const en = runBin(['--lang', 'en-US', '--help'], { home: freshCase('help-en') });
    assert.ok(en.stdout.includes('Usage:'));
  });

  test('未知 flag / 非法 --lang / 多位置参数 → 退出码 2 且错误走 stderr', () => {
    for (const argv of [['--bogus'], ['--lang', 'fr'], ['a', 'b']]) {
      const r = runBin(argv, { home: freshCase('usage-error') });
      assert.equal(r.status, 2, JSON.stringify(argv));
      assert.ok(r.stderr.length > 0, '错误信息应在 stderr');
      assert.equal(r.stdout, '', '用法错误不应有 stdout');
    }
  });
});

describe('bin 分派：--reset-usage', () => {
  test('清除既有统计文件，退出码 0，stdout 提示路径', () => {
    const home = freshCase('reset-usage');
    const file = path.join(home, 'usage.json');
    const u = createUsage({ file });
    u.bump('cmd:log');
    u.flush();
    assert.equal(existsSync(file), true, '前置：统计文件已存在');

    const r = runBin(['--reset-usage'], { home });
    assert.equal(r.status, 0);
    assert.equal(existsSync(file), false, '统计文件应被删除');
    assert.ok(r.stdout.includes(file), r.stdout);
    assert.ok(r.stdout.includes('已清除使用频率统计'));
  });

  test('文件本不存在时也成功', () => {
    const home = freshCase('reset-usage-missing');
    const r = runBin(['--reset-usage'], { home });
    assert.equal(r.status, 0);
    assert.equal(existsSync(path.join(home, 'usage.json')), false);
  });
});

describe('bin 分派：config 子命令', () => {
  test('打印 GITCUE_HOME、用户级/项目级路径与当前生效配置', () => {
    const home = freshCase('config-basic');
    writeFileSync(path.join(home, 'config.toml'), 'candidate_limit = 5\n', 'utf8');
    const cwd = path.join(SB, 'config-proj');
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(path.join(cwd, '.gitcue.toml'), 'theme = "contrast"\n', 'utf8');

    const r = runBin(['config'], { home, cwd });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes(`GITCUE_HOME: ${home}`), r.stdout);
    assert.ok(r.stdout.includes(path.join(home, 'config.toml')));
    assert.ok(r.stdout.includes(path.join(cwd, '.gitcue.toml')));
    assert.ok(r.stdout.includes('candidate_limit = 5'), '用户级配置应生效');
    assert.ok(r.stdout.includes('theme = "contrast"'), '项目级配置应覆盖默认');
    assert.ok(r.stdout.includes('lang = "zh-CN"'), '未覆盖项显示默认值');
    assert.ok(r.stdout.includes('已加载'), '应显示加载来源');
    assert.equal(r.stderr, '', '无非法项时不应有告警');
    rmSync(cwd, { recursive: true, force: true });
  });

  test('配置文件不存在时标注（不存在，可创建）', () => {
    const home = freshCase('config-missing');
    const cwd = path.join(SB, 'config-empty');
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd, { recursive: true });
    const r = runBin(['config'], { home, cwd });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('（不存在，可创建）'));
    assert.ok(r.stdout.includes('candidate_limit = 8'), '默认值');
    rmSync(cwd, { recursive: true, force: true });
  });

  test('非法配置项 → stderr 告警，生效值回退默认', () => {
    const home = freshCase('config-warn');
    writeFileSync(path.join(home, 'config.toml'), 'lang = "fr"\nfoo = 1\n', 'utf8');
    const r = runBin(['config'], { home, cwd: SB }); // cwd 存在且无 .gitcue.toml
    assert.equal(r.status, 0, '告警不改变退出码');
    assert.ok(r.stderr.includes('lang'), r.stderr);
    assert.ok(r.stderr.includes('foo'), r.stderr);
    assert.ok(r.stdout.includes('lang = "zh-CN"'), '回退默认语言');
  });
});

describe('bin 分派：单次模式（依赖 M2/M3，未就绪则 skip）', () => {
  test('gitcue "git log --on" --plain：稳定输出 + 退出码 0（验收场景 8）', { skip: !KB_READY }, () => {
    const home = freshCase('once-log');
    const r1 = runBin(['git log --on', '--plain'], { home });
    assert.equal(r1.status, 0, `stderr: ${r1.stderr}`);
    assert.ok(r1.stdout.startsWith('语法: git log'), r1.stdout);
    assert.ok(r1.stdout.includes('候选('), r1.stdout);
    assert.ok(r1.stdout.includes('--oneline'), r1.stdout);
    assert.ok(r1.stdout.includes('位置: '), r1.stdout);
    assert.ok(r1.stdout.includes('提示: '), r1.stdout);
    // 字节稳定：同输入同环境两次运行输出一致
    const r2 = runBin(['git log --on', '--plain'], { home });
    assert.equal(r2.stdout, r1.stdout, '两次运行输出应逐字节一致');
  });

  test('未知选项 Token：默认退出码 0，--strict 退出码 2', { skip: !KB_READY }, () => {
    const home = freshCase('once-strict');
    const r0 = runBin(['git log --definitely-not-an-option', '--plain'], { home });
    assert.equal(r0.status, 0, `stderr: ${r0.stderr}`);
    assert.ok(r0.stdout.includes('⚠'), '输出应标注 ⚠ 未识别');

    const r2 = runBin(['git log --definitely-not-an-option', '--plain', '--strict'], { home });
    assert.equal(r2.status, 2, '--strict 且存在未识别 Token → 退出码 2');
  });

  test('合法命令 --strict 退出码 0', { skip: !KB_READY }, () => {
    const home = freshCase('once-strict-ok');
    const r = runBin(['git log --oneline', '--plain', '--strict'], { home });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('--lang en-US 切换行前缀', { skip: !KB_READY }, () => {
    const home = freshCase('once-en');
    const r = runBin(['git log --on', '--plain', '--lang', 'en-US'], { home });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.startsWith('Syntax: git log'), r.stdout);
  });

  test('不执行命令：单次模式无 --exec 时不产生子进程输出', { skip: !KB_READY }, () => {
    const home = freshCase('once-noexec');
    const r = runBin(['git rev-parse --verify definitely-missing-ref', '--plain'], { home });
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes('fatal'), '不应出现 git 报错（命令未被执行）');
  });

  test('--exec：输出建议后执行，退出码透传（128）', { skip: !KB_READY || !RUNNER_READY }, () => {
    const home = freshCase('once-exec-fail');
    const cwd = freshCase('once-exec-cwd'); // 非 git 目录 → git log 失败退出 128
    // 注：rev-parse 未被收录，此处用已收录的 log
    const r = runBin(['git log --oneline', '--plain', '--exec'], { home, cwd });
    assert.equal(r.status, 128, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(r.stdout.startsWith('语法: git log'), '应先输出建议');
  });

  test('--exec：成功命令退出码 0', { skip: !KB_READY || !RUNNER_READY }, () => {
    const home = freshCase('once-exec-ok');
    const r = runBin(['git version', '--plain', '--exec'], { home });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('语法: '), '应先输出建议');
    assert.ok(r.stdout.includes('git version'), '应包含 git version 输出');
  });

  test('未收录命令：正常输出建议，--strict 不触发', { skip: !KB_READY }, () => {
    const home = freshCase('once-uncovered');
    const r = runBin(['git mytool --flag1', '--plain', '--strict'], { home });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('未收录'), '语法行应提示未收录');
  });

  test('M2/M3 未就绪时：单次模式明确报错退出 1（诚实降级）', { skip: KB_READY }, () => {
    const home = freshCase('once-missing-module');
    const r = runBin(['git log --on', '--plain'], { home });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('模块'), r.stderr);
  });
});

describe('bin 分派：validate-data 子命令（依赖 M2，未就绪则 skip）', () => {
  test('输出校验摘要，合法数据退出码 0 / 有错误退出码 2', { skip: !VALIDATE_READY }, () => {
    const home = freshCase('validate-data');
    const r = runBin(['validate-data'], { home });
    assert.ok(r.stdout.includes('校验完成'), r.stdout);
    assert.ok(r.status === 0 || r.status === 2, `退出码应为 0 或 2，实际 ${r.status}`);
  });

  test('M2 未就绪时：明确报错退出 1', { skip: VALIDATE_READY }, () => {
    const home = freshCase('validate-missing');
    const r = runBin(['validate-data'], { home });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('模块'), r.stderr);
  });
});

describe('bin：沙箱 git 夹具（供 --exec 类用例复用；安全边界自检）', () => {
  test('git init 沙箱仓库成功且不越界（仅当需要真实仓库的用例运行时使用）', () => {
    const repo = path.join(SB, 'repo');
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(repo, { recursive: true });
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(SB, 'git-global.cfg'),
      GIT_CONFIG_SYSTEM: path.join(SB, 'git-system.cfg'),
      GIT_TERMINAL_PROMPT: '0',
      GITCUE_HOME: path.join(SB, 'home'),
    };
    writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '', 'utf8');
    writeFileSync(gitEnv.GIT_CONFIG_SYSTEM, '', 'utf8');
    execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: repo, env: gitEnv });
    // 路径越界自检
    assert.ok(path.resolve(repo).startsWith(path.resolve(ROOT)), '夹具必须位于工作区内');
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repo,
      env: gitEnv,
      encoding: 'utf8',
    }).trim();
    assert.equal(inside, 'true');
  });
});
