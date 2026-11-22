/**
 * 可信撤权后的本地自清退状态机（`LOCKED_PENDING_WIPE`）。
 *
 * 三件事必须同时成立才算清退完成：
 * 1. 持久门禁已写入 `lockedPendingWipe` 且 Keystore `memberToken` 已清；
 * 2. SQLite 连接已关闭、`dafanSQLite.db`/`-wal`/`-shm`、`uploads/`、`uploads-restore/` 已确认不存在；
 * 3. 本地存储已清空，只留下一次性提示标记，同步器/WS 已停用。
 *
 * 任何一步失败都保持锁定并把错误抛给调用方，下一次调用从头重跑（全部步骤幂等）。
 * 只有冷启动补完流程会在擦除完整成功后解锁门禁并重建空库。
 */
import type { GateState, GateUpdate, LocalDataPurgeReport } from '../native/app-security.js';

/** 一次性提示标记的 key；UI 读取后应自行删除。 */
export const MEMBER_REMOVED_NOTICE_KEY = 'dafan.memberRemovedNotice';

export const MEMBER_REMOVED_NOTICE_VERSION = 1;

export interface MemberRemovedNotice {
  readonly version: number;
  readonly householdId: string | null;
  readonly memberId: string | null;
  readonly wipedAt: string;
}

export interface RevocationIdentity {
  readonly householdId?: string | null;
  readonly memberId?: string | null;
}

export interface WipeOutcome {
  readonly status: 'wiped';
  readonly report: LocalDataPurgeReport;
  readonly notice: MemberRemovedNotice;
}

export interface WipeDependencies {
  readonly readGateState: () => Promise<GateState>;
  readonly applyGateState: (update: GateUpdate) => Promise<unknown>;
  readonly clearMemberToken: () => Promise<void>;
  /** 停用同步器/WS；幂等。 */
  readonly stopBackground: () => Promise<void> | void;
  /** 关闭并丢弃当前 SQLite 连接；等待在途事务结束。 */
  readonly closeDatabase: () => Promise<void>;
  /** 原生物理删除固定私有目录；不接受调用方路径。 */
  readonly purgeLocalData: () => Promise<LocalDataPurgeReport>;
  /** 清空本地存储并写入一次性提示标记。 */
  readonly writeNotice: (notice: MemberRemovedNotice) => void;
  /** 丢弃数据库缓存，让下一次 `getDatabase()` 重建全新空库。 */
  readonly resetDatabase: () => void;
  readonly now?: () => Date;
}

/** 物理擦除不完整时抛出；调用方必须保持锁定并稍后重试。 */
export class PendingWipeIncompleteError extends Error {
  readonly report: LocalDataPurgeReport;

  constructor(report: LocalDataPurgeReport) {
    super(
      `Pending wipe did not remove every local artifact: ${report.failed.join(', ') || 'unknown'}`,
    );
    this.name = 'PendingWipeIncompleteError';
    this.report = report;
  }
}

function noticeFor(identity: RevocationIdentity | undefined, now: () => Date): MemberRemovedNotice {
  return {
    version: MEMBER_REMOVED_NOTICE_VERSION,
    householdId: identity?.householdId ?? null,
    memberId: identity?.memberId ?? null,
    wipedAt: now().toISOString(),
  };
}

export interface MemberRevocationWipe {
  /** 在线清退：上锁 + 擦除，成功后仍保持锁定，等待启动补完解锁。 */
  wipe(identity?: RevocationIdentity): Promise<WipeOutcome>;
  /**
   * 启动/首次探测补完：仅当 `lockedPendingWipe === true` 时重跑擦除，完整成功后解锁并重建空库。
   * 擦除失败保持锁定并抛出，绝不降级放行。
   */
  recoverAtStartup(): Promise<'skipped' | 'recovered'>;
  readonly isWiping: boolean;
}

export function createMemberRevocationWipe(deps: WipeDependencies): MemberRevocationWipe {
  const now = deps.now ?? (() => new Date());
  let inFlight: Promise<WipeOutcome> | undefined;

  async function execute(identity?: RevocationIdentity): Promise<WipeOutcome> {
    // ① 持久化原生门禁并清 Keystore 令牌。二者都在任何删除之前，失败也不会有数据被删。
    await deps.applyGateState({ lockedPendingWipe: true, pinUnlocked: false });
    await deps.clearMemberToken();
    // ② 停用同步器/WS，再关闭 SQLite（close 排队在写锁之后，等在途事务结束）。
    await deps.stopBackground();
    await deps.closeDatabase();
    // ③ 原生物理删除并校验；跑两遍，让“门禁落地前已通过检查”的在途写入无法在下一轮复活。
    const first = await deps.purgeLocalData();
    if (!first.complete) throw new PendingWipeIncompleteError(first);
    const second = await deps.purgeLocalData();
    if (!second.complete) throw new PendingWipeIncompleteError(second);
    // ④ 确认擦除后才清存储并落下一次性标记；此后门禁已锁，任何后续写入都会被原生拒绝。
    const notice = noticeFor(identity, now);
    deps.writeNotice(notice);
    return { status: 'wiped', report: second, notice };
  }

  return {
    get isWiping() {
      return inFlight !== undefined;
    },
    wipe(identity) {
      inFlight ??= execute(identity).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    async recoverAtStartup() {
      const state = await deps.readGateState();
      if (!state.lockedPendingWipe) return 'skipped';
      await this.wipe();
      // 擦除完整成功后才解锁；`pinRequired` 归零，交给新库的 PIN 配置重新决定。
      await deps.applyGateState({
        lockedPendingWipe: false,
        pinRequired: false,
        pinUnlocked: false,
      });
      deps.resetDatabase();
      return 'recovered';
    },
  };
}

/**
 * 唯一触发条件判定（供同步代理在收到 403/WS 帧时调用）。
 *
 * 只有来自当前绑定 `cloudOrigin` 的 `MEMBER_REVOKED`、`householdId`/`memberId` 均匹配当前
 * `device_local_config`、且请求发起时捕获的 `bindingGeneration` 仍是当前最新代际时才返回 true。
 * 本地 PIN 401、换机 401、`403 FORBIDDEN`、`429`、5xx/断网、旧代际迟到响应一律 false。
 */
export interface MemberRevocationSignal {
  readonly code: string;
  readonly householdId?: unknown;
  readonly memberId?: unknown;
  /** 响应类型：HTTP 403 与 WS 帧都允许，其它状态码必须为 false。 */
  readonly transport: 'http' | 'ws';
  readonly status?: number;
}

export interface RevocationContext {
  readonly householdId: string | null;
  readonly memberId: string | null;
  readonly bindingGeneration: number;
  /** 请求发起时捕获的代际。 */
  readonly requestGeneration: number;
}

export function isTrustedMemberRevocation(
  signal: MemberRevocationSignal,
  context: RevocationContext,
): boolean {
  if (signal.code !== 'MEMBER_REVOKED') return false;
  if (signal.transport === 'http' && signal.status !== 403) return false;
  if (!context.householdId || !context.memberId) return false;
  if (signal.householdId !== context.householdId) return false;
  if (signal.memberId !== context.memberId) return false;
  return context.requestGeneration === context.bindingGeneration;
}

/** 读取一次性提示标记；内容损坏时返回 null。 */
export function readMemberRemovedNotice(
  storage: Pick<Storage, 'getItem'> | null | undefined,
): MemberRemovedNotice | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(MEMBER_REMOVED_NOTICE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MemberRemovedNotice>;
    if (parsed.version !== MEMBER_REMOVED_NOTICE_VERSION) return null;
    if (typeof parsed.wipedAt !== 'string') return null;
    return {
      version: MEMBER_REMOVED_NOTICE_VERSION,
      householdId: typeof parsed.householdId === 'string' ? parsed.householdId : null,
      memberId: typeof parsed.memberId === 'string' ? parsed.memberId : null,
      wipedAt: parsed.wipedAt,
    };
  } catch {
    return null;
  }
}

/** UI 读取提示后调用，确保提示只出现一次。 */
export function consumeMemberRemovedNotice(
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null | undefined,
): MemberRemovedNotice | null {
  const notice = readMemberRemovedNotice(storage);
  if (notice) {
    try {
      storage?.removeItem(MEMBER_REMOVED_NOTICE_KEY);
    } catch {
      // 删除失败时下一次仍会读到同一条提示，不影响数据安全。
    }
  }
  return notice;
}
