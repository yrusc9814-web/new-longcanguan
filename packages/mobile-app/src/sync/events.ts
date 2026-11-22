/**
 * 同步层与 UI/壳层之间的唯一通信面：结构化状态 + 自定义 DOM 事件。
 *
 * 数据层不直接操作任何面板；宿注可注入 `dispatch`（Node 测试、原生壳），
 * 缺省在具备 DOM 时派发 CustomEvent，否则静默丢弃（状态仍可由 `status()` 读取）。
 */

export const SYNC_STATE_EVENT = 'dafan:sync:state';
export const PLAN_SLOT_CONFLICT_EVENT = 'dafan:sync:plan-slot-conflict';
export const INGREDIENT_CONFLICT_EVENT = 'dafan:sync:ingredient-conflict';
export const SYNC_CONFLICT_EVENT = 'dafan:sync:conflict';
export const EPOCH_RESET_EVENT = 'dafan:sync:epoch-reset';
export const SECURITY_WIPED_EVENT = 'dafan:security-wiped';

export type SyncPhase = 'idle' | 'ok' | 'syncing' | 'offline' | 'error' | 'revoked' | 'epoch-reset';

export interface SyncStatusSnapshot {
  readonly phase: SyncPhase;
  readonly bound: boolean;
  readonly householdId: string | null;
  readonly memberId: string | null;
  readonly role: 'OWNER' | 'MEMBER' | null;
  readonly epoch: number;
  readonly lastSeq: number;
  readonly pendingOperations: number;
  readonly lastError: string | null;
  readonly lastSyncedAt: string | null;
}

export type SyncEventName =
  | typeof SYNC_STATE_EVENT
  | typeof PLAN_SLOT_CONFLICT_EVENT
  | typeof INGREDIENT_CONFLICT_EVENT
  | typeof SYNC_CONFLICT_EVENT
  | typeof EPOCH_RESET_EVENT
  | typeof SECURITY_WIPED_EVENT;

export type SyncEventSink = (name: SyncEventName, detail: unknown) => void;

interface DomEventHost {
  readonly CustomEvent?: new (type: string, init?: { detail?: unknown }) => unknown;
  dispatchEvent?: (event: unknown) => boolean;
}

const defaultSink: SyncEventSink = (name, detail) => {
  const host = globalThis as unknown as DomEventHost;
  if (typeof host.dispatchEvent !== 'function' || typeof host.CustomEvent !== 'function') return;
  try {
    host.dispatchEvent(new host.CustomEvent(name, { detail }));
  } catch {
    // 事件仅用于展示/管理面板；派发失败不得影响同步数据面。
  }
};

/** 统一出口：注入的 sink 优先，否则用 DOM 事件。 */
export function createSyncEventSink(sink?: SyncEventSink): SyncEventSink {
  return sink ?? defaultSink;
}
