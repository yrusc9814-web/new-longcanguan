/**
 * 首次绑定 `(epoch, S)` 分页快照与馆主首次初始化上传。
 *
 * 下载语义（AC2②）：第 1 页锁定锚点 `(epoch, S)`；全部页在内存中集齐并通过表名/行
 * 结构校验后，才在**单个本地事务**里整库替换 —— 中途断网或校验失败时旧库原样保留。
 * 替换完成后立刻从 `S` 增量补拉，保证下载期间他人的实时变更零遗漏。
 *
 * 上传语义（AC2①）：馆主带离线数据首绑空白云端时，按外键顺序分页 `init-upload`，
 * 最后一页 `finalize=true`（允许空页），成功后清空已同步的发件箱。
 */
import type { SyncRowChange, SyncSnapshotPage, SyncSnapshotUploadResult } from '@dafan/shared/sync';

import type { DatabaseClient } from '../db/database.js';
import { BUSINESS_TABLES } from '../db/schema.js';
import { SyncHttpError } from './http';
import type { SyncHttpClient } from './http';
import {
  createColumnCache,
  readAllRows,
  readSyncState,
  replaceAllRows,
  tableOrder,
  writeSyncState,
} from './ledger';
import { pullUntilIdle } from './pull';

const TABLE_SET = new Set<string>(BUSINESS_TABLES);

export interface SnapshotOptions {
  readonly database: DatabaseClient;
  readonly http: SyncHttpClient;
  readonly epoch: number;
  readonly pageSize?: number;
  /** 单页最大行数保护：超过即视为服务端失约。 */
  readonly maxPages?: number;
  /** 请求头 x-household-epoch 覆盖（切代际后本地 sync_state 尚未更新时使用）。 */
  readonly headerEpoch?: number;
}

function parsePage(raw: unknown): SyncSnapshotPage {
  if (!raw || typeof raw !== 'object') throw new SyncHttpError(502, 'BAD_RESPONSE', '快照响应无效');
  const page = raw as Partial<SyncSnapshotPage>;
  if (!Array.isArray(page.rows)) throw new SyncHttpError(502, 'BAD_RESPONSE', '快照响应缺少 rows');
  const seq = Number(page.seq);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new SyncHttpError(502, 'BAD_RESPONSE', '快照响应 seq 无效');
  }
  return {
    epoch: Number(page.epoch),
    seq,
    rows: page.rows,
    nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null,
    isEmpty: page.isEmpty === true,
  };
}

function validateRows(rows: readonly SyncRowChange[]): void {
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      throw new SyncHttpError(502, 'BAD_RESPONSE', '快照行结构无效');
    }
    const table = String(row.table);
    if (!TABLE_SET.has(table)) {
      throw new SyncHttpError(502, 'BAD_RESPONSE', `快照包含未知表：${table}`);
    }
    if (row.id === null || row.id === undefined) {
      throw new SyncHttpError(502, 'BAD_RESPONSE', `快照行缺少主键：${table}`);
    }
    if (row.row !== null && (typeof row.row !== 'object' || Array.isArray(row.row))) {
      throw new SyncHttpError(502, 'BAD_RESPONSE', `快照行载荷无效：${table}`);
    }
  }
}

export interface SnapshotDownloadResult {
  readonly epoch: number;
  readonly seq: number;
  readonly rows: number;
  /** 快照后补拉的增量行数。 */
  readonly caughtUpRows: number;
}

/** 下载全量快照并原子替换本地业务表，随后从锚点补拉。 */
export async function downloadSnapshot(options: SnapshotOptions): Promise<SnapshotDownloadResult> {
  const pageSize = options.pageSize ?? 500;
  const maxPages = options.maxPages ?? 2000;
  const all: SyncRowChange[] = [];
  let cursor: string | null = null;
  let epoch = options.epoch;
  let seq = 0;

  for (let pageNo = 0; ; pageNo += 1) {
    if (pageNo >= maxPages) {
      throw new SyncHttpError(500, 'SNAPSHOT_TOO_LARGE', '快照分页超过上限');
    }
    const query =
      cursor === null
        ? `/api/sync/snapshot?limit=${pageSize}`
        : `/api/sync/snapshot?limit=${pageSize}&cursor=${encodeURIComponent(cursor)}`;
    const page = parsePage(await options.http.request(query, { epoch: options.headerEpoch }));
    validateRows(page.rows);
    if (pageNo === 0) {
      epoch = page.epoch;
      seq = page.seq;
    } else if (page.epoch !== epoch) {
      // 锚点漂移（期间他人恢复过家庭）：放弃本次下载，由调用方重试。
      throw new SyncHttpError(409, 'EPOCH_MISMATCH', '快照下载期间账本代际已切换', {
        code: 'EPOCH_MISMATCH',
        currentEpoch: page.epoch,
      });
    }
    all.push(...page.rows);
    if (page.nextCursor === null || page.rows.length === 0) break;
    cursor = page.nextCursor;
  }

  const cache = createColumnCache();
  await replaceAllRows(
    options.database,
    cache,
    BUSINESS_TABLES.map((table) => ({
      table,
      rows: all
        .filter((row) => String(row.table) === table && row.row !== null)
        .map((row) => row.row!),
    })),
    { epoch, seq },
    { clearOutbox: true },
  );

  const caughtUp = await pullUntilIdle({
    database: options.database,
    http: options.http,
    epoch,
    cache,
  });

  return { epoch, seq, rows: all.length, caughtUpRows: caughtUp.applied };
}

/** 馆主首次初始化的分页上传：外键顺序、按行数切页、末页 finalize。 */
export interface InitUploadOptions {
  readonly database: DatabaseClient;
  readonly http: SyncHttpClient;
  /** 本机当前 epoch（新库通常为 0；云端会忽略并用自身代际回复）。 */
  readonly epoch: number;
  readonly uploadId?: string;
  readonly pageSize?: number;
  /** x-household-epoch：本机尚未切到新代际时传云端代际（init 后即 binding.epoch）。 */
  readonly headerEpoch?: number;
}

export interface InitUploadResult {
  readonly epoch: number;
  readonly seq: number;
  readonly rows: number;
}

/** 上传前记录发件箱水位：只清掉"已上云"的那部分，上传期间新产生的操作保留。 */
async function outboxWatermark(database: DatabaseClient): Promise<number> {
  const [row] = await database.query<{ mark: number | null }>(
    `SELECT MAX(rowid) AS mark FROM "sync_outbox"`,
  );
  return row?.mark ?? 0;
}

export async function uploadInitialSnapshot(options: InitUploadOptions): Promise<InitUploadResult> {
  const pageSize = options.pageSize ?? 500;
  const uploadId = options.uploadId ?? crypto.randomUUID();
  const ordered = await tableOrder(options.database);
  const watermark = await outboxWatermark(options.database);
  const local = new Map(
    (await readAllRows(options.database)).map((entry) => [entry.table, entry.rows]),
  );

  const pages: SyncRowChange[][] = [];
  let current: SyncRowChange[] = [];
  for (const table of ordered) {
    for (const row of local.get(table) ?? []) {
      current.push({ table: table as never, id: row.id as never, row: row as never });
      if (current.length >= pageSize) {
        pages.push(current);
        current = [];
      }
    }
  }
  pages.push(current); // 允许空页：空库也要发一次 finalize。

  let result: SyncSnapshotUploadResult | null = null;
  for (let index = 0; index < pages.length; index += 1) {
    const finalize = index === pages.length - 1;
    const raw = (await options.http.request('/api/sync/init-upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      epoch: options.headerEpoch ?? options.epoch,
      body: JSON.stringify({
        uploadId,
        page: index,
        rows: pages[index],
        finalize,
      }),
    })) as SyncSnapshotUploadResult;
    const epoch = Number(raw?.epoch);
    const seq = Number(raw?.seq);
    if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(seq)) {
      throw new SyncHttpError(502, 'BAD_RESPONSE', 'init-upload 响应无效');
    }
    result = { epoch, seq, complete: raw.complete === true };
    if (finalize && raw.complete !== true) {
      throw new SyncHttpError(502, 'BAD_RESPONSE', 'init-upload 未确认完成');
    }
  }

  const epoch = result?.epoch ?? options.epoch;
  const seq = result?.seq ?? 0;
  await options.database.withWriteTransaction(async (tx) => {
    // 只删到上传开始时的水位；上传期间新产生的本地操作必须保留待推。
    await tx.run(`DELETE FROM "sync_outbox" WHERE rowid <= ?`, [watermark]);
    await writeSyncState(tx, epoch, seq);
  });
  return { epoch, seq, rows: pages.reduce((sum, page) => sum + page.length, 0) };
}

/**
 * 绑定前快照应用：成员首次全量下载（保留本机 PIN / 上传文件目录不动）。
 *
 * 与 `downloadSnapshot` 的差异仅是语义命名：调用方必须先通过空库检测或显式确认。
 */
export async function applyInitialSnapshot(
  options: SnapshotOptions,
): Promise<SnapshotDownloadResult> {
  const state = await readSyncState(options.database);
  return downloadSnapshot({ ...options, epoch: options.epoch || state.epoch });
}
