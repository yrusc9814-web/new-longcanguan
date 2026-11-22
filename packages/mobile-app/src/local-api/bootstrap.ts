import { CapacitorSQLite } from '@capacitor-community/sqlite';
import { Capacitor } from '@capacitor/core';
import { openCapacitorDatabase } from '../db/index.js';
import { recoverBackupFiles } from '../modules/backup/service.js';
import { createSettingsService } from '../modules/settings/service.js';
import { appSecurity } from '../native/app-security.js';
import { androidCloudFetch } from '../native/cloud-fetch.js';
import { createPinSession } from '../native/pin-session.js';
import { createSyncEngine } from '../sync/engine.js';
import { installSyncCacheRefresh } from './sync-cache.js';
import {
  MEMBER_REMOVED_NOTICE_KEY,
  createMemberRevocationWipe,
  type MemberRemovedNotice,
  type MemberRevocationWipe,
} from '../sync/wipe.js';
import { registerDomainRoutes } from './domains.js';
import { createLocalApiFetch, createLocalApiRouter } from './router.js';

const isAndroid = Capacitor.getPlatform() === 'android';
let database: ReturnType<typeof openCapacitorDatabase> | undefined;

/**
 * 清退进行中：期间任何 `getDatabase()` 都直接失败，避免把刚删的库重新建出来给在途请求用。
 */
class WipeInProgressError extends Error {
  constructor() {
    super('The local database is being wiped');
    this.name = 'WipeInProgressError';
  }
}

let wipeInProgress = false;

export function getDatabase() {
  if (wipeInProgress) throw new WipeInProgressError();
  database ??= openCapacitorDatabase({ plugin: CapacitorSQLite }).catch((error: unknown) => {
    database = undefined;
    throw error;
  });
  return database;
}

/** 丢弃连接句柄并解除清退闸门；下一次 `getDatabase()` 重建全新库。 */
function resetDatabase(): void {
  database = undefined;
  wipeInProgress = false;
}

export const pinSession = createPinSession(appSecurity);

const settings = createSettingsService(getDatabase, pinSession);

/** 同步代理注册的停用回调；清退时先停同步器/WS，再关库删盘。 */
let stopSyncRuntime: (() => void) | undefined;

function resolveStorage(kind: 'localStorage' | 'sessionStorage'): Storage | undefined {
  const storage = (globalThis as { localStorage?: Storage; sessionStorage?: Storage })[kind];
  return storage ?? undefined;
}

/**
 * 清空本地存储后只保留一次性的被移出提示。
 *
 * 只清理已有实例；不主动创建空 storage。`clear()` 抛错时向上传播，让清退保持锁定重试，
 * 而不是把“缓存已清”当作既成事实。
 */
function writeMemberRemovedNotice(notice: MemberRemovedNotice): void {
  resolveStorage('sessionStorage')?.clear();
  const local = resolveStorage('localStorage');
  if (local) {
    local.clear();
    local.setItem(MEMBER_REMOVED_NOTICE_KEY, JSON.stringify(notice));
  }
}

async function closeDatabase(): Promise<void> {
  // 先落闸：即使某个在途请求此刻才调 getDatabase()，也不会在删除后重新建库。
  wipeInProgress = true;
  const pending = database;
  resetDatabaseHandles();
  if (!pending) return;
  try {
    const handle = await pending;
    await handle.close();
  } catch {
    // 连接打不开或已关闭：句柄已丢弃，物理删除照常执行。
  }
}

/** 只丢句柄，不清 `wipeInProgress`。 */
function resetDatabaseHandles(): void {
  database = undefined;
}

export const memberRevocationWipe: MemberRevocationWipe = createMemberRevocationWipe({
  readGateState: () => appSecurity.getGateState(),
  applyGateState: (update) => appSecurity.setGateState(update),
  clearMemberToken: () => appSecurity.clearMemberToken(),
  stopBackground: () => {
    const stop = stopSyncRuntime;
    stopSyncRuntime = undefined;
    stop?.();
  },
  closeDatabase,
  purgeLocalData: () => appSecurity.purgeLocalData(),
  writeNotice: writeMemberRemovedNotice,
  resetDatabase,
});

/**
 * 同步代理确认可信撤权后的唯一清退入口。
 *
 * 先把 `lockedPendingWipe` 持久化并清 Keystore 令牌（原生随即拒绝 `/uploads/*` 与 `/api/v1/*`），
 * 再停同步器、关 SQLite、可靠删除 db/wal/shm 与两个上传目录，最后清存储只留提示标记。
 * 任一删除失败都会抛出并保持锁定；重复调用幂等，从头重跑。
 *
 * @param stopSync 同步代理注入的停用回调（停轮询、退避与 WS）
 * @param identity 触发撤权的身份，仅用于一次性提示标记
 */
export async function handleTrustedMemberRevocation(
  stopSync: () => void,
  identity?: { householdId?: string | null; memberId?: string | null },
): Promise<void> {
  stopSyncRuntime = stopSync;
  await memberRevocationWipe.wipe(identity);
}

let initialGate: Promise<void> | undefined;

function initializeGate() {
  initialGate ??= (async () => {
    // Android images stay locked until SQLite confirms the device's persisted PIN policy.
    if (isAndroid) await pinSession.lock(true);
    else await pinSession.lock();

    // 冷启动补完：先完成物理擦除并解锁，再建全新库；擦除失败保持锁定并抛出。
    if ((await appSecurity.getGateState()).lockedPendingWipe) {
      await memberRevocationWipe.recoverAtStartup();
    }

    if (isAndroid) {
      await recoverBackupFiles(await getDatabase());
      await settings.initialize();
    }
  })().catch((error: unknown) => {
    initialGate = undefined;
    throw error;
  });
  return initialGate;
}

export const localApi = createLocalApiRouter({
  async readGateState() {
    try {
      await initializeGate();
    } catch {
      // 补完失败时使用当前已持久化的门禁：锁定时路由仍返回 403，绝不放行。
    }
    const { lockedPendingWipe, pinRequired } = await appSecurity.getGateState();
    return { pendingWipe: lockedPendingWipe, pinRequired };
  },
  isPinTokenValid: pinSession.isValid,
  onMutation: () => {
    void householdSync?.wake();
  },
  async healthDatabaseProbe() {
    if (!isAndroid) return { status: 'error' };
    // 清退待办期间健康探测直接失败：不打开、不读取任何旧库。
    if ((await appSecurity.getGateState()).lockedPendingWipe) return { status: 'error' };
    const db = await getDatabase();
    const [result] = await db.query<{ ready: number }>('SELECT 1 AS ready');
    return { status: result?.ready === 1 ? 'ok' : 'error' };
  },
});

// Install the local fetch before the deferred Google2 adapter executes.
const nativeFetch = globalThis.fetch.bind(globalThis);
export const householdSync = isAndroid
  ? createSyncEngine({
      getDatabase,
      security: appSecurity,
      fetch: androidCloudFetch,
      onRevoked: (identity) => handleTrustedMemberRevocation(() => householdSync?.stop(), identity),
      timers: {
        setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
        clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
      },
    })
  : undefined;

registerDomainRoutes(localApi, getDatabase, settings, householdSync);
if (isAndroid && typeof window !== 'undefined') installSyncCacheRefresh(window);
void initializeGate()
  .then(() => householdSync?.start())
  .catch(() => undefined);
globalThis.fetch = createLocalApiFetch({ router: localApi, nativeFetch });
