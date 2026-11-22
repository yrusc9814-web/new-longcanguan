import type { SyncStatusSnapshot } from '../sync/events.js';

type BentoWindow = Window & {
  BentoService?: Record<string, { reload?: () => Promise<unknown> }>;
  BentoBus?: { emit: (event: string) => void };
  BentoModal?: { modalStack?: readonly { name: string }[] };
};

const cacheNames = ['stores', 'recipes', 'pantry', 'shopping', 'plans', 'records', 'tools'];

/** Use the existing cache loaders and refresh the home dashboard once cloud changes are applied. */
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
    if (deferredDashboard && !editing()) refreshDashboard();
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
    if (cursor === appliedCursor) return;
    appliedCursor = cursor;
    queued = true;
    void reload();
  });
}
