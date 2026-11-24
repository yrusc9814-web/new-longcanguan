import { CapacitorSQLite } from '@capacitor-community/sqlite';
import { Capacitor } from '@capacitor/core';
import type {
  HouseholdInitRequest,
  HouseholdJoinRequest,
  HouseholdOwnerRecoverRequest,
} from '@dafan/shared/sync';
import { openCapacitorDatabase } from '../db/index.js';
import { recoverBackupFiles } from '../modules/backup/service.js';
import { createSettingsService } from '../modules/settings/service.js';
import { appSecurity, type NativeMemberRemovedNotice } from '../native/app-security.js';
import { androidCloudFetch } from '../native/cloud-fetch.js';
import { createPinSession } from '../native/pin-session.js';
import { createSyncEngine } from '../sync/engine.js';
import type { SyncStatusSnapshot } from '../sync/events.js';
import { installSyncCacheRefresh } from './sync-cache.js';
import {
  createMemberRevocationWipe,
  memberRemovedNoticeFromNative,
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

/**
 * 一次性被移出提示的落盘位置是原生私有目录（`no_backup/security/member-removed-notice.json`），
 * 不依赖会被清退清掉的 WebView `localStorage`。读取即删除，保证 UI 只出现一次。
 */
async function writeMemberRemovedNotice(notice: MemberRemovedNotice): Promise<void> {
  await appSecurity.setMemberRemovedNotice({
    householdId: notice.householdId,
    memberId: notice.memberId,
    wipedAt: notice.wipedAt,
  });
}

async function readMemberRemovedNotice(): Promise<MemberRemovedNotice | null> {
  const { notice } = await appSecurity.getMemberRemovedNotice();
  return memberRemovedNoticeFromNative(notice);
}

/** 清退/检查时的一次性提示消费入口；供 M4-1 UI 与联调宿主直接调用。 */
export async function consumeMemberRemovedNotice(): Promise<MemberRemovedNotice | null> {
  const { notice } = await appSecurity.consumeMemberRemovedNotice();
  return memberRemovedNoticeFromNative(notice);
}

/** 主线程清理在跑 WebView 的 localStorage/cookie/缓存；失败即保持清退锁定。 */
async function clearWebViewData(): Promise<boolean> {
  const { cleared } = await appSecurity.clearWebViewData();
  if (!cleared) return false;
  globalThis.localStorage?.clear();
  globalThis.sessionStorage?.clear();
  return true;
}

async function closeDatabase(): Promise<void> {
  // 先落闸：即使某个在途请求此刻才调 getDatabase()，也不会在删除后重新建库。
  wipeInProgress = true;
  const handle = await database?.catch(() => undefined);
  await handle?.close();
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
  clearWebViewData,
  readNotice: readMemberRemovedNotice,
  writeNotice: writeMemberRemovedNotice,
  resetDatabase,
});

/**
 * 同步代理确认可信撤权后的唯一清退入口。
 *
 * 先把 `lockedPendingWipe` 持久化并清 Keystore 令牌（原生随即拒绝 `/uploads/*` 与 `/api/v1/*`），
 * 再停同步器、关 SQLite、可靠删除 db/wal/shm、两个上传目录与安全备份目录，清理运行中 WebView 存储，
 * 写入原生一次性提示，最后解锁门禁并重建空库——线上被踢无需强杀进程即可继续使用单机版。
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
  // 清退成功后丢弃整个 JS 堆里的旧视图（旧库数据、旧图片缓存），让页面在新空库上重新启动。
  scheduleReloadAfterWipe();
}

/**
 * 在线清退成功后重载 WebView 文档。
 *
 * 物理数据已被删除、`localStorage` 与 cookie 已被原生清理，但页面内存里仍持有旧数据的副本。
 * 重载文档会以空库重新执行 bootstrap，用户无需强杀进程即可回到干净的单机界面。
 * 重载前留一点时间让一次性提示事件与状态广播先派发出去；提示本身已持久化在原生私有目录。
 */
function scheduleReloadAfterWipe(): void {
  if (!isAndroid) return;
  const host = globalThis as {
    location?: { reload?: () => void };
    setTimeout?: (fn: () => void, ms: number) => unknown;
  };
  try {
    host.setTimeout?.(() => {
      if (!host.location?.reload) return;
      // 清退完成事件或本地请求可能已打开新库。原生连接跨文档存活，重载前必须先关闭。
      void closeDatabase()
        .then(() => host.location?.reload())
        .catch(() => {
          // 连接关闭失败时保留当前文档，让它继续使用新库。
          wipeInProgress = false;
        });
    }, 100);
  } catch {
    // 忽略调度失败。
  }
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

/**
 * 受控家庭同步宿主。
 *
 * 只暴露业务动作与只读状态，不导出 member token、原始引擎实例或 http 客户端；M4-1 设置页与
 * 真机/模拟器单会话联调都通过它驱动绑定、同步与提示消费。
 */
export interface DafanHouseholdSyncHost {
  initOwner(
    body: Omit<HouseholdInitRequest, never>,
    options: { origin: string; confirmOverwriteLocal?: boolean },
  ): Promise<{ householdId: string; memberId: string; epoch: number }>;
  recoverOwner(
    body: HouseholdOwnerRecoverRequest,
    options: { origin: string; confirmOverwriteLocal?: boolean },
  ): Promise<{ householdId: string; memberId: string; epoch: number }>;
  join(
    body: HouseholdJoinRequest,
    options: { origin: string; confirmOverwriteLocal?: boolean },
  ): Promise<{ householdId: string; memberId: string; epoch: number }>;
  leave(): Promise<void>;
  pushNow(): Promise<void>;
  pullNow(): Promise<void>;
  status(): Promise<SyncStatusSnapshot>;
  consumeRemovedNotice(): Promise<MemberRemovedNotice | null>;
}

function bindingSummary(binding: { householdId: string; memberId: string; epoch: number }) {
  return {
    householdId: binding.householdId,
    memberId: binding.memberId,
    epoch: binding.epoch,
  };
}

export function createHouseholdSyncHost(
  engine: NonNullable<typeof householdSync>,
): DafanHouseholdSyncHost {
  return {
    async initOwner(body, options) {
      const result = await engine.initOwner(body, options);
      return bindingSummary(result.binding);
    },
    async recoverOwner(body, options) {
      const result = await engine.recoverOwner(body, options);
      return bindingSummary(result.binding);
    },
    async join(body, options) {
      const result = await engine.join(body, options);
      return bindingSummary(result.binding);
    },
    leave: () => engine.leave(),
    pushNow: () => engine.pushNow(),
    pullNow: () => engine.pullNow(),
    status: () => engine.status(),
    consumeRemovedNotice: () => consumeMemberRemovedNotice(),
  };
}

/**
 * 受控宿主接口挂载：`window.DafanHouseholdSync` 只含附件方法。
 *
 * 引擎未启用（Web 端）时不挂载，避免暴露空壳。
 */
export const householdSyncHost: DafanHouseholdSyncHost | undefined = householdSync
  ? createHouseholdSyncHost(householdSync)
  : undefined;

if (householdSyncHost && typeof window !== 'undefined') {
  (window as unknown as { DafanHouseholdSync?: DafanHouseholdSyncHost }).DafanHouseholdSync =
    householdSyncHost;
}

registerDomainRoutes(localApi, getDatabase, settings, householdSync);
if (isAndroid && typeof window !== 'undefined') installSyncCacheRefresh(window);
void initializeGate()
  .then(() => householdSync?.start())
  .catch(() => undefined);
globalThis.fetch = createLocalApiFetch({ router: localApi, nativeFetch });
export type { NativeMemberRemovedNotice };
