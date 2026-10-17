/**
 * 动态数据中枢：异步后台加载 + 同步快照 + TTL 缓存 + 结构性命令失效 + 非仓库降级。
 *
 * 关键语义：
 * - TTL：now() - updatedAt > cacheTtlMs 时，snapshot 返回旧数据且 status:'stale'，
 *   同时自动 ensure() 后台刷新；同步路径绝不阻塞、绝不同步 spawn。
 * - 加载中：首次 ensure 后未完成 → status:'loading'；完成 → 'ready' 并 emit('update', kind)。
 * - 非仓库：`git rev-parse --is-inside-work-tree` 非 true（含探测失败）→ 全部 kind
 *   disabled，不调用任何采集命令（提示文案由 UI 层依据 isRepo 展示）。
 *   runGit 传入 null → 一律 disabled（测试注入）。
 * - 结构性命令失效：见 STRUCTURAL_INVALIDATION 映射表；正在加载中的 kind 标记
 *   pending-invalidate，加载完成即丢弃结果并立即重载。
 * - snapshot 对"有仓库但尚无缓存"的 kind 采用"首次访问即后台加载"语义，
 *   本次调用返回 'loading'，不阻塞。
 */
import { EventEmitter } from 'node:events';
import { createGitQuery } from './gitQuery.mjs';
import { KINDS, KIND_QUERIES, buildCommitItems } from './kinds.mjs';

/**
 * 结构性命令（首个子命令 Token）→ 需失效的 kinds。
 * 值为 'all' 表示全部失效并重探仓库。
 */
export const STRUCTURAL_INVALIDATION = Object.freeze({
  branch: ['branch', 'commit'],
  tag: ['tag', 'commit'],
  remote: ['remote', 'commit'],
  stash: ['stash'],
  fetch: ['branch', 'tag', 'remote', 'commit'],
  pull: ['branch', 'tag', 'remote', 'commit'],
  push: ['branch', 'tag', 'remote', 'commit'],
  checkout: ['branch', 'commit', 'pathspec'],
  switch: ['branch', 'commit', 'pathspec'],
  reset: ['pathspec', 'commit'],
  restore: ['pathspec', 'commit'],
  clean: ['pathspec', 'commit'],
  add: ['pathspec'],
  mv: ['pathspec'],
  commit: ['branch', 'commit', 'pathspec', 'stash'],
  merge: ['commit', 'pathspec', 'stash'],
  rebase: ['commit', 'pathspec', 'stash'],
  revert: ['commit', 'pathspec', 'stash'],
  'cherry-pick': ['commit', 'pathspec', 'stash'],
  init: 'all',
  clone: 'all',
});

/**
 * @typedef {import('./kinds.mjs').DynItem} DynItem
 */

/**
 * @typedef {Object} KindSnapshot 单个 kind 的同步快照
 * @property {'ready'|'loading'|'stale'|'disabled'|'error'} status
 * @property {DynItem[]} items   （stale/error 时可能为旧数据；loading 首次为空）
 * @property {number|null} updatedAt 最近一次成功加载的时间戳（now() 口径）
 * @property {string|null} error  最近一次加载失败的说明
 */

/** ProviderHub：EventEmitter，'update' 事件以 kind 为参数广播缓存变化 */
class ProviderHub extends EventEmitter {}

/** 单个 kind 的内部缓存状态 */
function freshKindState() {
  return {
    /** @type {DynItem[]} */ items: [],
    /** @type {number|null} */ updatedAt: null,
    /** @type {string|null} */ error: null,
    loadInFlight: false,
    /** @type {Promise<void> | null} */ loadPromise: null,
    pendingInvalidate: false,
  };
}

/**
 * 创建动态数据中枢。
 * @param {{ cwd?: string, runGit?: ((args: string[]) => Promise<{ code:number, stdout:string, stderr:string }>) | null,
 *           cacheTtlMs?: number, now?: () => number }} [opts]
 *   cwd       git 执行目录（仅在未注入 runGit 时用于创建默认查询器）；
 *   runGit    git 执行器注入：函数 = 使用之（bin 装配层注入 createGitQuery().run）；
 *             显式 null = 全部 kind 一律 disabled（测试注入）；未传 = 默认真实 git 查询器；
 *   cacheTtlMs 缓存有效期，默认 30000；
 *   now       时钟注入（可测性）。
 * @returns {ProviderHub}
 */
export function createProviders({ cwd = process.cwd(), runGit, cacheTtlMs = 30_000, now = Date.now } = {}) {
  const useGit = runGit === undefined ? createGitQuery({ cwd }).run : runGit;
  const injectedDisabled = runGit === null;

  const hub = new ProviderHub();
  let closed = false;
  let repoCheckInFlight = false;
  const repo = { isRepo: null, branch: null, checkedAt: 0 };
  /** 仓库探测完成前排队的 kind（ensure 提前到达时） */
  const pendingEnsures = new Set();
  /** @type {Map<string, ReturnType<typeof freshKindState>>} */
  const states = new Map(KINDS.map((k) => [k, freshKindState()]));

  /** 缓存是否已过 TTL */
  const isStale = (st) => now() - st.updatedAt > cacheTtlMs;

  /** 缓存变化广播（close 后静默） */
  function emitUpdate(kind) {
    if (!closed) hub.emit('update', kind);
  }

  /**
   * 同步读取某个 kind 的快照（绝不阻塞、绝不同步 spawn）。
   * @param {string} kind
   * @returns {KindSnapshot}
   */
  function snapshot(kind) {
    const st = states.get(kind);
    if (!st) {
      return { status: 'disabled', items: [], updatedAt: null, error: `未知 kind: ${kind}` };
    }
    if (injectedDisabled || repo.isRepo === false) {
      return { status: 'disabled', items: [], updatedAt: null, error: null };
    }
    if (repo.isRepo === null) {
      // 仓库探测在途：视为加载中（探测完成后再实际加载）
      return { status: 'loading', items: [], updatedAt: null, error: null };
    }
    if (st.updatedAt !== null && isStale(st)) {
      // TTL 语义：返回旧数据 + stale，同时自动后台刷新（ensure 幂等，加载中为空操作）
      ensure(kind);
      return { status: 'stale', items: st.items, updatedAt: st.updatedAt, error: st.error };
    }
    if (st.loadInFlight) {
      // 加载中：首次为空列表；过期刷新期间附带旧数据
      return { status: 'loading', items: st.items, updatedAt: st.updatedAt, error: null };
    }
    if (st.updatedAt !== null) {
      return { status: 'ready', items: st.items, updatedAt: st.updatedAt, error: st.error };
    }
    if (st.error !== null) {
      // 上次加载失败且无缓存：如实返回错误，不在 snapshot 上自动重试（避免逐键重.spawn）
      return { status: 'error', items: st.items, updatedAt: null, error: st.error };
    }
    // 有仓库、无缓存、无在途加载（首次访问或已失效）：后台加载，本次返回 loading
    ensure(kind);
    return { status: 'loading', items: [], updatedAt: null, error: null };
  }

  /**
   * 无有效缓存则后台加载（幂等；并发去重；仓库探测在途时先排队）。
   * @param {string} kind
   * @returns {void}
   */
  function ensure(kind) {
    if (closed || injectedDisabled) return;
    if (!states.has(kind)) return;
    if (repo.isRepo === false) return;
    if (repo.isRepo === null) {
      pendingEnsures.add(kind);
      return;
    }
    const st = states.get(kind);
    if (st.loadInFlight) return; // 并发去重
    if (st.updatedAt !== null && !isStale(st)) return; // 缓存仍有效
    startLoad(kind);
  }

  /** 启动一次后台加载（commit 走派生路径） */
  function startLoad(kind) {
    const st = states.get(kind);
    st.loadInFlight = true;
    st.error = null;
    st.pendingInvalidate = false;
    st.loadPromise = kind === 'commit' ? loadDerivedCommit() : loadSimple(kind);
  }

  /**
   * 普通-kind 加载：依次执行 argsList 中的只读 git 命令并解析。
   * @param {string} kind
   */
  async function loadSimple(kind) {
    const def = KIND_QUERIES[kind];
    try {
      const outputs = [];
      for (const args of def.argsList) {
        const r = await useGit(args);
        if (r.code !== 0) {
          throw new Error(`git ${args.join(' ')} 退出码 ${r.code}: ${(r.stderr || '').trim()}`);
        }
        outputs.push(r.stdout);
      }
      finishLoad(kind, def.parse(outputs, { currentBranch: repo.branch }));
    } catch (err) {
      failLoad(kind, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * 派生 commit 加载：等待 branch 与 tag 各就绪一次，再组装（无独立 git 调用）。
   */
  async function loadDerivedCommit() {
    try {
      await ensureLoaded('branch');
      await ensureLoaded('tag');
      if (closed) return;
      const branchItems = states.get('branch').items;
      const tagItems = states.get('tag').items;
      finishLoad('commit', buildCommitItems(branchItems, tagItems));
    } catch (err) {
      failLoad('commit', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * 确保 kind 已就绪一次，返回其加载 Promise（供派生加载等待）。
   * @param {string} kind
   * @returns {Promise<void>}
   */
  function ensureLoaded(kind) {
    ensure(kind);
    const st = states.get(kind);
    if (st.loadInFlight && st.loadPromise) return st.loadPromise;
    return Promise.resolve(); // 已有缓存或暂不可加载：以现有快照继续（派生方自行兜底）
  }

  /**
   * 加载成功收尾：处理 pending-invalidate（丢弃结果并立即重载）、落缓存、发事件、
   * 联动刷新已派生的 commit。
   * @param {string} kind
   * @param {DynItem[]} items
   */
  function finishLoad(kind, items) {
    const st = states.get(kind);
    st.loadInFlight = false;
    st.loadPromise = null;
    if (closed) return;
    if (st.pendingInvalidate) {
      // 加载期间发生失效：结果已过期，丢弃并立即重载
      st.pendingInvalidate = false;
      startLoad(kind);
      return;
    }
    if (repo.isRepo === false) return; // 仓库已判非：丢弃结果
    st.items = items;
    st.updatedAt = now();
    st.error = null;
    emitUpdate(kind);
    if (kind === 'branch' || kind === 'tag') {
      // 派生联动：commit 若已组装过，用最新 branch/tag 快照同步重算（不新增 git 调用）
      const cs = states.get('commit');
      if (cs.updatedAt !== null && !cs.loadInFlight) {
        cs.items = buildCommitItems(states.get('branch').items, states.get('tag').items);
        cs.updatedAt = now();
        emitUpdate('commit');
      }
    }
  }

  /**
   * 加载失败收尾：保留旧数据（如有）、记录错误并广播；期间失效则重试一次。
   * @param {string} kind
   * @param {string} message
   */
  function failLoad(kind, message) {
    const st = states.get(kind);
    st.loadInFlight = false;
    st.loadPromise = null;
    if (closed) return;
    if (st.pendingInvalidate) {
      st.pendingInvalidate = false;
      startLoad(kind); // 失效优先：立即重试取新数据
      return;
    }
    st.error = message;
    emitUpdate(kind);
  }

  /**
   * 主动失效指定 kind 的缓存（'all' | Kind | Kind[]）。
   * 立即清空缓存（保证失效后绝不继续提供旧数据）；在途加载标记 pending-invalidate，
   * 完成即丢弃并重载；每种受影响 kind 各发一次 'update' 事件供 controller 重绘。
   * @param {'all' | string | string[]} target
   * @param {string} [reason] 失效原因（调试用）
   */
  function invalidate(target, reason) {
    void reason; // 预留：当前仅用于调试溯源，不参与行为
    const kinds = target === 'all' ? [...KINDS] : Array.isArray(target) ? target : [target];
    for (const kind of kinds) {
      const st = states.get(kind);
      if (!st) continue;
      st.items = [];
      st.updatedAt = null;
      st.error = null;
      if (st.loadInFlight) st.pendingInvalidate = true;
      emitUpdate(kind);
    }
  }

  /**
   * 结构性命令失效：取命令行首个子命令 Token 查表；
   * init/clone → 全部失效并重探仓库；未收录命令不做任何失效。
   * @param {string} command 用户执行完的整条命令行（如 'git branch foo'）
   */
  function invalidateAfterCommand(command) {
    const first = firstSubcommand(command);
    if (!first) return;
    const target = STRUCTURAL_INVALIDATION[first];
    if (target === undefined) return;
    if (target === 'all') {
      invalidate('all', `command:${first}`);
      recheckRepo();
      return;
    }
    invalidate(target, `command:${first}`);
  }

  /**
   * 从命令行提取首个子命令 Token（剥掉行首 'git'；按空白切分，忽略引号细节——
   * 子命令位置不会出现引号形态）。
   * @param {string} commandLine
   * @returns {string | null}
   */
  function firstSubcommand(commandLine) {
    if (typeof commandLine !== 'string') return null;
    const parts = commandLine.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;
    const start = parts[0] === 'git' ? 1 : 0;
    return parts[start] ?? null;
  }

  /**
   * 仓库信息快照读（同步，不触发探测）。
   * @returns {{ isRepo: boolean | null, branch: string | null, cwd: string, checkedAt: number }}
   */
  function repoInfo() {
    return { isRepo: repo.isRepo, branch: repo.branch, cwd, checkedAt: repo.checkedAt };
  }

  /**
   * 异步重探仓库（执行命令后由 controller 调用；在途时去重）。
   * 探测：`git rev-parse --is-inside-work-tree` 输出 true 且退出码 0 视为仓库内；
   * 分支名：`git symbolic-ref --short HEAD`（unborn HEAD——init 后未提交——也能取到
   * 分支名；分离 HEAD / 非 HEAD 引用 / 探测失败 → null）。
   * isRepo 或 branch 变化时发一次 'update' 事件（kind='repo'），供 controller 重读
   * repoInfo 并重绘标题区（否则首次 commit 后标题仍显示旧分支）。
   */
  function recheckRepo() {
    if (closed || injectedDisabled || repoCheckInFlight) return;
    repoCheckInFlight = true;
    void (async () => {
      let isRepo = false;
      let branch = null;
      const inside = await useGit(['rev-parse', '--is-inside-work-tree']);
      if (inside.code === 0 && inside.stdout.trim() === 'true') {
        isRepo = true;
        const head = await useGit(['symbolic-ref', '--short', 'HEAD']);
        if (head.code === 0) {
          const name = head.stdout.trim();
          branch = name || null;
        }
      }
      repoCheckInFlight = false;
      if (closed) return;
      const was = repo.isRepo;
      const wasBranch = repo.branch;
      // 仅"从已知状态发生变化"才广播（首次探测 was===null 不发——启动期刷新由各 kind
      // 加载完成的 update 事件顺带完成，避免多余重绘）；典型场景：首次 commit 后
      // unborn→具名分支、init/clone 后非仓库→仓库。
      const changed = was !== null && (isRepo !== was || branch !== wasBranch);
      repo.isRepo = isRepo;
      repo.branch = branch;
      repo.checkedAt = now();
      if (changed) emitUpdate('repo');
      if (isRepo) {
        // 启动探测期间排队的 kind
        const queued = [...pendingEnsures];
        pendingEnsures.clear();
        for (const k of queued) ensure(k);
        if (was === false) {
          // 非仓库 → 仓库（如 init/clone 后）：通知全部 kind 恢复可加载
          for (const k of KINDS) emitUpdate(k);
        }
      } else {
        // 非仓库：丢弃全部缓存并禁用
        pendingEnsures.clear();
        for (const k of KINDS) {
          const st = states.get(k);
          st.items = [];
          st.updatedAt = null;
          st.error = null;
          st.pendingInvalidate = false;
        }
        if (was !== false) {
          for (const k of KINDS) emitUpdate(k);
        }
      }
    })();
  }

  /** 关闭：停止后续加载与事件广播（在途加载完成时静默丢弃） */
  function close() {
    closed = true;
    pendingEnsures.clear();
  }

  // 启动即异步探测仓库
  if (!injectedDisabled) recheckRepo();

  return Object.assign(hub, {
    snapshot,
    ensure,
    invalidate,
    invalidateAfterCommand,
    repoInfo,
    recheckRepo,
    close,
  });
}
