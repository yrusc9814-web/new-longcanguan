import { Capacitor, registerPlugin } from '@capacitor/core';

export interface GateState {
  lockedPendingWipe: boolean;
  pinRequired: boolean;
  pinUnlocked: boolean;
}

export type GateUpdate = Partial<GateState> & { pinExpiresAt?: number };

/**
 * 原生物理擦除结果。
 *
 * `complete` 是唯一判定依据：数据库三件套、两个上传目录族与独立安全备份目录都已确认不存在才算完成。
 * 各布尔字段表示“已确认不存在”，因此目标本来就不存在时也为 true。原生侧只处理固定私有目录，不接受路径参数。
 */
export interface LocalDataPurgeReport {
  readonly complete: boolean;
  readonly databaseRemoved: boolean;
  readonly uploadsRemoved: boolean;
  readonly restoreRemoved: boolean;
  readonly safetyBackupsRemoved: boolean;
  readonly failed: readonly string[];
}

/** 原生持久化的一次性被移出提示（与 `sync/wipe.ts` 的 `MemberRemovedNotice` 同形）。 */
export interface NativeMemberRemovedNotice {
  readonly version: number;
  readonly householdId: string | null;
  readonly memberId: string | null;
  readonly wipedAt: string;
}

export interface AppSecurityBridge {
  getGateState(): Promise<GateState>;
  setGateState(update: GateUpdate): Promise<GateState>;
  getMemberToken(): Promise<{ memberToken: string | null }>;
  setMemberToken(options: { memberToken: string }): Promise<void>;
  clearMemberToken(): Promise<void>;
  /**
   * 删除固定私有目录中的本地业务数据：`dafanSQLite.db`/`-wal`/`-shm`、`FilesDir/uploads/`、
   * `FilesDir/uploads-restore/`、`FilesDir/safety-backups/`。未持久化 `lockedPendingWipe` 时原生拒绝执行。
   */
  purgeLocalData(): Promise<LocalDataPurgeReport>;
  /** 读取原生私有目录里的一次性被移出提示；没有时返回 null。 */
  getMemberRemovedNotice(): Promise<{ notice: NativeMemberRemovedNotice | null }>;
  /** 读取并删除，保证同一条提示只出现一次。 */
  consumeMemberRemovedNotice(): Promise<{ notice: NativeMemberRemovedNotice | null }>;
  /** 在物理擦除成功后写入原生提示；身份字段写入后不再被冷启动补完覆盖。 */
  setMemberRemovedNotice(options: {
    householdId: string | null;
    memberId: string | null;
    wipedAt: string;
  }): Promise<void>;
  /** 主线程清理在跑 WebView 的 localStorage/cookie/缓存；返回是否成功完成。 */
  clearWebViewData(): Promise<{ cleared: boolean }>;
}

export function createMemoryAppSecurity(now = Date.now): AppSecurityBridge {
  let state: GateState = { lockedPendingWipe: false, pinRequired: false, pinUnlocked: false };
  let memberToken: string | null = null;
  let pinExpiresAt = 0;
  let notice: NativeMemberRemovedNotice | null = null;

  function readState() {
    if (pinExpiresAt > 0 && pinExpiresAt <= now()) state.pinUnlocked = false;
    return { ...state };
  }

  return {
    async getGateState() {
      return readState();
    },
    async setGateState(update) {
      if (
        update.lockedPendingWipe === true ||
        (update.lockedPendingWipe === false && state.lockedPendingWipe)
      ) {
        memberToken = null;
      }
      state = {
        lockedPendingWipe: update.lockedPendingWipe ?? state.lockedPendingWipe,
        pinRequired: update.pinRequired ?? state.pinRequired,
        pinUnlocked: update.pinUnlocked ?? state.pinUnlocked,
      };
      if (state.lockedPendingWipe || !state.pinRequired) state.pinUnlocked = false;
      pinExpiresAt = state.pinUnlocked ? (update.pinExpiresAt ?? pinExpiresAt) : 0;
      return readState();
    },
    async getMemberToken() {
      return { memberToken: state.lockedPendingWipe ? null : memberToken };
    },
    async setMemberToken(options) {
      if (state.lockedPendingWipe) throw new Error('The device is pending wipe');
      if (typeof options.memberToken !== 'string' || options.memberToken.trim() === '') {
        throw new Error('memberToken is required');
      }
      memberToken = options.memberToken;
    },
    async clearMemberToken() {
      memberToken = null;
    },
    async purgeLocalData() {
      // Web/test 实现不持有原生文件；请求仍必须先上锁，与原生契约保持一致。
      if (!state.lockedPendingWipe) throw new Error('The device is not pending wipe');
      return {
        complete: true,
        databaseRemoved: true,
        uploadsRemoved: true,
        restoreRemoved: true,
        safetyBackupsRemoved: true,
        failed: [],
      };
    },
    async getMemberRemovedNotice() {
      return { notice: notice ? { ...notice } : null };
    },
    async consumeMemberRemovedNotice() {
      const current = notice;
      notice = null;
      return { notice: current ? { ...current } : null };
    },
    async setMemberRemovedNotice(options) {
      notice = {
        version: 1,
        householdId: options.householdId ?? null,
        memberId: options.memberId ?? null,
        wipedAt: options.wipedAt,
      };
    },
    async clearWebViewData() {
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.clear();
        } catch {
          return { cleared: false };
        }
      }
      if (typeof sessionStorage !== 'undefined') {
        try {
          sessionStorage.clear();
        } catch {
          return { cleared: false };
        }
      }
      return { cleared: true };
    },
  };
}

export const appSecurity =
  Capacitor.getPlatform() === 'android'
    ? registerPlugin<AppSecurityBridge>('AppSecurity')
    : createMemoryAppSecurity();
