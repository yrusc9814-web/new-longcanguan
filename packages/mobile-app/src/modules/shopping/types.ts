/**
 * 购物清单域的行与 DTO 形状。
 *
 * 对齐上游 Prisma `ShoppingList` / `ShoppingListItem` 的终态列，
 * 以及 `@dafan/shared/types` 中 Google2 适配器直接消费的 DTO 字段。
 */
import type {
  QuantityUnit,
  ShoppingListDto,
  ShoppingListItemDto,
  ShoppingListStatus,
  ShoppingSourceType,
} from '@dafan/shared/types';

export interface ShoppingListRow {
  readonly id: string;
  readonly name: string;
  readonly status: ShoppingListStatus;
  readonly notes: string | null;
  readonly version: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ShoppingListItemRow {
  readonly id: string;
  readonly shoppingListId: string;
  readonly ingredientId: string | null;
  readonly ingredientNameSnapshot: string;
  readonly quantity: number | null;
  readonly unit: QuantityUnit | null;
  readonly amountText: string | null;
  readonly category: string | null;
  readonly sourceType: ShoppingSourceType;
  readonly sourceId: string | null;
  readonly completed: number | boolean;
  readonly sortOrder: number;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const SHOPPING_LIST_STATUSES: readonly ShoppingListStatus[] = [
  'ACTIVE',
  'COMPLETED',
  'ARCHIVED',
];

export const SHOPPING_SOURCE_TYPES: readonly ShoppingSourceType[] = [
  'MANUAL',
  'RECIPE',
  'RECOMMENDATION',
  'LOW_STOCK',
  'PLAN',
  'INSUFFICIENT_STOCK',
];

/** 条目行 → Google2 DTO：`ingredientName` 由快照列派生，布尔列归一。 */
export function toShoppingItemDto(row: ShoppingListItemRow): ShoppingListItemDto {
  return {
    id: row.id,
    ingredientId: row.ingredientId,
    ingredientName: row.ingredientNameSnapshot,
    quantity: row.quantity,
    unit: row.unit,
    amountText: row.amountText,
    category: row.category,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    completed: row.completed === 1 || row.completed === true,
    sortOrder: row.sortOrder,
    notes: row.notes,
  };
}

export function toShoppingListDto(
  row: ShoppingListRow,
  items: readonly ShoppingListItemRow[],
): ShoppingListDto {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    notes: row.notes,
    items: items.map(toShoppingItemDto),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 条目稳定读取顺序：未购在前，再按 sortOrder，最后按创建时间与 ID 兜底。 */
export const ITEM_ORDER = `"completed" ASC, "sortOrder" ASC, "createdAt" ASC, "id" ASC`;
