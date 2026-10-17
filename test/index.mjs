// test/index.mjs —— `node --test test/` 的目录入口垫片（非测试文件，glob 不收集）。
//
// 背景：本机 Node v24.19.0 起，`node --test` 的位置参数按"入口路径"处理：传目录不再
// 递归收集其中的测试文件，而是把目录当子进程入口直接 spawn（目录无 package.json/main
// 时报 MODULE_NOT_FOUND，即全量单测失败的直接根因）。
//
// 方案：本文件作为该入口，以子进程重放真实全量套件（node --test "test/*.test.mjs"，
// 与 npm test 完全一致，保持每文件独立进程隔离——各套件在 before() 中改写
// process.env.GITCUE_HOME，单进程混跑会互窜），并把退出码透传给外层运行器：
// 套件全绿 → 本入口退出 0；任何失败 → 退出非 0。套件明细写入 stderr（不写 stdout，
// 避免污染 node:test 子进程协议流）。
//
// 沙箱边界：内层套件自身的沙箱规则不变（.sandbox/ 按模块划分；GITCUE_HOME 位于
// .sandbox/home/ 下；git 一律沙箱内 init）。本垫片不读写工作区之外的任何路径。

import { readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, '..');
const files = readdirSync(HERE).filter((f) => f.endsWith('.test.mjs')).sort();

if (files.length === 0) {
  // 一个测试文件都没有属于异常状态：显式失败，绝不静默通过
  process.stderr.write('gitcue 测试套件：test/ 下未发现任何 *.test.mjs 文件\n');
  process.exitCode = 1;
} else {
  // 清除外层运行器注入的子进程上下文标记，否则内层 node --test 会判定"测试内递归
  // 调用"并跳过全部文件（表现为秒级假通过，绝不可接受）。
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // stdio：内层 stdout/stderr 都接到本进程 stderr（保持 stdout 纯净），stdin 继承
  const child = spawn(
    process.execPath,
    ['--test', 'test/*.test.mjs'],
    { cwd: ROOT, env, stdio: ['inherit', 2, 'inherit'], shell: false },
  );
  child.on('error', (err) => {
    process.stderr.write(`gitcue 测试套件：无法启动内层运行器：${err && err.message}\n`);
    process.exitCode = 1;
  });
  child.on('close', (code) => {
    process.exitCode = code ?? 1;
  });
}
