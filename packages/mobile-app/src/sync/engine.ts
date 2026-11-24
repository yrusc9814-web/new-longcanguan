/**
 * 同步引擎：绑定 API + 自动调度（前台/网络/WS 唤醒、退避重试、广播）+ 冲突收敛。
 *
 * 全部依赖注入，因此可以在 Node/真实 SQLite 中完整测试，不依赖 Capacitor。
 * 引擎不碰 UI：状态与冲突通过 `events` 与 `status()` 暴露。
 */
import type {
  HouseholdBinding,
  HouseholdInitRequest,
  HouseholdJoinRequest,
  HouseholdOwnerRecoverRequest,
  SyncRowChange,
} from '@dafan/shared/sync';

import type { DatabaseClient, WriteTransaction } from '../db/database.js';
import { SYNC_INIT_TABLE } from '../db/schema.js';
import type { AppSecurityBridge } from '../native/app-security.js';
import { uploadFiles, type UploadsFilesBridge } from '../native/upload-files.js';
import {
  createSyncEventSink,
  EPOCH_RESET_EVENT,
  INGREDIENT_CONFLICT_EVENT,
  PLAN_SLOT_CONFLICT_EVENT,
  SECURITY_WIPED_EVENT,
  SYNC_CONFLICT_EVENT,
  SYNC_STATE_EVENT,
  type SyncEventSink,
  type SyncStatusSnapshot,
} from './events.js';
import {
  clearBinding,
  isLedgerEmpty,
  outboxCount,
  readBinding,
  readSyncState,
  writeBinding,
  type LocalBinding,
} from './ledger.js';
import {
  createSyncHttpClient,
  EpochMismatchError,
  RateLimitedError,
  SyncHttpClient,
  SyncHttpError,
  SyncNetworkError,
  TrustedRevocationError,
  type RevocationEvidence,
  type SyncFetch,
  type SyncHttpContext,
} from './http.js';
import { createImageSyncQueue, type ImageAssetRef, type ImageSyncQueue } from './images.js';
import { alignConflictedEntities, convergePushConflicts, pullUntilIdle } from './pull.js';
import { pushOutbox, type PushConflict } from './push.js';
import { restoreOwnerCloudBackup } from './restore.js';
import type { BackupConsumers } from '../modules/backup/service.js';
import {
  createSafetyBackup,
  createSafetyBackupStore,
  type SafetyBackupStore,
} from './safety-backup.js';
import {
  downloadSnapshot,
  readInitialUpload,
  stageInitialUpload,
  uploadInitialSnapshot,
  type StagedInitialUpload,
} from './snapshot.js';
import { createSyncSocket, type SocketFactory, type SyncSocket, type Timers } from './ws.js';
import type { UploadAssetRow } from '../modules/uploads/service.js';

export class RequiresBackupConfirmationError extends Error {
  readonly code = 'REQUIRES_LOCAL_BACKUP_CONFIRMATION';
  constructor() {
    super('本地已有数据；请先导出备份或显式确认后再覆盖');
    this.name = 'RequiresBackupConfirmationError';
  }
}

export class NotBoundError extends Error {
  constructor() {
    super('设备尚未绑定家庭');
    this.name = 'NotBoundError';
  }
}

export interface CreateSyncEngineOptions {
  readonly getDatabase: () => Promise<DatabaseClient>;
  readonly security: Pick<
    AppSecurityBridge,
    'getMemberToken' | 'setMemberToken' | 'clearMemberToken'
  >;
  /** 绑定前也需要知道云端源；缺省从本机绑定行读取。 */
  readonly origin?: () => string | null | Promise<string | null>;
  readonly fetch?: SyncFetch;
  readonly files?: UploadsFilesBridge;
  readonly events?: SyncEventSink;
  readonly now?: () => Date;
  readonly timers?: Timers;
  /** 稳定的客户端 ID；缺省持久化到 localStorage（可用时）。 */
  readonly deviceId?: () => string | Promise<string>;
  readonly snapshotPageSize?: number;
  readonly pushBatchSize?: number;
  /** 可信撤权时由外层（安全清退代理）执行；引擎自身只负责停同步、发事件。 */
  readonly onRevoked?: (evidence: RevocationEvidence) => void | Promise<void>;
  /** 本地安全备份持久化，默认用原生独立目录。 */
  readonly safetyBackupStore?: SafetyBackupStore;
  readonly imageQueue?: ImageSyncQueue;
  /** 测试/原生壳注入自定义 WebSocket 实现。 */
  readonly socketFactory?: SocketFactory;
}

export interface BindOptions {
  readonly origin: string;
  /** 绑定前本地非空时是否允许覆盖（必须已导出备份或用户显式确认）。 */
  readonly confirmOverwriteLocal?: boolean;
}

export interface BindResult {
  readonly binding: LocalBinding & { epoch: number };
  readonly initialized: boolean;
}

const DEVICE_ID_KEY = 'dafan:sync:device-id';

function readStorage(key: string): string | null {
  const storage = (globalThis as { localStorage?: Storage }).localStorage;
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  const storage = (globalThis as { localStorage?: Storage }).localStorage;
  try {
    storage?.setItem(key, value);
  } catch {
    // 隐私模式/配额失败时退化为进程内 ID。
  }
}

export class SyncEngine {
  private readonly events: SyncEventSink;
  readonly http: SyncHttpClient;
  readonly images: ImageSyncQueue;
  private socket: SyncSocket | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private stopped = true;
  private phase: SyncStatusSnapshot['phase'] = 'idle';
  private lastError: string | null = null;
  private lastSyncedAt: string | null = null;
  private pendingOrigin: string | null = null;
  private connectionId: string | null = null;
  private deviceIdCache: string | null = null;
  private listenerCleanup: (() => void)[] = [];

  constructor(private readonly options: CreateSyncEngineOptions) {
    this.events = createSyncEventSink(options.events);
    const files = options.files ?? uploadFiles;
    this.http = createSyncHttpClient({
      fetch: options.fetch,
      context: () => this.context(),
      origin: async () => this.origin(),
      onRevoked: (evidence) => this.handleRevocation(evidence),
    });
    this.images =
      options.imageQueue ??
      createImageSyncQueue({
        http: this.http,
        files,
        onError: (error) => this.log(error),
      });
  }

  // ---------------------------------------------------------------- 绑定 API

  private async origin(): Promise<string | null> {
    if (this.pendingOrigin) return this.pendingOrigin;
    const database = await this.options.getDatabase();
    return (await readBinding(database))?.cloudOrigin ?? null;
  }

  private async context(): Promise<SyncHttpContext | null> {
    const database = await this.options.getDatabase();
    const binding = await readBinding(database);
    if (!binding) return null;
    const { epoch } = await readSyncState(database);
    const { memberToken } = await this.options.security.getMemberToken();
    if (!memberToken) return null;
    return {
      cloudOrigin: binding.cloudOrigin,
      householdId: binding.householdId,
      memberId: binding.memberId,
      role: binding.role,
      generation: binding.generation,
      epoch,
      token: memberToken,
    };
  }

  private async deviceId(): Promise<string> {
    if (this.options.deviceId) return this.options.deviceId();
    if (this.deviceIdCache) return this.deviceIdCache;
    const stored = readStorage(DEVICE_ID_KEY);
    const id = stored ?? crypto.randomUUID();
    if (!stored) writeStorage(DEVICE_ID_KEY, id);
    this.deviceIdCache = id;
    return id;
  }

  /** 绑定/加入/恢复成功后统一落库：写绑定、存 token、切代际。 */
  private async persistBinding(
    origin: string,
    binding: HouseholdBinding,
    prepare?: (tx: WriteTransaction) => Promise<void>,
  ): Promise<LocalBinding> {
    const database = await this.options.getDatabase();
    await this.options.security.setMemberToken({ memberToken: binding.token });
    const generation = await writeBinding(
      database,
      {
        cloudOrigin: new URL(origin).origin,
        householdId: binding.householdId,
        memberId: binding.memberId,
        role: binding.role,
      },
      () => this.options.now?.() ?? new Date(),
      prepare,
    );
    return {
      cloudOrigin: new URL(origin).origin,
      householdId: binding.householdId,
      memberId: binding.memberId,
      role: binding.role,
      generation,
    };
  }

  /** 馆主首次初始化：空白云端 + 本地离线数据 → 分页上传并清空发件箱。 */
  async initOwner(
    body: Omit<HouseholdInitRequest, never>,
    options: BindOptions,
  ): Promise<BindResult> {
    const database = await this.options.getDatabase();
    if (await readBinding(database))
      throw new SyncHttpError(409, 'ALREADY_BOUND', '设备已绑定家庭');
    this.pendingOrigin = new URL(options.origin).origin;
    try {
      const binding = (await this.http.request('/api/household/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        anonymous: true,
      })) as HouseholdBinding;
      const local = await this.persistBinding(this.pendingOrigin, binding, async (tx) => {
        await stageInitialUpload(tx, binding.epoch, this.options.snapshotPageSize);
      });
      await this.syncOnce();
      const state = await readSyncState(database);
      return {
        binding: { ...local, epoch: binding.epoch },
        initialized: state.epoch === binding.epoch && !(await readInitialUpload(database)),
      };
    } finally {
      this.pendingOrigin = null;
    }
  }

  /** 馆主换机恢复：沿用旧成员，token 轮换。 */
  async recoverOwner(
    body: HouseholdOwnerRecoverRequest,
    options: BindOptions,
  ): Promise<BindResult> {
    const database = await this.options.getDatabase();
    if (await readBinding(database))
      throw new SyncHttpError(409, 'ALREADY_BOUND', '设备已绑定家庭');
    if (!(await isLedgerEmpty(database)) && options.confirmOverwriteLocal !== true) {
      throw new RequiresBackupConfirmationError();
    }
    this.pendingOrigin = new URL(options.origin).origin;
    try {
      const binding = (await this.http.request('/api/household/owner/recover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        anonymous: true,
      })) as HouseholdBinding;
      const local = await this.persistBinding(this.pendingOrigin, binding);
      const count = await outboxCount(database);
      if (count > 0) await this.backupBeforeEpochSwitch(0, binding.epoch);
      const snapshot = await downloadSnapshot({
        database,
        http: this.http,
        epoch: binding.epoch,
        headerEpoch: binding.epoch,
        pageSize: this.options.snapshotPageSize,
        onApplied: (changes) => this.queueImageDownloads(changes),
      });
      await this.enqueueLedgerImages(database);
      this.startImageDownloads();
      await this.emitState('ok');
      return { binding: { ...local, epoch: snapshot.epoch }, initialized: false };
    } finally {
      this.pendingOrigin = null;
      void this.wake();
    }
  }

  /**
   * 成员加入：先判空库（非空必须确认），再全量快照 + 增量补拉。
   *
   * 注意顺序：确认发生在写绑定之前，因此阻断时本机绑定与令牌都不会被改动。
   */
  async join(body: HouseholdJoinRequest, options: BindOptions): Promise<BindResult> {
    const database = await this.options.getDatabase();
    if (await readBinding(database))
      throw new SyncHttpError(409, 'ALREADY_BOUND', '设备已绑定家庭');
    if (!(await isLedgerEmpty(database)) && options.confirmOverwriteLocal !== true) {
      throw new RequiresBackupConfirmationError();
    }
    this.pendingOrigin = new URL(options.origin).origin;
    try {
      const binding = (await this.http.request('/api/household/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        anonymous: true,
      })) as HouseholdBinding;
      const local = await this.persistBinding(this.pendingOrigin, binding);
      const downloaded = await downloadSnapshot({
        database,
        http: this.http,
        epoch: binding.epoch,
        headerEpoch: binding.epoch,
        pageSize: this.options.snapshotPageSize,
        onApplied: (changes) => this.queueImageDownloads(changes),
      });
      await this.enqueueLedgerImages(database);
      this.startImageDownloads();
      await this.emitState('ok');
      return {
        binding: { ...local, epoch: downloaded.epoch },
        initialized: false,
      };
    } finally {
      this.pendingOrigin = null;
      void this.wake();
    }
  }

  /** 解绑（保留本地业务数据，仅清云端身份与令牌）。 */
  async leave(): Promise<void> {
    this.stop();
    const database = await this.options.getDatabase();
    await this.running;
    await clearBinding(database, () => this.options.now?.() ?? new Date());
    await database.withWriteTransaction(async (tx) => {
      await tx.run(`DELETE FROM "${SYNC_INIT_TABLE}"`);
    });
    await this.options.security.clearMemberToken();
    this.lastError = null;
    this.phase = 'idle';
    await this.emitState('idle');
  }

  async restoreOwnerBackup(database: DatabaseClient, request: Request, consumers: BackupConsumers) {
    const resume = this.active;
    this.stop();
    try {
      await this.running;
      if (await readInitialUpload(database)) {
        throw new SyncHttpError(409, 'INITIAL_UPLOAD_PENDING', '请先完成首次账本上传');
      }
      const result = await restoreOwnerCloudBackup({
        database,
        http: this.http,
        files: this.options.files ?? uploadFiles,
        consumers,
        request,
        pageSize: this.options.snapshotPageSize,
      });
      this.lastError = null;
      await this.emitState('epoch-reset');
      this.events(EPOCH_RESET_EVENT, {
        epoch: result.epoch,
        seq: result.seq,
        source: 'owner-restore',
      });
      return { restoredTables: result.tables, restoredFiles: result.images };
    } finally {
      if (resume && this.phase !== 'revoked') this.start();
    }
  }

  // ---------------------------------------------------------------- 调度

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attachWakeSources();
    void this.wake();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.stop();
    this.socket = null;
    this.connectionId = null;
    for (const cleanup of this.listenerCleanup.splice(0)) cleanup();
  }

  get active(): boolean {
    return !this.stopped;
  }

  /** 前台恢复/网络恢复/WS 广播统一入口；运行中则排队补跑一次。 */
  async wake(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.runLoop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runLoop(): Promise<void> {
    do {
      this.rerun = false;
      try {
        await this.runOnce();
      } catch (error) {
        await this.handleSyncError(error);
      }
    } while (this.rerun && !this.stopped);
  }

  /**
   * 单次 push → pull；绑定与套接字按当前代际按需建立。
   * 内部收敛错误（网络/限流/撤权/代际）后正常返回，便于手动"立即同步"与测试。
   */
  async syncOnce(): Promise<void> {
    if (!this.stopped) {
      await this.wake();
      return;
    }
    this.running ??= this.runLoop().finally(() => {
      this.running = null;
    });
    await this.running;
  }

  private async runOnce(): Promise<void> {
    const database = await this.options.getDatabase();
    let context = await this.context();
    if (!context) {
      await this.emitState('idle');
      return;
    }
    await this.emitState('syncing');
    const staged = await readInitialUpload(database);
    if (staged) {
      await this.resumeInitialUpload(database, staged);
      context = { ...context, epoch: staged.epoch };
    }

    if (!this.stopped) await this.ensureSocket();
    for (;;) {
      const pushed = await this.pushBatch(database, context.epoch);
      if (!pushed.conflicts.length) {
        if (pushed.unresolved) throw new SyncNetworkError('云端尚未确认部分操作');
        break;
      }
      await this.convergeConflicts(database, context.epoch, pushed.conflicts);
    }
    await pullUntilIdle(
      {
        database,
        http: this.http,
        epoch: context.epoch,
        onApplied: (changes) => this.queueImageDownloads(changes),
      },
      50,
    );
    await this.drainImageDownloads();
    this.lastError = null;
    this.lastSyncedAt = (this.options.now?.() ?? new Date()).toISOString();
    await this.emitState('ok');
  }

  private async pushBatch(database: DatabaseClient, epoch: number) {
    return pushOutbox({
      database,
      http: this.http,
      clientId: await this.deviceId(),
      epoch,
      connectionId: this.connectionId,
      batchSize: this.options.pushBatchSize,
      beforePush: async (operations) => {
        const assets = operations.flatMap((operation) => {
          if (operation.kind !== 'upsert' || operation.entity !== 'UploadAsset') return [];
          const { sha256, storagePath, thumbnailPath } = operation.payload;
          if (typeof sha256 !== 'string' || typeof storagePath !== 'string') return [];
          return [
            {
              sha256,
              storagePath,
              thumbnailPath: typeof thumbnailPath === 'string' ? thumbnailPath : null,
            },
          ];
        });
        await this.uploadImages(assets, epoch);
      },
    });
  }

  private async ensureSocket(): Promise<void> {
    if (this.socket?.connected) return;
    if (!this.socket) {
      this.socket = createSyncSocket({
        http: this.http,
        url: (ctx, ticket) => {
          const url = new URL('/api/sync/ws', ctx.cloudOrigin);
          url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
          url.searchParams.set('ticket', ticket);
          return url.href;
        },
        timers: this.options.timers,
        socketFactory: this.options.socketFactory,
        onConnected: (connectionId) => {
          this.connectionId = connectionId;
        },
        onDisconnected: () => {
          this.connectionId = null;
        },
        onAvailable: () => void this.wake(),
        onEpochReset: (epoch) => {
          if (this.active) void this.wake();
          else void this.handleEpochReset(epoch);
        },
        onError: (error) => this.log(error),
      });
    }
    await this.socket.connect();
  }

  /** 冲突收敛：整链回滚本地副作用 → 应用云端权威聚合 → 强制拉权威行 → 发结构化事件。 */
  private async convergeConflicts(
    database: DatabaseClient,
    epoch: number,
    conflicts: readonly PushConflict[],
  ): Promise<void> {
    if (conflicts.length === 0) return;
    const outcomes = await convergePushConflicts(database, conflicts);
    for (const conflict of conflicts) {
      const outcome = outcomes.get(conflict.opId);
      if (conflict.code === 'PLAN_SLOT_CONFLICT') {
        this.events(PLAN_SLOT_CONFLICT_EVENT, {
          planId: conflict.entityId,
          winner: conflict.winner,
          claimedPlan: conflict.payload,
          removed: outcome?.planRemoved ?? false,
        });
      } else if (conflict.code === 'INSUFFICIENT_STOCK' || conflict.code === 'VERSION_CONFLICT') {
        if (conflict.entity === 'Ingredient') {
          this.events(INGREDIENT_CONFLICT_EVENT, {
            ingredientId: conflict.ingredientId ?? conflict.entityId,
            code: conflict.code,
            serverVersion: conflict.serverVersion,
          });
        }
      }
      this.events(SYNC_CONFLICT_EVENT, {
        operationId: conflict.opId,
        entity: conflict.entity,
        entityId: conflict.entityId,
        code: conflict.code,
        serverVersion: conflict.serverVersion,
        ingredientId: conflict.ingredientId,
        authoritative: outcome?.authoritative ?? false,
      });
    }
    // 权威集合已随回滚事务写入；旧版服务端没有权威集合时退回增量强制对齐。
    const unresolved = conflicts.filter((conflict) => !outcomes.get(conflict.opId)?.authoritative);
    if (unresolved.length > 0) {
      await alignConflictedEntities({ database, http: this.http, epoch }, unresolved);
    }
  }

  // ---------------------------------------------------------------- 代际切换

  /**
   * 代际切换入口：WS `EPOCH_RESET` 与 HTTP `409 EPOCH_MISMATCH` 共用。
   * 旧代际存在待同步数据时先生成并持久化本地安全备份，再整库切换到新快照。
   */
  async handleEpochReset(serverEpoch: number): Promise<void> {
    const database = await this.options.getDatabase();
    const { epoch } = await readSyncState(database);
    if (serverEpoch === epoch || (await readInitialUpload(database))) return;
    try {
      const latestSafetyBackup = await this.backupBeforeEpochSwitch(epoch, serverEpoch);
      const result = await downloadSnapshot({
        database,
        http: this.http,
        epoch: serverEpoch,
        headerEpoch: serverEpoch,
        pageSize: this.options.snapshotPageSize,
        onApplied: (changes) => this.queueImageDownloads(changes),
      });
      await this.enqueueLedgerImages(database);
      this.phase = 'epoch-reset';
      this.events(EPOCH_RESET_EVENT, { epoch: serverEpoch, seq: result.seq, latestSafetyBackup });
      this.startImageDownloads();
      await this.emitState('epoch-reset');
      this.wake();
    } catch (error) {
      await this.handleSyncError(error);
    }
  }

  /**
   * 旧 epoch 有待同步数据时，必须先落一份本地安全备份再丢弃发件箱。
   * AC2④ 的"先备份后切代际"由此保证。
   */
  private async backupBeforeEpochSwitch(
    fromEpoch: number,
    toEpoch: number,
  ): Promise<string | null> {
    const database = await this.options.getDatabase();
    if ((await outboxCount(database)) === 0) return null;
    const uploads = this.options.files ?? uploadFiles;
    const backup = await createSafetyBackup({
      database,
      fromEpoch,
      toEpoch,
      now: this.options.now,
      uploads,
    });
    const store = this.options.safetyBackupStore ?? createSafetyBackupStore(uploads);
    await store.write(backup);
    await database.withWriteTransaction(async (tx) => {
      await tx.run('UPDATE "sync_state" SET "latestSafetyBackup" = ? WHERE "id" = 1', [
        backup.name,
      ]);
    });
    return backup.name;
  }

  // ---------------------------------------------------------------- 错误与事件

  private async handleSyncError(error: unknown): Promise<void> {
    if (error instanceof EpochMismatchError) {
      await this.handleEpochReset(error.currentEpoch);
      return;
    }
    if (error instanceof TrustedRevocationError) {
      this.stop();
      this.phase = 'revoked';
      this.lastError = 'MEMBER_REVOKED';
      await this.emitState('revoked');
      return;
    }
    if (error instanceof RateLimitedError) {
      this.phase = 'error';
      this.lastError = 'RATE_LIMITED';
      await this.emitState('error');
      this.scheduleRetry(error.retryAfterMs);
      return;
    }
    if (error instanceof SyncNetworkError) {
      this.phase = 'offline';
      this.lastError = error.message;
      await this.emitState('offline');
      this.scheduleRetry(5_000);
      return;
    }
    this.phase = 'error';
    this.lastError = error instanceof Error ? error.message : String(error);
    await this.emitState('error');
    this.log(error);
  }

  private retryTimer: unknown = null;

  private scheduleRetry(delayMs: number): void {
    if (this.stopped) return;
    const timers = this.options.timers;
    if (!timers) return;
    if (this.retryTimer !== null) timers.clearTimeout(this.retryTimer);
    this.retryTimer = timers.setTimeout(() => {
      this.retryTimer = null;
      void this.wake();
    }, delayMs);
  }

  private async handleRevocation(evidence: RevocationEvidence): Promise<void> {
    const wipe = this.options.onRevoked?.(evidence);
    this.stop();
    this.phase = 'revoked';
    this.lastError = 'MEMBER_REVOKED';
    await wipe;
    await this.emitState('revoked');
    if (this.options.onRevoked) this.events(SECURITY_WIPED_EVENT, evidence);
  }

  private log(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  private async emitState(phase: SyncStatusSnapshot['phase']): Promise<void> {
    this.phase = phase;
    let snapshot: SyncStatusSnapshot;
    try {
      snapshot = await this.status();
    } catch {
      // 数据库不可用（清退中）时仍要发出状态，让 UI 能显示同步已停。
      snapshot = {
        phase,
        bound: false,
        householdId: null,
        memberId: null,
        role: null,
        epoch: 0,
        lastSeq: 0,
        pendingOperations: 0,
        latestSafetyBackup: null,
        lastError: this.lastError,
        lastSyncedAt: this.lastSyncedAt,
      };
    }
    this.events(SYNC_STATE_EVENT, snapshot);
  }

  async status(): Promise<SyncStatusSnapshot> {
    const database = await this.options.getDatabase();
    const binding = await readBinding(database);
    const state = await readSyncState(database);
    const pending = await outboxCount(database, state.epoch);
    const [backup] = await database.query<{ latestSafetyBackup: string | null }>(
      'SELECT "latestSafetyBackup" FROM "sync_state" WHERE "id" = 1',
    );
    return {
      phase: this.phase,
      bound: binding != null,
      householdId: binding?.householdId ?? null,
      memberId: binding?.memberId ?? null,
      role: binding?.role ?? null,
      epoch: state.epoch,
      lastSeq: state.lastSeq,
      pendingOperations: pending,
      latestSafetyBackup: backup?.latestSafetyBackup ?? null,
      lastError: this.lastError,
      lastSyncedAt: this.lastSyncedAt,
    };
  }

  /** 手动推送（设置页"立即同步"）。 */
  async pushNow(): Promise<void> {
    await this.wake();
  }

  /** 手动拉取。 */
  async pullNow(): Promise<void> {
    const database = await this.options.getDatabase();
    const context = await this.context();
    if (!context) throw new NotBoundError();
    await pullUntilIdle({
      database,
      http: this.http,
      epoch: context.epoch,
      onApplied: (changes) => this.queueImageDownloads(changes),
    });
    await this.drainImageDownloads();
  }

  // ---------------------------------------------------------------- 图片

  private queueImageDownloads(changes: readonly SyncRowChange[]): void {
    for (const change of changes) {
      if (change.table !== 'UploadAsset' || change.row === null) continue;
      const row = change.row as unknown as UploadAssetRow;
      if (row.deletedAt) continue;
      if (typeof row.sha256 !== 'string' || typeof row.storagePath !== 'string') continue;
      this.images.enqueueDownload({
        sha256: row.sha256,
        storagePath: row.storagePath,
        thumbnailPath: typeof row.thumbnailPath === 'string' ? row.thumbnailPath : null,
      });
    }
  }

  private async resumeInitialUpload(
    database: DatabaseClient,
    staged: StagedInitialUpload,
  ): Promise<void> {
    await this.uploadImages(staged.assets, staged.epoch);
    await uploadInitialSnapshot({ database, http: this.http, epoch: staged.epoch, staged });
  }

  private async uploadImages(assets: readonly ImageAssetRef[], epoch: number): Promise<void> {
    const queue = createImageSyncQueue({
      http: this.http,
      files: this.options.files ?? uploadFiles,
      epoch,
    });
    for (const asset of assets) queue.enqueueUpload(asset);
    while (queue.pending > 0) {
      const result = await queue.drain();
      if (result.failed)
        throw result.error ?? new SyncHttpError(502, 'IMAGE_UPLOAD_FAILED', '图片上传失败');
    }
  }

  private startImageDownloads(): void {
    void this.drainImageDownloads().catch((error) => this.handleSyncError(error));
  }

  private async drainImageDownloads(): Promise<void> {
    do {
      const result = await this.images.drain();
      if (
        result.error instanceof EpochMismatchError ||
        result.error instanceof TrustedRevocationError
      ) {
        throw result.error;
      }
    } while (this.images.pending > 0);
  }

  private async enqueueLedgerImages(database: DatabaseClient): Promise<void> {
    const rows = await database.query<UploadAssetRow>(
      `SELECT "sha256","storagePath","thumbnailPath" FROM "UploadAsset" WHERE "deletedAt" IS NULL`,
    );
    for (const row of rows) {
      if (typeof row.sha256 !== 'string' || typeof row.storagePath !== 'string') continue;
      this.images.enqueueDownload({
        sha256: row.sha256,
        storagePath: row.storagePath,
        thumbnailPath: typeof row.thumbnailPath === 'string' ? row.thumbnailPath : null,
      });
    }
  }

  // ---------------------------------------------------------------- 唤醒源

  private attachWakeSources(): void {
    const target = globalThis as {
      addEventListener?: (type: string, listener: () => void) => void;
      removeEventListener?: (type: string, listener: () => void) => void;
      document?: { addEventListener?: (type: string, listener: () => void) => void };
    };
    const wake = () => void this.wake();
    if (typeof target.addEventListener === 'function') {
      target.addEventListener('online', wake);
      this.listenerCleanup.push(() => target.removeEventListener?.('online', wake));
    }
    const document = target.document;
    if (document && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', wake);
      this.listenerCleanup.push(() => {
        (
          document as { removeEventListener?: (type: string, l: () => void) => void }
        ).removeEventListener?.('visibilitychange', wake);
      });
    }
  }
}

export function createSyncEngine(options: CreateSyncEngineOptions): SyncEngine {
  return new SyncEngine(options);
}
