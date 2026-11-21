/**
 * 批次事实与自愈（与上游 `modules/ingredients/batches.ts` 同源，改写为 SQLite 事务）。
 *
 * 上游语义：
 * - 活批次 = `deletedAt IS NULL`；扣减顺序 `consumePriority DESC, expiryDate ASC, createdAt ASC, id ASC`
 *   （SQLite 中 ASC 时 NULL 在前，与 Prisma/SQLite 生成结果一致）；
 * - 历史数据存在「食材 quantity > 0 但没有任何活批次」，读取时只派生、写入时真实补建；
 * - 食材汇总数量只统计 quantity > 0 的活批次并换算到基础单位。
 */
import type { InventoryChangeType, QuantityUnit } from '@dafan/shared/types';

import type { WriteTransaction } from '../../db/database.js';
import { convertQuantity } from '../units.js';
import { LocalApiError } from '../../local-api/protocol.js';
import { QUANTITY_EPSILON, roundQuantity } from './numbers.js';
import type { BatchRow } from './dto.js';

export interface BatchFacts {
  readonly ingredientId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unit: QuantityUnit;
  readonly purchaseDate: string | null;
  readonly expiryDate: string | null;
  readonly location: string | null;
  readonly opened: boolean;
}
export interface AggregatableBatch {
  readonly ingredientId: string;
  readonly quantity: number;
  readonly unit: QuantityUnit;
  readonly expiryDate: string | null;
  readonly consumePriority: boolean;
  readonly opened: boolean;
}

/**
 * 返回可用于聚合/扣减的批次集合：无活批次且汇总数量 > 0 时追加一个等效批次。
 * 只用于读路径（推荐聚合），不改库；写路径请用 `persistImplicitBatch`。
 */
export function withImplicitBatch<T extends AggregatableBatch>(
  ingredient: BatchFacts,
  batches: T[],
): Array<T | AggregatableBatch> {
  if (hasActiveStock(batches) || !(ingredient.quantity > 0)) return batches;
  return [
    ...batches,
    {
      ingredientId: ingredient.ingredientId,
      quantity: ingredient.quantity,
      unit: ingredient.unit,
      expiryDate: ingredient.expiryDate,
      consumePriority: false,
      opened: ingredient.opened,
    },
  ];
}

export const ACTIVE_BATCH_ORDER = `"consumePriority" DESC, "expiryDate" ASC, "createdAt" ASC, "id" ASC`;

export function hasActiveStock(batches: ReadonlyArray<{ quantity: number }>): boolean {
  return batches.some((batch) => batch.quantity > 0);
}

/** 汇总数量：只统计 quantity > 0 的活批次，换算到基础单位后求和。 */
export function summarizeQuantity(
  batches: ReadonlyArray<{ quantity: number; unit: QuantityUnit }>,
  baseUnit: QuantityUnit,
): number {
  return roundQuantity(
    batches.reduce((total, batch) => {
      if (!(batch.quantity > 0)) return total;
      return total + (convertQuantity(batch.quantity, batch.unit, baseUnit) ?? 0);
    }, 0),
  );
}

/**
 * 汇总到期日/位置：取有剩余数量的批次里到期日最早的一条；
 * 该批次没有位置时回退到其余活批次中的首个非空位置，避免编辑/入库把位置意外清空。
 */
export function summarizeBatchMeta<
  T extends {
    quantity: number;
    expiryDate: string | null;
    location?: string | null;
    purchaseDate?: string | null;
  },
>(
  batches: T[],
): { purchaseDate: string | null; expiryDate: string | null; location: string | null } {
  const active = batches.filter((batch) => batch.quantity > 0);
  const earliest = [...active].sort((a, b) =>
    (a.expiryDate ?? '9999-12-31').localeCompare(b.expiryDate ?? '9999-12-31'),
  )[0];
  const location = earliest?.location ?? active.find((batch) => batch.location)?.location ?? null;
  return {
    purchaseDate: earliest?.purchaseDate ?? null,
    expiryDate: earliest?.expiryDate ?? null,
    location,
  };
}

/** 读取食材的批次：activeOnly 时仅 `deletedAt IS NULL`，按扣减顺序返回。 */
export async function loadBatches(
  tx: WriteTransaction,
  ingredientId: string,
  options: { activeOnly?: boolean; positiveOnly?: boolean } = {},
): Promise<BatchRow[]> {
  const clauses = ['"ingredientId" = ?'];
  if (options.activeOnly !== false) clauses.push('"deletedAt" IS NULL');
  if (options.positiveOnly) clauses.push('"quantity" > 0');
  return tx.query<BatchRow>(
    `SELECT * FROM "InventoryBatch" WHERE ${clauses.join(' AND ')} ORDER BY ${ACTIVE_BATCH_ORDER}`,
    [ingredientId],
  );
}

/** 无活动批次且汇总数量 > 0 时，在事务内真实补建等效批次并写 ADJUST 日志。 */
export async function persistImplicitBatch(
  tx: WriteTransaction,
  ingredient: BatchFacts,
  existingBatches: ReadonlyArray<{ quantity: number }>,
  now: Date,
): Promise<{ batchId: string; quantity: number; unit: QuantityUnit } | null> {
  if (hasActiveStock(existingBatches) || !(ingredient.quantity > 0)) return null;
  const quantity = roundQuantity(ingredient.quantity);
  const batchId = newBatchId();
  const timestamp = now.toISOString();
  await tx.run(
    `INSERT INTO "InventoryBatch"
      ("id", "ingredientId", "quantity", "unit", "purchaseDate", "expiryDate", "location", "opened", "consumePriority", "notes", "version", "deletedAt", "createdAt", "updatedAt")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, NULL, ?, ?)`,
    [
      batchId,
      ingredient.ingredientId,
      quantity,
      ingredient.unit,
      ingredient.purchaseDate,
      ingredient.expiryDate,
      ingredient.location,
      ingredient.opened ? 1 : 0,
      '历史存量自动补建等效批次',
      timestamp,
      timestamp,
    ],
  );
  await insertLog(tx, {
    ingredientId: ingredient.ingredientId,
    ingredientNameSnapshot: ingredient.name,
    inventoryBatchId: batchId,
    beforeQuantity: 0,
    changeQuantity: quantity,
    afterQuantity: quantity,
    unit: ingredient.unit,
    changeType: 'ADJUST',
    notes: '历史存量自动补建等效批次',
    now,
  });
  return { batchId, quantity, unit: ingredient.unit };
}

export interface LogInput {
  ingredientId: string;
  ingredientNameSnapshot: string;
  inventoryBatchId: string | null;
  beforeQuantity: number;
  changeQuantity: number;
  afterQuantity: number;
  unit: QuantityUnit;
  changeType: InventoryChangeType;
  relatedPlanId?: string | null;
  relatedRecordId?: string | null;
  notes: string | null;
  now: Date;
}

/** 写一条 InventoryLog（与批次更新同事务）；返回日志 id。 */
export async function insertLog(tx: WriteTransaction, input: LogInput): Promise<string> {
  const id = newBatchId();
  const timestamp = input.now.toISOString();
  await tx.run(
    `INSERT INTO "InventoryLog"
      ("id", "ingredientId", "ingredientNameSnapshot", "inventoryBatchId", "beforeQuantity", "changeQuantity", "afterQuantity", "unit", "changeType", "relatedPlanId", "relatedRecordId", "notes", "createdAt", "updatedAt")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.ingredientId,
      input.ingredientNameSnapshot,
      input.inventoryBatchId,
      input.beforeQuantity,
      input.changeQuantity,
      input.afterQuantity,
      input.unit,
      input.changeType,
      input.relatedPlanId ?? null,
      input.relatedRecordId ?? null,
      input.notes,
      timestamp,
      timestamp,
    ],
  );
  return id;
}

export interface BatchMeta {
  purchaseDate?: string | null;
  expiryDate?: string | null;
  location?: string | null;
  opened?: boolean;
}

/**
 * 显式 `batches` 的替换语义（上游老调用方与 adapter 编辑都用它）：
 * 退役现有活批次（软删保留日志外键），按请求逐条新建批次并写 ADJUST 日志。
 * 返回替换后的基础单位汇总数量与「是否有批次处于开封状态」。
 */
export async function replaceBatches(
  tx: WriteTransaction,
  params: {
    ingredientId: string;
    ingredientName: string;
    baseUnit: QuantityUnit;
    batches: ReadonlyArray<{
      quantity: number;
      unit: QuantityUnit;
      purchaseDate?: string | null;
      expiryDate?: string | null;
      location?: string | null;
      opened?: boolean;
      consumePriority?: boolean;
      notes?: string | null;
    }>;
    now: Date;
  },
): Promise<{ quantity: number; opened: boolean }> {
  const { ingredientId, ingredientName, baseUnit, batches, now } = params;
  const timestamp = now.toISOString();
  await tx.run(
    `UPDATE "InventoryBatch" SET "deletedAt" = ?, "version" = "version" + 1, "updatedAt" = ?
     WHERE "ingredientId" = ? AND "deletedAt" IS NULL`,
    [timestamp, timestamp, ingredientId],
  );
  let quantity = 0;
  let opened = false;
  for (const batch of batches) {
    const batchId = newBatchId();
    await tx.run(
      `INSERT INTO "InventoryBatch"
        ("id", "ingredientId", "quantity", "unit", "purchaseDate", "expiryDate", "location", "opened", "consumePriority", "notes", "version", "deletedAt", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      [
        batchId,
        ingredientId,
        batch.quantity,
        batch.unit,
        batch.purchaseDate ?? null,
        batch.expiryDate ?? null,
        batch.location ?? null,
        batch.opened ? 1 : 0,
        batch.consumePriority ? 1 : 0,
        batch.notes ?? null,
        timestamp,
        timestamp,
      ],
    );
    await insertLog(tx, {
      ingredientId,
      ingredientNameSnapshot: ingredientName,
      inventoryBatchId: batchId,
      beforeQuantity: 0,
      changeQuantity: batch.quantity,
      afterQuantity: batch.quantity,
      unit: batch.unit,
      changeType: 'ADJUST',
      notes: '食材编辑替换批次',
      now,
    });
    quantity += convertQuantity(batch.quantity, batch.unit, baseUnit) ?? 0;
    if (batch.quantity > 0 && batch.opened) opened = true;
  }
  return { quantity: roundQuantity(quantity), opened };
}

/**
 * 食材编辑时把「汇总库存」同步进批次，而不是只改汇总字段：
 * - 目标数量与活批次合计一致（纯改名/单位换算/元数据编辑）→ 不动数量；
 * - 目标数量更大 → 新建差额批次并记 ADJUST 日志；
 * - 目标数量更小 → 按既有消耗顺序扣减并记 MANUAL_DEDUCT 日志。
 * 这样编辑后的 quantity 与各活批次之和始终一致。
 */
export async function synchronizeBatches(
  tx: WriteTransaction,
  params: {
    ingredientId: string;
    ingredientName: string;
    baseUnit: QuantityUnit;
    targetQuantity: number;
    meta: BatchMeta;
    metaTouched: boolean;
    fallbackMeta: {
      purchaseDate: string | null;
      expiryDate: string | null;
      location: string | null;
      opened: boolean;
    };
    now: Date;
  },
): Promise<void> {
  const {
    ingredientId,
    ingredientName,
    baseUnit,
    targetQuantity,
    meta,
    metaTouched,
    fallbackMeta,
    now,
  } = params;
  const batches = await loadBatches(tx, ingredientId);
  const active = batches.filter((batch) => batch.quantity > 0);
  const total = summarizeQuantity(active, baseUnit);
  const delta = roundQuantity(targetQuantity - total);
  const timestamp = now.toISOString();

  if (delta > QUANTITY_EPSILON) {
    const batchId = newBatchId();
    const purchaseDate =
      meta.purchaseDate === undefined ? fallbackMeta.purchaseDate : meta.purchaseDate;
    const expiryDate = meta.expiryDate === undefined ? fallbackMeta.expiryDate : meta.expiryDate;
    const location = meta.location === undefined ? fallbackMeta.location : meta.location;
    const opened = meta.opened ?? fallbackMeta.opened;
    await tx.run(
      `INSERT INTO "InventoryBatch"
        ("id", "ingredientId", "quantity", "unit", "purchaseDate", "expiryDate", "location", "opened", "consumePriority", "notes", "version", "deletedAt", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 1, NULL, ?, ?)`,
      [
        batchId,
        ingredientId,
        delta,
        baseUnit,
        purchaseDate,
        expiryDate,
        location,
        opened ? 1 : 0,
        timestamp,
        timestamp,
      ],
    );
    await insertLog(tx, {
      ingredientId,
      ingredientNameSnapshot: ingredientName,
      inventoryBatchId: batchId,
      beforeQuantity: 0,
      changeQuantity: delta,
      afterQuantity: delta,
      unit: baseUnit,
      changeType: 'ADJUST',
      notes: '食材编辑同步库存',
      now,
    });
  } else if (delta < -QUANTITY_EPSILON) {
    let remaining = roundQuantity(-delta);
    for (const batch of active) {
      if (remaining <= QUANTITY_EPSILON) break;
      const available = convertQuantity(batch.quantity, batch.unit, baseUnit) ?? 0;
      if (available <= 0) continue;
      const take = Math.min(remaining, available);
      const takeInBatchUnit = Math.min(
        roundQuantity(convertQuantity(take, baseUnit, batch.unit) ?? 0),
        batch.quantity,
      );
      const after = roundQuantity(batch.quantity - takeInBatchUnit);
      const updated = await tx.run(
        `UPDATE "InventoryBatch" SET "quantity" = ?, "version" = "version" + 1, "updatedAt" = ?
         WHERE "id" = ? AND "version" = ? AND "deletedAt" IS NULL AND "quantity" >= ?`,
        [after, timestamp, batch.id, batch.version, takeInBatchUnit],
      );
      if (updated.changes !== 1) {
        throw new LocalApiError(409, 'CONFLICT', '批次已被其他修改，请刷新后重试', {
          details: {
            entity: 'InventoryBatch',
            id: batch.id,
            expectedVersion: batch.version,
            actualVersion: batch.version + 1,
          },
        });
      }
      await insertLog(tx, {
        ingredientId,
        ingredientNameSnapshot: ingredientName,
        inventoryBatchId: batch.id,
        beforeQuantity: batch.quantity,
        changeQuantity: -takeInBatchUnit,
        afterQuantity: after,
        unit: batch.unit,
        changeType: 'MANUAL_DEDUCT',
        notes: '食材编辑同步库存',
        now,
      });
      remaining = roundQuantity(remaining - take);
    }
    if (remaining > QUANTITY_EPSILON) {
      throw new LocalApiError(409, 'CONFLICT', '库存数量不足，无法同步本次编辑');
    }
  }

  if (!metaTouched) return;
  // 食材级字段适用于所有活批次；省略字段保留，显式 null 同步清空。
  const assignments: string[] = [];
  const values: Array<string | number | null> = [];
  if (meta.purchaseDate !== undefined) {
    assignments.push('"purchaseDate" = ?');
    values.push(meta.purchaseDate);
  }
  if (meta.expiryDate !== undefined) {
    assignments.push('"expiryDate" = ?');
    values.push(meta.expiryDate);
  }
  if (meta.location !== undefined) {
    assignments.push('"location" = ?');
    values.push(meta.location);
  }
  if (meta.opened !== undefined) {
    assignments.push('"opened" = ?');
    values.push(meta.opened ? 1 : 0);
  }
  if (!assignments.length) return;
  assignments.push('"updatedAt" = ?');
  values.push(timestamp);
  await tx.run(
    `UPDATE "InventoryBatch" SET ${assignments.join(', ')}
     WHERE "ingredientId" = ? AND "deletedAt" IS NULL AND "quantity" > 0`,
    [...values, ingredientId],
  );
}

let idCounter = 0;

/** 批次/日志主键：32 位小写十六进制，进程内单调扰动以规避同毫秒碰撞。 */
export function newBatchId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  idCounter = (idCounter + 1) % 0x10000;
  bytes[12] = (bytes[12] + (idCounter >> 8)) & 0xff;
  bytes[13] = (bytes[13] + (idCounter & 0xff)) & 0xff;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
