import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../src/db/database.js';
import { SYNC_OUTBOX_TABLE } from '../src/db/schema.js';
import {
  consumeIngredient,
  createIngredient,
  updateIngredient,
  type ConsumeInput,
  type IngredientServiceContext,
} from '../src/modules/ingredients/service.js';
import type { IngredientWriteInput } from '../src/modules/ingredients/input.js';
import type {
  IngredientBatchRefPayload,
  IngredientConsumeCommandPayload,
  IngredientUpdateCommandPayload,
  IngredientUpsertPayload,
} from '@dafan/shared/sync';
import { createNodeSqliteDriver } from './helpers/node-sqlite-driver.js';

const NOW = new Date('2026-11-21T08:00:00.000Z');
const TABLES = ['Ingredient', 'InventoryBatch', 'InventoryLog'] as const;

interface OutboxRecord {
  readonly kind: string;
  readonly commandType: string | null;
  readonly baseVersion: number | null;
  readonly payloadJson: string | null;
  readonly payloadHash: string | null;
}

interface Harness {
  readonly db: DatabaseHandle;
  readonly ctx: IngredientServiceContext;
}

async function openHarness(newId?: () => string): Promise<Harness> {
  const db = await openDatabase({
    driver: createNodeSqliteDriver({ path: ':memory:' }),
    now: () => NOW,
  });
  return { db, ctx: { database: db, now: () => NOW, ...(newId ? { newId } : {}) } };
}

async function outbox(db: DatabaseHandle): Promise<OutboxRecord[]> {
  return db.query<OutboxRecord>(
    `SELECT "kind","commandType","baseVersion","payloadJson","payloadHash"
     FROM "${SYNC_OUTBOX_TABLE}" ORDER BY rowid`,
  );
}

async function snapshot(db: DatabaseHandle): Promise<Record<string, unknown[]>> {
  const entries = await Promise.all(
    TABLES.map(
      async (table) => [table, await db.query(`SELECT * FROM "${table}" ORDER BY rowid`)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

/** 端侧随机生成的真实 ID 固定为重放输入：按实际写入顺序耗尽即报错。 */
function fixedIds(ids: readonly string[]): () => string {
  let cursor = 0;
  return () => {
    const id = ids[cursor];
    cursor += 1;
    if (!id) throw new Error(`确定性 ID 序列已耗尽（已取 ${cursor - 1} 个）`);
    return id;
  };
}

function pairs(refs: readonly IngredientBatchRefPayload[]): string[] {
  return refs.flatMap((ref) => [ref.batchId, ref.logId]);
}

/** create 写入顺序：食材 id → 每个 PURCHASE 日志的 batchId + logId。 */
function createReplayIds(payload: IngredientUpsertPayload): string[] {
  const ids = [payload.id];
  for (const log of payload.inventoryLogs) {
    if (!log.inventoryBatchId) throw new Error(`PURCHASE 日志 ${log.id} 缺少批次外键`);
    ids.push(log.inventoryBatchId, log.id);
  }
  return ids;
}

/** update 写入顺序：replace 新批次 → implicit 补建 → 差额新增 → 差额扣减日志。 */
function updateReplayIds(payload: IngredientUpdateCommandPayload): string[] {
  const ids: string[] = [];
  if (payload.replacedBatches) ids.push(...pairs(payload.replacedBatches));
  if (payload.implicitBatch) ids.push(...pairs([payload.implicitBatch]));
  if (payload.addedBatch) ids.push(...pairs([payload.addedBatch]));
  for (const deduction of payload.deductions ?? []) ids.push(deduction.logId);
  return ids;
}

/** consume 写入顺序：implicit 补建 → 每个扣减日志。 */
function consumeReplayIds(payload: IngredientConsumeCommandPayload): string[] {
  const ids: string[] = [];
  if (payload.implicitBatch) ids.push(...pairs([payload.implicitBatch]));
  for (const deduction of payload.deductions) ids.push(deduction.logId);
  return ids;
}

function replayIdsOf(row: OutboxRecord): string[] {
  if (!row.payloadJson) return [];
  if (row.kind === 'upsert') {
    return createReplayIds(JSON.parse(row.payloadJson) as IngredientUpsertPayload);
  }
  if (row.commandType === 'INGREDIENT_CONSUME') {
    return consumeReplayIds(JSON.parse(row.payloadJson) as IngredientConsumeCommandPayload);
  }
  return updateReplayIds(JSON.parse(row.payloadJson) as IngredientUpdateCommandPayload);
}

function hashOf(payloadJson: string): string {
  return createHash('sha256').update(payloadJson).digest('hex');
}

async function expectSameFacts(
  primary: Harness,
  replayed: Harness,
  expectedRows: readonly OutboxRecord[],
): Promise<void> {
  expect(await snapshot(replayed.db)).toEqual(await snapshot(primary.db));
  const replayedRows = await outbox(replayed.db);
  expect(replayedRows.map((row) => [row.kind, row.commandType, row.baseVersion])).toEqual(
    expectedRows.map((row) => [row.kind, row.commandType, row.baseVersion]),
  );
  expect(replayedRows.map((row) => row.payloadJson)).toEqual(
    expectedRows.map((row) => row.payloadJson),
  );
  expect(replayedRows.map((row) => row.payloadHash)).toEqual(
    expectedRows.map((row) => row.payloadHash),
  );
  for (const row of replayedRows) {
    expect(row.payloadHash).toBe(hashOf(row.payloadJson as string));
  }
}

async function batchIds(db: DatabaseHandle, ingredientId: string): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    'SELECT "id" FROM "InventoryBatch" WHERE "ingredientId" = ? AND "deletedAt" IS NULL ORDER BY rowid',
    [ingredientId],
  );
  return rows.map((row) => row.id);
}

async function logIds(db: DatabaseHandle, ingredientId: string): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    'SELECT "id" FROM "InventoryLog" WHERE "ingredientId" = ? ORDER BY rowid',
    [ingredientId],
  );
  return rows.map((row) => row.id);
}

describe('食材同步载荷：固定落库 ID + 业务时间 + hash', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await openHarness();
  });

  it('create：upsert 携带完整 PURCHASE 事实，按载荷 ID 重放得到逐行相同的库', async () => {
    const { db, ctx } = harness;
    const request: IngredientWriteInput = {
      name: '确定面粉',
      unit: 'GRAM',
      category: '粮油',
      minStock: 100,
      batches: [
        { quantity: 1, unit: 'KILOGRAM', expiryDate: '2026-12-01', consumePriority: true },
        { quantity: 500, unit: 'GRAM', expiryDate: '2026-12-05', opened: true },
      ],
    };
    const created = await createIngredient(ctx, request);

    const [row] = await outbox(db);
    expect(row).toMatchObject({ kind: 'upsert', commandType: null, baseVersion: null });
    expect(row!.payloadHash).toBe(hashOf(row!.payloadJson as string));
    const payload = JSON.parse(row!.payloadJson as string) as IngredientUpsertPayload;
    expect(payload.id).toBe(created.id);
    expect(payload.version).toBe(1);
    expect(payload.createdAt).toBe(created.createdAt);
    expect(payload.updatedAt).toBe(created.updatedAt);
    expect(payload.batches.map((batch) => batch.id)).toEqual(
      created.batches.map((batch) => batch.id),
    );

    const logs = await db.query<Record<string, unknown>>(
      'SELECT * FROM "InventoryLog" WHERE "ingredientId" = ? ORDER BY rowid',
      [created.id],
    );
    expect(payload.inventoryLogs).toHaveLength(2);
    for (const [index, log] of logs.entries()) {
      expect(payload.inventoryLogs[index]).toEqual({
        id: log.id,
        ingredientId: log.ingredientId,
        ingredientNameSnapshot: log.ingredientNameSnapshot,
        inventoryBatchId: log.inventoryBatchId,
        beforeQuantity: log.beforeQuantity,
        changeQuantity: log.changeQuantity,
        afterQuantity: log.afterQuantity,
        unit: log.unit,
        changeType: log.changeType,
        relatedPlanId: log.relatedPlanId,
        relatedRecordId: log.relatedRecordId,
        notes: log.notes,
        createdAt: log.createdAt,
        updatedAt: log.updatedAt,
      });
      expect(log.changeType).toBe('PURCHASE');
      expect(log.beforeQuantity).toBe(0);
      expect(payload.batches.some((batch) => batch.id === log.inventoryBatchId)).toBe(true);
      expect(log.createdAt).toBe(NOW.toISOString());
      expect(log.updatedAt).toBe(NOW.toISOString());
    }

    const replayed = await openHarness(fixedIds(createReplayIds(payload)));
    const replayedDto = await createIngredient(replayed.ctx, request);
    expect(replayedDto.id).toBe(payload.id);
    await expectSameFacts({ db, ctx }, replayed, [row!]);
  });

  it('replace：replacedBatches 按请求顺序固定批次/日志 ID，重放可复现', async () => {
    const { db, ctx } = harness;
    const created = await createIngredient(ctx, {
      name: '替换批次面粉',
      unit: 'KILOGRAM',
      batches: [{ quantity: 1, unit: 'KILOGRAM' }],
    });
    const request: IngredientWriteInput = {
      name: '替换批次面粉',
      unit: 'KILOGRAM',
      batches: [
        { quantity: 250, unit: 'GRAM', opened: true },
        { quantity: 2, unit: 'KILOGRAM' },
      ],
    };
    await updateIngredient(ctx, created.id, 1, request);

    const rows = await outbox(db);
    const commandRow = rows[1]!;
    expect(commandRow).toMatchObject({
      kind: 'command',
      commandType: 'INGREDIENT_UPDATE_SYNC_BATCHES',
      baseVersion: 1,
    });
    const payload = JSON.parse(commandRow.payloadJson as string) as IngredientUpdateCommandPayload;
    expect(payload.executedAt).toBe(NOW.toISOString());
    expect(payload.replacedBatches).toHaveLength(2);
    expect(payload.replacedBatches!.map((ref) => ref.batchId)).toEqual(
      await batchIds(db, created.id),
    );
    const allLogIds = await logIds(db, created.id);
    expect(payload.replacedBatches!.map((ref) => ref.logId)).toEqual(allLogIds.slice(1));
    expect(payload).not.toHaveProperty('addedBatch');
    expect(payload).not.toHaveProperty('implicitBatch');

    // 重放：先按 upsert 载荷 ID 重建原食材，再按命令载荷 ID 重放替换。
    const ids = [...replayIdsOf(rows[0]!), ...updateReplayIds(payload)];
    const replayed = await openHarness(fixedIds(ids));
    await createIngredient(replayed.ctx, {
      name: '替换批次面粉',
      unit: 'KILOGRAM',
      batches: [{ quantity: 1, unit: 'KILOGRAM' }],
    });
    await updateIngredient(replayed.ctx, created.id, 1, request);
    await expectSameFacts({ db, ctx }, replayed, rows);
  });

  it('add：数量差额批次固定 addedBatch，重放可复现', async () => {
    const { db, ctx } = harness;
    const created = await createIngredient(ctx, {
      name: '编辑加量面粉',
      unit: 'GRAM',
      batches: [{ quantity: 1000, unit: 'GRAM', expiryDate: '2026-12-01' }],
    });
    const request: IngredientWriteInput = {
      name: '编辑加量面粉',
      unit: 'GRAM',
      quantity: 1300,
      expiryDate: '2027-01-01',
      opened: true,
    };
    await updateIngredient(ctx, created.id, 1, request);

    const rows = await outbox(db);
    const payload = JSON.parse(rows[1]!.payloadJson as string) as IngredientUpdateCommandPayload;
    const added = payload.addedBatch!;
    const activeBatchIds = await batchIds(db, created.id);
    expect(activeBatchIds).toContain(added.batchId);
    const logs = await db.query<{ id: string; changeQuantity: number; notes: string | null }>(
      'SELECT "id","changeQuantity","notes" FROM "InventoryLog" WHERE "ingredientId" = ? ORDER BY rowid',
      [created.id],
    );
    expect(added.logId).toBe(logs.at(-1)!.id);
    expect(logs.at(-1)!.changeQuantity).toBe(300);
    expect(logs.at(-1)!.notes).toBe('食材编辑同步库存');
    expect(payload).not.toHaveProperty('replacedBatches');

    const ids = [...replayIdsOf(rows[0]!), ...updateReplayIds(payload)];
    const replayed = await openHarness(fixedIds(ids));
    await createIngredient(replayed.ctx, {
      name: '编辑加量面粉',
      unit: 'GRAM',
      batches: [{ quantity: 1000, unit: 'GRAM', expiryDate: '2026-12-01' }],
    });
    await updateIngredient(replayed.ctx, created.id, 1, request);
    await expectSameFacts({ db, ctx }, replayed, rows);
  });

  it('deduct：编辑减量的 MANUAL_DEDUCT 日志按实际扣减顺序带明确 batchId', async () => {
    const { db, ctx } = harness;
    const created = await createIngredient(ctx, {
      name: '编辑减量牛奶',
      unit: 'MILLILITER',
      batches: [
        { quantity: 200, unit: 'MILLILITER', expiryDate: '2026-12-31' },
        { quantity: 300, unit: 'MILLILITER', expiryDate: '2026-12-01', consumePriority: true },
      ],
    });
    const request: IngredientWriteInput = {
      name: '编辑减量牛奶',
      unit: 'MILLILITER',
      quantity: 250,
    };
    await updateIngredient(ctx, created.id, 1, request);

    const rows = await outbox(db);
    const payload = JSON.parse(rows[1]!.payloadJson as string) as IngredientUpdateCommandPayload;
    const priorityBatchId = created.batches[0]!.id;
    expect(payload.deductions).toEqual([
      {
        batchId: priorityBatchId,
        logId: expect.any(String),
        beforeQuantity: 300,
        changeQuantity: -250,
        afterQuantity: 50,
        unit: 'MILLILITER',
      },
    ]);
    const [log] = await db.query<{ id: string; changeType: string }>(
      'SELECT "id","changeType" FROM "InventoryLog" WHERE "changeType" = ?',
      ['MANUAL_DEDUCT'],
    );
    expect(payload.deductions![0]!.logId).toBe(log!.id);
    expect(log!.changeType).toBe('MANUAL_DEDUCT');
    expect(payload).not.toHaveProperty('addedBatch');

    const ids = [...replayIdsOf(rows[0]!), ...updateReplayIds(payload)];
    const replayed = await openHarness(fixedIds(ids));
    await createIngredient(replayed.ctx, {
      name: '编辑减量牛奶',
      unit: 'MILLILITER',
      batches: [
        { quantity: 200, unit: 'MILLILITER', expiryDate: '2026-12-31' },
        { quantity: 300, unit: 'MILLILITER', expiryDate: '2026-12-01', consumePriority: true },
      ],
    });
    await updateIngredient(replayed.ctx, created.id, 1, request);
    await expectSameFacts({ db, ctx }, replayed, rows);
  });

  it('legacy implicit update：历史存量补建批次记录 implicitBatch 并重放', async () => {
    const { db, ctx } = harness;
    const created = await createIngredient(ctx, { name: '历史存量糖', unit: 'GRAM' });
    await db.withWriteTransaction(async (tx) => {
      await tx.run('UPDATE "Ingredient" SET "quantity" = 800 WHERE "id" = ?', [created.id]);
    });
    const request: IngredientWriteInput = {
      name: '历史存量糖',
      unit: 'GRAM',
      quantity: 1000,
    };
    await updateIngredient(ctx, created.id, 1, request);

    const rows = await outbox(db);
    const payload = JSON.parse(rows[1]!.payloadJson as string) as IngredientUpdateCommandPayload;
    expect(payload.implicitBatch).toBeDefined();
    expect(payload.addedBatch).toBeDefined();
    const logs = await db.query<{ id: string; changeType: string; notes: string | null }>(
      'SELECT "id","changeType","notes" FROM "InventoryLog" WHERE "ingredientId" = ? ORDER BY rowid',
      [created.id],
    );
    expect(logs.map((log) => log.notes)).toEqual(['历史存量自动补建等效批次', '食材编辑同步库存']);
    expect(payload.implicitBatch!.logId).toBe(logs[0]!.id);
    expect(payload.addedBatch!.logId).toBe(logs[1]!.id);
    expect((await batchIds(db, created.id)).includes(payload.implicitBatch!.batchId)).toBe(true);

    const ids = [...replayIdsOf(rows[0]!), ...updateReplayIds(payload)];
    const replayed = await openHarness(fixedIds(ids));
    await createIngredient(replayed.ctx, { name: '历史存量糖', unit: 'GRAM' });
    await replayed.db.withWriteTransaction(async (tx) => {
      await tx.run('UPDATE "Ingredient" SET "quantity" = 800 WHERE "id" = ?', [created.id]);
    });
    await updateIngredient(replayed.ctx, created.id, 1, request);
    await expectSameFacts({ db, ctx }, replayed, rows);
  });
});

describe('食材消耗载荷：扣减批次/日志映射与重放', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await openHarness();
  });

  const seed: IngredientWriteInput = {
    name: '消耗测试鸡胸肉',
    unit: 'GRAM',
    batches: [
      { quantity: 300, unit: 'GRAM', expiryDate: '2026-12-20' },
      { quantity: 500, unit: 'GRAM', expiryDate: '2026-12-01' },
      { quantity: 200, unit: 'GRAM', expiryDate: '2026-12-10', consumePriority: true },
    ],
  };

  it('normal consume：deductions 按实际扣减顺序对应轮转后的批次与日志', async () => {
    const { db, ctx } = harness;
    const created = await createIngredient(ctx, seed);
    const input: ConsumeInput = {
      mode: 'QUANTITY',
      quantity: 450,
      unit: 'GRAM',
      ingredientVersion: 1,
    };
    const result = await consumeIngredient(ctx, created.id, input);

    const rows = await outbox(db);
    const payload = JSON.parse(rows[1]!.payloadJson as string) as IngredientConsumeCommandPayload;
    expect(payload.executedAt).toBe(NOW.toISOString());
    expect(payload.request).toEqual({
      mode: 'QUANTITY',
      quantity: 450,
      unit: 'GRAM',
      ingredientVersion: 1,
      notes: null,
    });
    expect(payload.deductions.map((item) => [item.batchId, item.changeQuantity])).toEqual(
      result.allocations.map((item) => [item.batchId, item.changeQuantity]),
    );
    expect(payload.deductions.map((item) => item.logId)).toEqual(result.inventoryLogIds);
    expect(payload.inventoryLogIds).toEqual(result.inventoryLogIds);
    expect(payload.deductions.map((item) => item.afterQuantity)).toEqual([0, 250]);
    expect(payload).not.toHaveProperty('implicitBatch');

    const ids = [...replayIdsOf(rows[0]!), ...consumeReplayIds(payload)];
    const replayed = await openHarness(fixedIds(ids));
    await createIngredient(replayed.ctx, seed);
    await consumeIngredient(replayed.ctx, created.id, input);
    await expectSameFacts({ db, ctx }, replayed, rows);
  });

  it('implicit consume：历史存量补建先于扣减，implicitBatch 与 deductions 均固定', async () => {
    const { db, ctx } = harness;
    const created = await createIngredient(ctx, { name: '历史存量米', unit: 'GRAM' });
    await db.withWriteTransaction(async (tx) => {
      await tx.run('UPDATE "Ingredient" SET "quantity" = 600, "expiryDate" = ? WHERE "id" = ?', [
        '2026-12-31',
        created.id,
      ]);
    });
    const input: ConsumeInput = {
      mode: 'QUANTITY',
      quantity: 100,
      unit: 'GRAM',
      ingredientVersion: 1,
    };
    await consumeIngredient(ctx, created.id, input);

    const rows = await outbox(db);
    const payload = JSON.parse(rows[1]!.payloadJson as string) as IngredientConsumeCommandPayload;
    const logs = await db.query<{ id: string; changeType: string; changeQuantity: number }>(
      'SELECT "id","changeType","changeQuantity" FROM "InventoryLog" WHERE "ingredientId" = ? ORDER BY rowid',
      [created.id],
    );
    expect(logs.map((log) => [log.changeType, log.changeQuantity])).toEqual([
      ['ADJUST', 600],
      ['MANUAL_DEDUCT', -100],
    ]);
    expect(payload.implicitBatch).toBeDefined();
    expect(payload.implicitBatch!.logId).toBe(logs[0]!.id);
    expect(payload.deductions).toHaveLength(1);
    expect(payload.deductions[0]).toMatchObject({
      batchId: payload.implicitBatch!.batchId,
      logId: logs[1]!.id,
      beforeQuantity: 600,
      changeQuantity: -100,
      afterQuantity: 500,
      unit: 'GRAM',
    });

    const ids = [...replayIdsOf(rows[0]!), ...consumeReplayIds(payload)];
    const replayed = await openHarness(fixedIds(ids));
    await createIngredient(replayed.ctx, { name: '历史存量米', unit: 'GRAM' });
    await replayed.db.withWriteTransaction(async (tx) => {
      await tx.run('UPDATE "Ingredient" SET "quantity" = 600, "expiryDate" = ? WHERE "id" = ?', [
        '2026-12-31',
        created.id,
      ]);
    });
    await consumeIngredient(replayed.ctx, created.id, input);
    await expectSameFacts({ db, ctx }, replayed, rows);
  });
});
