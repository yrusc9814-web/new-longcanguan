/**
 * 食材域读路径与写路径的共享查询/校验工具。
 *
 * 全部读写都通过 `DatabaseClient`（读）与 `withWriteTransaction`（写）完成，
 * 不直接持有驱动，也不触碰同步表以外的私有表。
 */
import type { DatabaseClient, WriteTransaction } from '../../db/database.js';
import { LocalApiError } from '../../local-api/protocol.js';
import type { QuantityUnit } from '@dafan/shared/types';
import { validationError } from '../common.js';
import { convertQuantity } from '../units.js';
import { ACTIVE_BATCH_ORDER } from './batches.js';
import { isQuantityUnit, type BatchRow, type IngredientRow } from './dto.js';
import { roundQuantity } from './numbers.js';

export function notFound(message = '食材不存在'): LocalApiError {
  return new LocalApiError(404, 'NOT_FOUND', message);
}

export function conflict(message: string): LocalApiError {
  return new LocalApiError(409, 'CONFLICT', message);
}

export async function findIngredient(
  client: DatabaseClient | WriteTransaction,
  id: string,
): Promise<IngredientRow | null> {
  const rows = await client.query<IngredientRow>(
    `SELECT * FROM "Ingredient" WHERE "id" = ? AND "deletedAt" IS NULL`,
    [id],
  );
  return rows[0] ?? null;
}

/** 批量读取多个食材的活批次，避免列表页 N+1。 */
export async function listActiveBatchesFor(
  client: DatabaseClient,
  ingredientIds: readonly string[],
): Promise<Map<string, BatchRow[]>> {
  const grouped = new Map<string, BatchRow[]>();
  if (!ingredientIds.length) return grouped;
  const placeholders = ingredientIds.map(() => '?').join(', ');
  const rows = await client.query<BatchRow>(
    `SELECT * FROM "InventoryBatch"
     WHERE "deletedAt" IS NULL AND "ingredientId" IN (${placeholders})
     ORDER BY "ingredientId" ASC, ${ACTIVE_BATCH_ORDER}`,
    [...ingredientIds],
  );
  for (const row of rows) {
    const group = grouped.get(row.ingredientId) ?? [];
    group.push(row);
    grouped.set(row.ingredientId, group);
  }
  return grouped;
}

export interface BatchInput {
  readonly quantity: number;
  readonly unit: QuantityUnit;
  readonly purchaseDate?: string | null;
  readonly expiryDate?: string | null;
  readonly location?: string | null;
  readonly opened?: boolean;
  readonly consumePriority?: boolean;
  readonly notes?: string | null;
}

export interface IngredientWriteInput {
  readonly name: string;
  readonly imagePath?: string | null;
  readonly category?: string | null;
  readonly unit: QuantityUnit;
  readonly minStock?: number | null;
  readonly maxStock?: number | null;
  readonly notes?: string | null;
  readonly batches?: BatchInput[];
  readonly quantity?: number | null;
  readonly purchaseDate?: string | null;
  readonly expiryDate?: string | null;
  readonly location?: string | null;
  readonly opened?: boolean;
}

function assertNonNegative(value: number | null | undefined, field: string): void {
  if (value != null && (!Number.isFinite(value) || value < 0))
    throw validationError(`${field}不能为负数`);
}

export function assertInput(input: IngredientWriteInput): void {
  if (!input.name?.trim()) throw validationError('食材名称不能为空');
  assertNonNegative(input.minStock, '最低库存');
  assertNonNegative(input.maxStock, '最高库存');
  if (input.minStock != null && input.maxStock != null && input.minStock > input.maxStock)
    throw validationError('最低库存不能大于最高库存');
  assertNonNegative(input.quantity, '库存数量');
  for (const batch of input.batches ?? []) {
    assertNonNegative(batch.quantity, '批次数量');
    if (convertQuantity(batch.quantity, batch.unit, input.unit) == null)
      throw validationError('批次单位必须可换算为食材基础单位');
  }
}

/** 显式批次汇总到基础单位（已通过 assertInput 的可换算校验）。 */
export function sumBatches(batches: readonly BatchInput[], baseUnit: QuantityUnit): number {
  return roundQuantity(
    batches.reduce(
      (total, batch) => total + (convertQuantity(batch.quantity, batch.unit, baseUnit) ?? 0),
      0,
    ),
  );
}

export function optionalText(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw validationError(`${field}必须是字符串或 null`);
  return value;
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw validationError(`${field}必须是布尔值`);
  return value;
}

export function optionalNumber(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw validationError(`${field}必须是数字`);
  return value;
}

export function parseUnit(value: unknown, field: string): QuantityUnit {
  if (!isQuantityUnit(value)) throw validationError(`${field}必须是支持的计量单位`);
  return value;
}

export function parseBatches(value: unknown): BatchInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw validationError('batches 必须是数组');
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw validationError(`batches[${index}] 必须是对象`);
    const item = raw as Record<string, unknown>;
    const quantity = item.quantity;
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0)
      throw validationError(`batches[${index}].quantity 必须是不小于 0 的数字`);
    const unit = parseUnit(item.unit, `batches[${index}].unit`);
    return {
      quantity,
      unit,
      purchaseDate: optionalText(item.purchaseDate, `batches[${index}].purchaseDate`),
      expiryDate: optionalText(item.expiryDate, `batches[${index}].expiryDate`),
      location: optionalText(item.location, `batches[${index}].location`),
      opened: optionalBoolean(item.opened, `batches[${index}].opened`),
      consumePriority: optionalBoolean(item.consumePriority, `batches[${index}].consumePriority`),
      notes: optionalText(item.notes, `batches[${index}].notes`),
    };
  });
}
