// test/m3-fixtures.mjs —— 解析器单元测试共享夹具（非测试文件，node --test 不会收集）
// REBASE_GRAMMAR 与 data/commands/rebase.json 条目的 grammar 逐字段一致，
// 其余为覆盖各匹配规则的最小语法。fake KbDb/providers/usage 按各模块的注入契约构造。

import { compilePatterns } from '../src/parser/machine.mjs';
import { renderSkeleton } from '../src/parser/skeleton.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 本模块沙箱根与独占 home（本模块纯逻辑测试不写用户数据，仅预留目录） */
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const M3_SANDBOX = path.join(HERE, '..', '.sandbox', 'm3');
export const M3_HOME = path.join(M3_SANDBOX, 'home');

/** 预留沙箱 home 目录（幂等） */
export function ensureSandbox() {
  fs.mkdirSync(M3_HOME, { recursive: true });
  const resolved = path.resolve(M3_HOME);
  if (!resolved.startsWith(path.resolve(path.join(HERE, '..')))) {
    throw new Error(`沙箱路径越界：${resolved}`);
  }
  return M3_HOME;
}

/** rebase 的完整 grammar（与 data/commands/rebase.json 逐字段一致） */
export const REBASE_GRAMMAR = [
  {
    type: 'option',
    key: '-i',
    aliases: ['--interactive'],
    optional: true,
    popularity: 5,
    summary: '交互式变基：编辑/压缩/重排提交',
    detail: '启动编辑器列出待重放的提交，可修改顺序、合并或丢弃。编辑器可用 GIT_SEQUENCE_EDITOR 指定。',
    example: 'git rebase -i HEAD~5',
  },
  {
    type: 'option',
    key: '--onto',
    param: { kind: 'commit', name: 'newbase' },
    optional: true,
    popularity: 3,
    summary: '把提交重放到指定新基点上',
    detail: '不切换到 <upstream>，而是把提交重放到 <newbase> 指定的提交之上。常用于把一段提交搬到别的分支。',
    example: 'git rebase --onto main topicA topicB',
  },
  {
    type: 'option',
    key: '--keep-base',
    optional: true,
    since: '2.23',
    popularity: 2,
    summary: '以当前分支与上游共同祖先为基点',
    detail: '以当前分支与 <upstream> 的共同祖先为基点变基，不移动到 <upstream> 本身。',
    example: 'git rebase --keep-base main',
  },
  {
    type: 'option',
    key: '--fork-point',
    optional: true,
    popularity: 2,
    summary: '用 reflog 找出的分叉点作上游',
    detail: '利用 reflog 寻找当前分支与 <upstream> 的分叉点。--no-fork-point 为其反义，二者互斥。',
    example: 'git rebase --fork-point main feature',
  },
  {
    type: 'option',
    key: '-m',
    aliases: ['--merge'],
    optional: true,
    popularity: 2,
    summary: '用合并方式重放提交',
    detail: '对每个提交使用合并策略重放，保留空提交。适合重放相互依赖的提交序列。',
    example: 'git rebase -m main',
  },
  {
    type: 'option',
    key: '-s',
    aliases: ['--strategy'],
    param: { kind: 'enum', name: 'strategy', enum: ['ort', 'recursive', 'octopus', 'ours', 'subtree'] },
    optional: true,
    popularity: 2,
    summary: '指定合并策略',
    detail: 'ort 为 git 2.30 起的默认策略。各策略适用场景见 git-merge 文档。',
    example: 'git rebase -s ours main',
  },
  {
    type: 'option',
    key: '--empty',
    param: { kind: 'enum', name: 'how', enum: ['drop', 'keep', 'ask'] },
    optional: true,
    since: '2.26',
    popularity: 1,
    summary: '指定如何处理变空的提交',
    detail: 'drop 丢弃变空的提交；keep 保留；ask 逐个询问（默认）。',
    example: 'git rebase --empty=drop main',
  },
  {
    type: 'option',
    key: '--autosquash',
    optional: true,
    popularity: 2,
    summary: '自动将 fixup!/squash! 提交归位',
    detail: '与 -i 配合，把 fixup!/squash! 前缀的提交自动移到目标提交之后。',
    example: 'git rebase -i --autosquash main',
  },
  {
    type: 'option',
    key: '--stat',
    optional: true,
    mutex: 'stat-mode',
    popularity: 2,
    summary: '显示变基后的差异统计',
    detail: '变基完成后输出 diffstat，便于确认改动范围。',
    example: 'git rebase --stat main',
  },
  {
    type: 'option',
    key: '-n',
    aliases: ['--no-stat'],
    optional: true,
    mutex: 'stat-mode',
    popularity: 2,
    summary: '不显示差异统计',
    detail: '抑制变基完成后的 diffstat 输出。',
    example: 'git rebase -n main',
  },
  {
    type: 'group',
    mode: 'mutex',
    optional: true,
    members: [
      {
        type: 'option',
        key: '--continue',
        popularity: 5,
        summary: '冲突解决后继续变基',
        detail: '解决冲突并 git add 之后，继续重放剩余提交。',
        example: 'git rebase --continue',
      },
      {
        type: 'option',
        key: '--abort',
        popularity: 4,
        summary: '中止变基并回到原分支',
        detail: '放弃本次变基，分支与工作区回到变基前的状态。',
        example: 'git rebase --abort',
      },
      {
        type: 'option',
        key: '--skip',
        popularity: 2,
        summary: '跳过当前提交继续变基',
        detail: '丢弃当前冲突的提交，继续重放后续提交。',
        example: 'git rebase --skip',
      },
      {
        type: 'option',
        key: '--edit-todo',
        popularity: 1,
        summary: '编辑剩余的待办提交列表',
        detail: '变基中断时修改剩余待办提交列表。',
        example: 'git rebase --edit-todo',
      },
    ],
  },
  {
    type: 'positional',
    param: { kind: 'commit', name: 'upstream' },
    optional: true,
    popularity: 3,
    summary: '上游基点（默认取分支配置）',
    detail: '指定变基的基准提交。省略时使用 branch.<name>.remote/merge 配置。',
    example: 'git rebase origin/main',
  },
  {
    type: 'positional',
    param: { kind: 'branch', name: 'branch' },
    optional: true,
    popularity: 3,
    summary: '要变基的分支（默认当前分支）',
    detail: '检出该分支并将其变基到 <upstream> 之上；省略时变基当前分支。',
    example: 'git rebase main feature',
  },
];

/** literal 分支示范（stash 语法的简化版） */
export const STASH_GRAMMAR = [
  {
    type: 'option',
    key: '-p',
    aliases: ['--patch'],
    optional: true,
    popularity: 3,
    summary: '交互式选择要贮藏的改动',
  },
  {
    type: 'literal',
    key: 'push',
    popularity: 5,
    summary: '贮藏本地改动',
    then: [
      {
        type: 'option',
        key: '-m',
        aliases: ['--message'],
        param: { kind: 'text', name: 'msg' },
        optional: true,
        popularity: 4,
        summary: '附带说明文字',
      },
      {
        type: 'positional',
        param: { kind: 'pathspec', name: 'pathspec' },
        optional: true,
        repeatable: true,
        popularity: 3,
        summary: '只贮藏指定路径',
      },
    ],
  },
  {
    type: 'literal',
    key: 'pop',
    popularity: 4,
    summary: '恢复最近一次贮藏并删除记录',
    then: [{ type: 'positional', param: { kind: 'stash', name: 'stash' }, optional: true, popularity: 3, summary: '指定贮藏条目' }],
  },
  { type: 'literal', key: 'list', popularity: 3, summary: '列出全部贮藏', then: [] },
  { type: 'literal', key: 'clear', popularity: 2, summary: '清空全部贮藏', then: [] },
];

/** 双 positional 示范（mv 语法要点：repeatable 源 + 固定目标） */
export const MV_GRAMMAR = [
  { type: 'option', key: '-f', aliases: ['--force'], optional: true, popularity: 3, summary: '强制移动（覆盖目标）' },
  { type: 'option', key: '-k', optional: true, popularity: 2, summary: '跳过不可移动的文件' },
  { type: 'option', key: '-n', aliases: ['--dry-run'], optional: true, popularity: 2, summary: '只演示不实际移动' },
  {
    type: 'positional',
    param: { kind: 'pathspec', name: 'sources' },
    optional: false,
    repeatable: true,
    popularity: 4,
    summary: '源文件（可多个）',
  },
  {
    type: 'positional',
    param: { kind: 'pathspec', name: 'dest' },
    optional: false,
    popularity: 4,
    summary: '目标路径',
  },
];

/** 组合短选项示范（add 语法要点） */
export const ADD_GRAMMAR = [
  { type: 'option', key: '-A', aliases: ['--all'], optional: true, popularity: 4, summary: '暂存全部改动' },
  { type: 'option', key: '-u', aliases: ['--update'], optional: true, popularity: 3, summary: '暂存已跟踪文件的改动' },
  { type: 'option', key: '-p', aliases: ['--patch'], optional: true, popularity: 3, summary: '交互式挑选改动' },
  { type: 'option', key: '-n', aliases: ['--dry-run'], optional: true, popularity: 2, summary: '只演示不实际暂存' },
  { type: 'option', key: '-f', aliases: ['--force'], optional: true, popularity: 2, summary: '允许添加忽略的文件' },
  {
    type: 'positional',
    param: { kind: 'pathspec', name: 'pathspec' },
    optional: false,
    repeatable: true,
    popularity: 5,
    summary: '要暂存的路径',
  },
];

/** 组合短选项候选示范（小写短选项 -a/-m/-f） */
export const COMMIT_GRAMMAR = [
  { type: 'option', key: '-a', aliases: ['--all'], optional: true, popularity: 4, summary: '暂存并提交全部已跟踪文件' },
  {
    type: 'option',
    key: '-m',
    aliases: ['--message'],
    param: { kind: 'text', name: 'msg' },
    optional: true,
    popularity: 3,
    summary: '提交说明',
  },
  { type: 'option', key: '-f', aliases: ['--allow-empty'], optional: true, popularity: 2, summary: '允许空提交' },
  { type: 'option', key: '--amend', optional: true, popularity: 3, summary: '修正上一次提交' },
];

/** push 简化建模（refspec 用 branch 简化） */
export const PUSH_GRAMMAR = [
  { type: 'option', key: '-f', aliases: ['--force'], optional: true, popularity: 2, summary: '强制推送（覆盖远端）' },
  { type: 'option', key: '-u', aliases: ['--set-upstream'], optional: true, popularity: 3, summary: '建立上游跟踪关系' },
  { type: 'option', key: '--all', optional: true, popularity: 2, summary: '推送全部分支' },
  {
    type: 'positional',
    param: { kind: 'remote', name: 'remote' },
    optional: true,
    popularity: 4,
    summary: '目标远程（默认 origin）',
  },
  {
    type: 'positional',
    param: { kind: 'branch', name: 'branch' },
    optional: true,
    repeatable: true,
    popularity: 4,
    summary: '要推送的分支',
  },
];

/**
 * 构造 KbEntry（compiled 由 compilePatterns 生成、syntaxFull 由 renderSkeleton 预生成，
 * 与 loader 的加载即编译语义一致的等价 fake）。
 */
export function makeEntry(name, grammar, { summary = '', popularity = 3, category = 'porcelain' } = {}) {
  const compiled = compilePatterns(name, grammar);
  return {
    name,
    summary,
    popularity,
    category,
    grammar,
    compiled,
    syntaxFull: renderSkeleton({ commandName: name, compiled }).text,
    examples: [],
    notes: [],
  };
}

/** 构造 fake KbDb（契约：commands/get/names/warnings） */
export function makeKb(entries) {
  const commands = new Map(entries.map((e) => [e.name, e]));
  return {
    schemaVersion: '1.0',
    commands,
    warnings: [],
    get: (name) => commands.get(name),
    names: () => [...commands.keys()],
  };
}

/** 常用命令集（覆盖命令候选过滤/排序/纠错测试） */
export function makeCommonKb(extraEntries = []) {
  return makeKb([
    makeEntry('rebase', REBASE_GRAMMAR, { summary: '在另一个基线之上重放提交', popularity: 4 }),
    makeEntry('stash', STASH_GRAMMAR, { summary: '贮藏工作区改动', popularity: 3 }),
    makeEntry('mv', MV_GRAMMAR, { summary: '移动或重命名文件', popularity: 2 }),
    makeEntry('add', ADD_GRAMMAR, { summary: '暂存改动到索引', popularity: 5 }),
    makeEntry('commit', COMMIT_GRAMMAR, { summary: '记录改动到仓库', popularity: 5 }),
    makeEntry('push', PUSH_GRAMMAR, { summary: '推送提交到远端', popularity: 5 }),
    makeEntry('checkout', [], { summary: '切换分支或恢复文件', popularity: 5 }),
    makeEntry('cherry', [], { summary: '查找等效提交', popularity: 3 }),
    makeEntry('cherry-pick', [], { summary: '拣选提交到当前分支', popularity: 3 }),
    makeEntry('clone', [], { summary: '克隆仓库', popularity: 3 }),
    makeEntry('config', [], { summary: '读写配置', popularity: 3 }),
    makeEntry('remote', [], { summary: '管理远端仓库', popularity: 3 }),
    makeEntry('reset', [], { summary: '重置当前分支头', popularity: 3 }),
    makeEntry('restore', [], { summary: '恢复工作区文件', popularity: 3 }),
    makeEntry('revert', [], { summary: '用新提交撤销提交', popularity: 3 }),
    ...extraEntries,
  ]);
}

/** fake 使用频率统计（usage 契约的内存版） */
export function fakeUsage(counts = new Map()) {
  return {
    count: (key) => counts.get(key) ?? 0,
    bump: (key) => counts.set(key, (counts.get(key) ?? 0) + 1),
    flush: () => {},
    reset: () => counts.clear(),
    all: () => Object.fromEntries(counts),
  };
}

/** fake ProviderHub（snapshot 契约的内存版） */
export function fakeProviders(snapshots = {}) {
  return {
    snapshot: (kind) =>
      snapshots[kind] ?? { status: 'disabled', items: [], updatedAt: null, error: null },
    ensure: () => {},
    invalidate: () => {},
    on: () => {},
    close: () => {},
  };
}

/** 便捷：构造就绪快照 */
export function ready(kind, values, popularityOf) {
  return {
    status: 'ready',
    updatedAt: 1,
    error: null,
    items: values.map((v, i) => ({
      value: v,
      label: v,
      summary: `${kind} 候选`,
      popularity: popularityOf ? popularityOf(v, i) : 3,
      kind,
    })),
  };
}
