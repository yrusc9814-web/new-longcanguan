/**
 * 食材与批次的行与 DTO 映射。
 *
 * 字段集合对齐上游 Prisma 返回形状（含 `deletedAt` 与 `inventoryBatches`），
 * `status` 只在详情与消耗响应中派生；分类在此统一归一化。
 */
import type { InventoryStatus, QuantityUnit } from '@dafan/shared/types';

import { localDate, sqlBoolean } from '../common.js';
import { normalizeIngredientCategory, type IngredientCategory } from './categories.js';

export const QUANTITY_UNITS: readonly QuantityUnit[] = [
  'GRAM',
  'KILOGRAM',
  'MILLILITER',
  'LITER',
  'PIECE',
  'BOX',
  'BAG',
  'BOTTLE',
  'CAN',
  'PACK',
  'PORTION',
  'OTHER',
];

export function isQuantityUnit(value: unknown): value is QuantityUnit {
  return typeof value === 'string' && (QUANTITY_UNITS as readonly string[]).includes(value);
}

export interface BatchRow {
  readonly id: string;
  readonly ingredientId: string;
  readonly quantity: number;
  readonly unit: QuantityUnit;
  readonly purchaseDate: string | null;
  readonly expiryDate: string | null;
  readonly location: string | null;
  readonly opened: number | boolean;
  readonly consumePriority: number | boolean;
  readonly notes: string | null;
  readonly version: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IngredientRow {
  readonly id: string;
  readonly name: string;
  readonly imagePath: string | null;
  readonly category: string | null;
  readonly quantity: number;
  readonly unit: QuantityUnit;
  readonly purchaseDate: string | null;
  readonly expiryDate: string | null;
  readonly location: string | null;
  readonly minStock: number | null;
  readonly maxStock: number | null;
  readonly opened: number | boolean;
  readonly notes: string | null;
  readonly version: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BatchDto {
  readonly id: string;
  readonly ingredientId: string;
  readonly quantity: number;
  readonly unit: QuantityUnit;
  readonly purchaseDate: string | null;
  readonly expiryDate: string | null;
  readonly location: string | null;
  readonly opened: boolean;
  readonly consumePriority: boolean;
  readonly notes: string | null;
  readonly version: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IngredientDto {
  readonly id: string;
  readonly name: string;
  readonly imagePath: string | null;
  readonly category: IngredientCategory;
  readonly quantity: number;
  readonly unit: QuantityUnit;
  readonly purchaseDate: string | null;
  readonly expiryDate: string | null;
  readonly location: string | null;
  readonly minStock: number | null;
  readonly maxStock: number | null;
  readonly opened: boolean;
  readonly notes: string | null;
  readonly version: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly inventoryBatches: BatchDto[];
  /** shared `IngredientDto` 的批次字段名；与 `inventoryBatches` 同一数组。 */
  readonly batches: BatchDto[];
  readonly status?: InventoryStatus;
}

export function toBatchDto(row: BatchRow): BatchDto {
  return {
    id: row.id,
    ingredientId: row.ingredientId,
    quantity: row.quantity,
    unit: row.unit,
    purchaseDate: row.purchaseDate,
    expiryDate: row.expiryDate,
    location: row.location,
    opened: sqlBoolean(row.opened),
    consumePriority: sqlBoolean(row.consumePriority),
    notes: row.notes,
    version: row.version,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toIngredientDto(
  row: IngredientRow,
  batches: readonly BatchRow[],
  status?: InventoryStatus,
): IngredientDto {
  const mapped = batches.map(toBatchDto);
  return {
    id: row.id,
    name: row.name,
    imagePath: row.imagePath,
    category: normalizeIngredientCategory(row.category, row.name),
    quantity: row.quantity,
    unit: row.unit,
    purchaseDate: row.purchaseDate,
    expiryDate: row.expiryDate,
    location: row.location,
    minStock: row.minStock,
    maxStock: row.maxStock,
    opened: sqlBoolean(row.opened),
    notes: row.notes,
    version: row.version,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    inventoryBatches: mapped,
    batches: mapped,
    ...(status ? { status } : {}),
  };
}

/**
 * 上游 `ingredientStatus`：数量耗尽优先，其次过期 / 临期 3 天，再低库存。
 * 使用设备本地日历，避免 UTC 换日误判。
 */
export function ingredientStatus(
  row: { quantity: number; minStock: number | null; expiryDate: string | null },
  now: Date,
): InventoryStatus {
  const today = localDate(now);
  const soonDate = localDate(now, 3);
  if (row.quantity <= 0) return 'DEPLETED';
  if (row.expiryDate && row.expiryDate < today) return 'EXPIRED';
  if (row.expiryDate && row.expiryDate <= soonDate) return 'EXPIRING_SOON';
  if (row.minStock != null && row.quantity < row.minStock) return 'LOW_STOCK';
  return 'NORMAL';
}
