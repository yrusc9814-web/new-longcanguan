import type { SyncStatusSnapshot } from '../sync/events.js';

type BentoWindow = Window & {
  BentoService?: Record<string, { reload?: () => Promise<unknown> }>;
  BentoBus?: { emit: (event: string) => void };
  BentoModal?: { modalStack?: readonly { name: string }[] };
};

const cacheNames = ['stores', 'recipes', 'pantry', 'shopping', 'plans', 'records', 'tools'];

/**
 * Use the existing cache loaders and refresh the home dashboard once cloud changes are applied.
 *
 * 表单弹窗（含 planPicker）打开期间必须同时推迟缓存重载与首页刷新：否则提交时读到
 * 后台同步写进来的新 `version`，会把他人并发修改静默覆盖。弹窗关闭后统一补一次刷新。
 */
export function installSyncCacheRefresh(win: BentoWindow): void {
  let appliedCursor: string | undefined;
  let refreshing = false;
  let queued = false;
  let deferredDashboard = false;
  function editing() {
    return win.BentoModal?.modalStack?.some(
      ({ name }) => name.endsWith('Form') || name === 'planPicker',
    );
  }
  function refreshDashboard() {
    if (editing()) {
      deferredDashboard = true;
      return;
    }
    deferredDashboard = false;
    win.BentoBus?.emit('dashboard:dirty');
  }
  const observer = new MutationObserver(() => {
    if (deferredDashboard && !editing()) {
      queued = true;
      void reload();
    }
  });
  observer.observe(win.document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });

  async function reload() {
    if (refreshing) return;
    refreshing = true;
    try {
      while (queued) {
        queued = false;
        // 编辑态：保留待刷标记，等弹窗关闭后由 observer 再触发。
        if (editing()) {
          deferredDashboard = true;
          break;
        }
        await Promise.allSettled(
          cacheNames.map(async (name) => win.BentoService?.[name]?.reload?.()),
        );
        refreshDashboard();
      }
    } finally {
      refreshing = false;
    }
  }
  win.addEventListener('dafan:sync:state', (event) => {
    const { phase, bound, epoch, lastSeq } = (event as CustomEvent<SyncStatusSnapshot>).detail;
    if (!bound || !['ok', 'epoch-reset'].includes(phase)) return;
    const cursor = `${epoch}:${lastSeq}`;
    // 游标只记录已真正应用到 UI 的那一次；编辑态推迟时不能提前消费掉。
    if (cursor === appliedCursor) return;
    if (editing()) {
      deferredDashboard = true;
      queued = true;
      return;
    }
    appliedCursor = cursor;
    queued = true;
    void reload();
  });
}
