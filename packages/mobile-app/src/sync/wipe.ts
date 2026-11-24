/**
 * 可信撤权后的本地自清退状态机（`LOCKED_PENDING_WIPE`）。
 *
 * 在线被踢后必须当场自愈，三件事同时成立才算清退完成：
 * 1. 持久门禁已写入 `lockedPendingWipe` 且 Keystore `memberToken` 已清；
 * 2. SQLite 连接已关闭，`dafanSQLite.db`/`-wal`/`-shm`、`uploads/`、`uploads-restore/`、
 *    `safety-backups/` 已确认不存在；
 * 3. 当前进程的 WebView 存储与缓存已清理，一次性被移出提示已写入原生私有目录。
 *
 * 全部成功后才把门禁解锁回 `{lockedPendingWipe:false, pinRequired:false, pinUnlocked:false}` 并重建空库，
 * 用户无需强杀进程即可继续使用干净的单机版。任一步失败都保持锁定并抛出，下一次调用（在线重试或冷启动补完）
 * 从头重跑；冷启动补完不得覆盖已经持久化的 `householdId`/`memberId`。
 */
import type { GateState, GateUpdate, LocalDataPurgeReport } from '../native/app-security.js';

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
  /** 清退后门禁已解锁并重建空库，可直接恢复单机读写。 */
  readonly unlocked: true;
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
  /** 主线程清理在跑 WebView 的 localStorage/cookie/缓存；返回 false 即视为擦除未完成。 */
  readonly clearWebViewData: () => Promise<boolean>;
  /** 读取已持久化的原生提示（冷启动补完用来保留真实身份）。 */
  readonly readNotice: () => Promise<MemberRemovedNotice | null>;
  /** 写入原生一次性提示；写入失败保持锁定。 */
  readonly writeNotice: (notice: MemberRemovedNotice) => Promise<void> | void;
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

const UNLOCKED_GATE: GateUpdate = {
  lockedPendingWipe: false,
  pinRequired: false,
  pinUnlocked: false,
};

function noticeFor(identity: RevocationIdentity | undefined, now: () => Date): MemberRemovedNotice {
  return {
    version: MEMBER_REMOVED_NOTICE_VERSION,
    householdId: identity?.householdId ?? null,
    memberId: identity?.memberId ?? null,
    wipedAt: now().toISOString(),
  };
}

function incompleteAfter(report: LocalDataPurgeReport, artifact: string): LocalDataPurgeReport {
  return {
    ...report,
    complete: false,
    failed: [...report.failed, artifact],
  };
}

/**
 * 校验原生桥返回的提示载荷；只接受当前版本且 `wipedAt` 非空的记录，其余视为无提示。
 */
export function memberRemovedNoticeFromNative(value: unknown): MemberRemovedNotice | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<MemberRemovedNotice>;
  if (candidate.version !== MEMBER_REMOVED_NOTICE_VERSION) return null;
  if (typeof candidate.wipedAt !== 'string' || candidate.wipedAt === '') return null;
  return {
    version: MEMBER_REMOVED_NOTICE_VERSION,
    householdId: typeof candidate.householdId === 'string' ? candidate.householdId : null,
    memberId: typeof candidate.memberId === 'string' ? candidate.memberId : null,
    wipedAt: candidate.wipedAt,
  };
}

export interface MemberRevocationSignal {
  readonly code: string;
  readonly householdId?: unknown;
  readonly memberId?: unknown;
  /** 相应类停靠 HTTP 403 与 WS 帧都接受，其它状态码必须为 false。 */
  readonly transport: 'http' | 'ws';
  readonly status?: number;
}

export interface RevocationContext {
  readonly householdId: string | null;
  readonly memberId: string | null;
  readonly bindingGeneration: number;
  /** 请求发起时刻获得的代际。 */
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

export interface MemberRevocationWipe {
  /**
   * 在线清退：上锁 → 清令牌 → 停同步 → 关库 → 双遍擦除 → 清 WebView → 写原生提示 → 解锁并重建空库。
   * 擦除或 WebView 清理失败时保持锁定并抛出，由调用方重试或冷启动补完。
   */
  wipe(identity?: RevocationIdentity): Promise<WipeOutcome>;
  /**
   * 启动/首次探测补完：仅当 `lockedPendingWipe === true` 时重跑整套清退并解锁。
   * 已有原生提示时保留其 `householdId`/`memberId`，绝不用空身份覆盖。
   */
  recoverAtStartup(): Promise<'skipped' | 'recovered'>;
  readonly isWiping: boolean;
}

export function createMemberRevocationWipe(deps: WipeDependencies): MemberRevocationWipe {
  const now = deps.now ?? (() => new Date());
  let inFlight: Promise<WipeOutcome> | undefined;

  async function execute(identity: RevocationIdentity | undefined): Promise<WipeOutcome> {
    // ① 持久化原生门禁并清 Keystore 令牌。二者都在任何删除之前，失败也不会有数据被删。
    await deps.applyGateState({ lockedPendingWipe: true, pinUnlocked: false });
    await deps.clearMemberToken();
    // ② 身份先落原生私有目录（不在擦除范围内）：清退中途被强杀后，冷启动补完仍能读出真实
    //    `householdId`/`memberId`。本次没带身份时沿用已持久化的那份，绝不用空值覆盖。
    const persisted = await deps.readNotice();
    const notice = noticeFor(identity, now);
    const identityKnown = identity?.householdId != null || identity?.memberId != null;
    const written = identityKnown || !persisted ? notice : persisted;
    await deps.writeNotice(written);
    // ③ 停用同步器/WS，再关闭 SQLite（close 排队在写锁之后，等在途事务结束）。
    await deps.stopBackground();
    await deps.closeDatabase();
    // ④ 原生物理删除并校验；跑两遍，让“门禁落地前已通过检查”的在途写入无法在下一轮复活。
    const first = await deps.purgeLocalData();
    if (!first.complete) throw new PendingWipeIncompleteError(first);
    const second = await deps.purgeLocalData();
    if (!second.complete) throw new PendingWipeIncompleteError(second);
    // ⑤ 清当前进程 WebView 的 localStorage/cookie/缓存；失败说明旧会话内容仍在，必须保持锁定。
    if (!(await deps.clearWebViewData())) {
      throw new PendingWipeIncompleteError(incompleteAfter(second, 'webview'));
    }
    // ⑥ 门禁解锁并丢弃旧库句柄：线上被踢当场恢复单机可用，下一次 `getDatabase()` 重建空库。
    await deps.applyGateState(UNLOCKED_GATE);
    deps.resetDatabase();
    return { status: 'wiped', report: second, notice: written, unlocked: true };
  }

  function run(identity?: RevocationIdentity): Promise<WipeOutcome> {
    inFlight ??= execute(identity).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  return {
    get isWiping() {
      return inFlight !== undefined;
    },
    wipe(identity) {
      return run(identity);
    },
    async recoverAtStartup() {
      const state = await deps.readGateState();
      if (!state.lockedPendingWipe) return 'skipped';
      await run();
      return 'recovered';
    },
  };
}
