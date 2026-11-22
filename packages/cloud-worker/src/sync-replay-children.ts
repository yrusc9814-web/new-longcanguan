import type { SyncEntityName } from '@dafan/shared/sync';

import {
  assertForeignKeys,
  ChangeCollector,
  deleteRow,
  insertRow,
  readRow,
  ReplayValidationError,
  resolveColumns,
  rows,
  type RawRow,
  requireString,
  updateRow,
} from './sync-replay-support';
import { REPLAY_TABLES } from './sync-replay-tables';

/**
 * 聚合子表随父行同事务写入。
 *
 * 客户端真实载荷（见 mobile-app 各 service）：
 * - `Ingredient` upsert 携带 `batches[]` 与 `inventoryLogs[]` 的完整行；
 * - `Recipe` upsert 携带 `ingredients/steps/tags/mealTypes/mealRoles/tools`；
 * - `Store` upsert 携带 `mealTypes: string[]` 与 `menuItems[]`（仅 DTO 名）；
 * - `MealPlan`/`MealRecord` upsert 携带 `items[]` 与 `diners[]`。
 *
 * 其中 `MealPlanDiner`、`MealRecordDiner`、`StoreMealType` 的行主键**未出现在端侧
 * payload**（DTO 只暴露关联实体），云端只能按 `(父行, 关联值)` 派生确定性主键，
 * 保证同一载荷在任何时刻重放得到同一 ID。
 */

function derivedId(...parts: readonly string[]): string {
  return parts.join(':');
}

/**
 * 自然键对齐：旧版端侧载荷不含关联行 ID（`diners` 只带 DinerDto，
 * `mealTypes` 只是字符串数组），云端只能按 `(父行, 关联值)` 定位。
 *
 * 若库里已有该自然键的行（历史随机 ID 或全量快照上传的行），复用其 ID，
 * 并清理同一自然键的重复行，避免同一业务事实出现两行。
 */
function alignNaturalKey(
  sql: SqlStorage,
  table: SyncEntityName,
  parentColumn: string,
  parentId: string,
  valueColumn: string,
  value: string,
  canonicalId: string,
  changes: ChangeCollector,
): string {
  const matches = rows(
    sql,
    `SELECT "id" FROM "${table}" WHERE "${parentColumn}" = ? AND "${valueColumn}" = ?`,
    parentId,
    value,
  ).map((match) => requireString(match as RawRow, 'id'));
  // 这三张关联表没有下级引用，历史随机 ID 行可以直接归并到派生 ID：
  // 旧端侧/旧快照留下的行被删除，所有设备收敛到同一主键。
  for (const id of matches) {
    if (id === canonicalId) continue;
    deleteRow(sql, table, id);
    changes.record(table, id, null);
  }
  return canonicalId;
}

function upsertChild(
  sql: SqlStorage,
  table: SyncEntityName,
  id: string,
  source: RawRow,
  changes: ChangeCollector,
): void {
  const values = resolveColumns(REPLAY_TABLES[table], source);
  values.id = id;
  assertForeignKeys(sql, table, values);
  if (readRow(sql, table, id)) updateRow(sql, table, id, values);
  else insertRow(sql, table, values);
  changes.capture(table, id);
}

function upsertDiner(sql: SqlStorage, source: RawRow, changes: ChangeCollector): string {
  const id = requireString(source, 'id');
  const values = resolveColumns(REPLAY_TABLES.Diner, source);
  values.id = id;
  if (readRow(sql, 'Diner', id)) updateRow(sql, 'Diner', id, values);
  else insertRow(sql, 'Diner', values);
  changes.capture('Diner', id);
  return id;
}

/** `Tag` 无 version 列，按 `(name,type)` 对齐；载荷内的 `version` 直接丢弃。 */
function upsertTag(sql: SqlStorage, source: RawRow, changes: ChangeCollector): string {
  const name = requireString(source, 'name');
  const type = typeof source.type === 'string' ? source.type : 'GENERAL';
  const existing = rows(sql, `SELECT * FROM "Tag" WHERE "name" = ? AND "type" = ?`, name, type)[0];
  const id = existing?.id !== undefined ? String(existing.id) : requireString(source, 'id');
  const values = resolveColumns(REPLAY_TABLES.Tag, { ...source, id, name, type });
  values.id = id;
  values.name = name;
  values.type = type;
  if (existing) updateRow(sql, 'Tag', id, values);
  else insertRow(sql, 'Tag', values);
  changes.capture('Tag', id);
  return id;
}

function ingredientChildren(
  sql: SqlStorage,
  ingredientId: string,
  payload: RawRow,
  changes: ChangeCollector,
): void {
  for (const batch of Array.isArray(payload.batches) ? (payload.batches as RawRow[]) : []) {
    const id = requireString(batch, 'id');
    upsertChild(sql, 'InventoryBatch', id, { ...batch, ingredientId }, changes);
  }
  for (const log of Array.isArray(payload.inventoryLogs)
    ? (payload.inventoryLogs as RawRow[])
    : []) {
    const id = requireString(log, 'id');
    upsertChild(sql, 'InventoryLog', id, { ...log, ingredientId }, changes);
  }
}

function recipeChildren(
  sql: SqlStorage,
  recipeId: string,
  payload: RawRow,
  changes: ChangeCollector,
): void {
  if (Array.isArray(payload.ingredients)) {
    const keep = new Set<string>();
    for (const item of payload.ingredients as RawRow[]) {
      const id = requireString(item, 'id');
      keep.add(id);
      upsertChild(sql, 'RecipeIngredient', id, { ...item, recipeId }, changes);
    }
    pruneChildren(sql, 'RecipeIngredient', 'recipeId', recipeId, keep, changes);
  }
  if (Array.isArray(payload.steps)) {
    const keep = new Set<string>();
    for (const step of payload.steps as RawRow[]) {
      const id = requireString(step, 'id');
      keep.add(id);
      upsertChild(sql, 'RecipeStep', id, { ...step, recipeId }, changes);
    }
    pruneChildren(sql, 'RecipeStep', 'recipeId', recipeId, keep, changes);
  }
  if (Array.isArray(payload.mealTypes)) {
    const keep = new Set<string>();
    for (const mealType of payload.mealTypes as RawRow[]) {
      const id = requireString(mealType, 'id');
      keep.add(id);
      upsertChild(sql, 'RecipeMealType', id, { ...mealType, recipeId }, changes);
    }
    pruneChildren(sql, 'RecipeMealType', 'recipeId', recipeId, keep, changes);
  }
  if (Array.isArray(payload.mealRoles)) {
    const keep = new Set<string>();
    for (const mealRole of payload.mealRoles as RawRow[]) {
      const id = requireString(mealRole, 'id');
      keep.add(id);
      upsertChild(sql, 'RecipeMealRole', id, { ...mealRole, recipeId }, changes);
    }
    pruneChildren(sql, 'RecipeMealRole', 'recipeId', recipeId, keep, changes);
  }
  if (Array.isArray(payload.tools)) {
    const keep = new Set<string>();
    for (const tool of payload.tools as RawRow[]) {
      const id = requireString(tool, 'id');
      keep.add(id);
      upsertChild(sql, 'RecipeTool', id, { ...tool, recipeId }, changes);
    }
    pruneChildren(sql, 'RecipeTool', 'recipeId', recipeId, keep, changes);
  }
  if (Array.isArray(payload.tags)) {
    const keep = new Set<string>();
    for (const tag of payload.tags as RawRow[]) {
      const relationId = requireString(tag, 'id');
      keep.add(relationId);
      const tagRow = tag.tag && typeof tag.tag === 'object' ? (tag.tag as RawRow) : tag;
      const tagId = tag.tag
        ? upsertTag(sql, { ...tagRow, id: requireString(tagRow, 'id') }, changes)
        : requireString(tag, 'tagId');
      upsertChild(sql, 'RecipeTag', relationId, { ...tag, recipeId, tagId }, changes);
    }
    pruneChildren(sql, 'RecipeTag', 'recipeId', recipeId, keep, changes);
  }
}

function storeChildren(
  sql: SqlStorage,
  storeId: string,
  payload: RawRow,
  changes: ChangeCollector,
): void {
  if (Array.isArray(payload.mealTypes)) {
    const keep = new Set<string>();
    for (const mealType of payload.mealTypes as unknown[]) {
      if (typeof mealType !== 'string') continue;
      const canonicalId = derivedId('smt', storeId, mealType);
      const id = alignNaturalKey(
        sql,
        'StoreMealType',
        'storeId',
        storeId,
        'mealType',
        mealType,
        canonicalId,
        changes,
      );
      keep.add(id);
      upsertChild(
        sql,
        'StoreMealType',
        id,
        {
          id,
          storeId,
          mealType,
          createdAt: payload.updatedAt ?? null,
          updatedAt: payload.updatedAt ?? null,
        },
        changes,
      );
    }
    pruneChildren(sql, 'StoreMealType', 'storeId', storeId, keep, changes);
  }
  if (Array.isArray(payload.menuItems)) {
    const keep = new Set<string>();
    for (const item of payload.menuItems as RawRow[]) {
      const id = requireString(item, 'id');
      keep.add(id);
      upsertChild(sql, 'StoreMenuItem', id, { ...item, storeId }, changes);
    }
    pruneChildren(sql, 'StoreMenuItem', 'storeId', storeId, keep, changes);
  }
}

/**
 * 关联行时间戳两端必须同源：端侧写入时正好推进父行 `updatedAt`，
 * 行级时间未出现在载荷里，因此两端统一取父行本次写入的 `updatedAt`。
 */
function parentTimestamp(payload: RawRow): string {
  return String(payload.updatedAt ?? payload.createdAt ?? '');
}

function planChildren(
  sql: SqlStorage,
  planId: string,
  payload: RawRow,
  changes: ChangeCollector,
): void {
  if (Array.isArray(payload.items)) {
    const keep = new Set<string>();
    for (const item of payload.items as RawRow[]) {
      const id = requireString(item, 'id');
      keep.add(id);
      upsertChild(sql, 'MealPlanItem', id, { ...item, mealPlanId: planId }, changes);
    }
    pruneChildren(sql, 'MealPlanItem', 'mealPlanId', planId, keep, changes);
  }
  const timestamp = parentTimestamp(payload);
  if (Array.isArray(payload.diners)) {
    const keep = new Set<string>();
    for (const diner of payload.diners as RawRow[]) {
      const dinerId = upsertDiner(sql, diner, changes);
      const canonicalId = derivedId('mpd', planId, dinerId);
      const id = alignNaturalKey(
        sql,
        'MealPlanDiner',
        'mealPlanId',
        planId,
        'dinerId',
        dinerId,
        canonicalId,
        changes,
      );
      keep.add(id);
      upsertChild(
        sql,
        'MealPlanDiner',
        id,
        { id, mealPlanId: planId, dinerId, createdAt: timestamp, updatedAt: timestamp },
        changes,
      );
    }
    pruneChildren(sql, 'MealPlanDiner', 'mealPlanId', planId, keep, changes);
  }
}

/**
 * 端侧对聚合子表是「整组替换」（DELETE + INSERT），云端必须同语义剪枝，
 * 否则被删掉的条目/就餐人会在云端残留并回灌到其它设备。
 * 只在载荷确实携带该数组时剪枝，兼容只改标量的旧载荷。
 */
function pruneChildren(
  sql: SqlStorage,
  table: SyncEntityName,
  parentColumn: string,
  parentId: string,
  keep: ReadonlySet<string>,
  changes: ChangeCollector,
): void {
  for (const child of rows(
    sql,
    `SELECT "id" FROM "${table}" WHERE "${parentColumn}" = ?`,
    parentId,
  )) {
    const id = requireString(child as RawRow, 'id');
    if (keep.has(id)) continue;
    deleteRow(sql, table, id);
    changes.record(table, id, null);
  }
}

function recordChildren(
  sql: SqlStorage,
  recordId: string,
  payload: RawRow,
  changes: ChangeCollector,
): void {
  if (Array.isArray(payload.items)) {
    const keep = new Set<string>();
    for (const item of payload.items as RawRow[]) {
      const id = requireString(item, 'id');
      keep.add(id);
      upsertChild(sql, 'MealRecordItem', id, { ...item, mealRecordId: recordId }, changes);
    }
    pruneChildren(sql, 'MealRecordItem', 'mealRecordId', recordId, keep, changes);
  }
  const timestamp = parentTimestamp(payload);
  if (Array.isArray(payload.diners)) {
    const keep = new Set<string>();
    for (const diner of payload.diners as RawRow[]) {
      const dinerId = upsertDiner(sql, diner, changes);
      const canonicalId = derivedId('mrd', recordId, dinerId);
      const id = alignNaturalKey(
        sql,
        'MealRecordDiner',
        'mealRecordId',
        recordId,
        'dinerId',
        dinerId,
        canonicalId,
        changes,
      );
      keep.add(id);
      upsertChild(
        sql,
        'MealRecordDiner',
        id,
        { id, mealRecordId: recordId, dinerId, createdAt: timestamp, updatedAt: timestamp },
        changes,
      );
    }
    pruneChildren(sql, 'MealRecordDiner', 'mealRecordId', recordId, keep, changes);
  }
}

export function upsertEntityChildren(
  sql: SqlStorage,
  entity: SyncEntityName,
  parentId: string,
  payload: RawRow,
  changes: ChangeCollector,
): void {
  switch (entity) {
    case 'Ingredient':
      return ingredientChildren(sql, parentId, payload, changes);
    case 'Recipe':
      return recipeChildren(sql, parentId, payload, changes);
    case 'Store':
      return storeChildren(sql, parentId, payload, changes);
    case 'MealPlan':
      return planChildren(sql, parentId, payload, changes);
    case 'MealRecord':
      return recordChildren(sql, parentId, payload, changes);
    default:
      return;
  }
}

/** 删除父行前清理其子表，避免外键 RESTRICT 阻断。 */
export function deleteEntityChildren(
  sql: SqlStorage,
  entity: SyncEntityName,
  parentId: string,
  changes: ChangeCollector,
): void {
  const children: Partial<
    Record<SyncEntityName, ReadonlyArray<readonly [SyncEntityName, string]>>
  > = {
    Recipe: [
      ['RecipeIngredient', 'recipeId'],
      ['RecipeMealRole', 'recipeId'],
      ['RecipeMealType', 'recipeId'],
      ['RecipeStep', 'recipeId'],
      ['RecipeTag', 'recipeId'],
      ['RecipeTool', 'recipeId'],
    ],
    Store: [
      ['StoreMealType', 'storeId'],
      ['StoreMenuItem', 'storeId'],
    ],
    MealPlan: [
      ['MealPlanDiner', 'mealPlanId'],
      ['MealPlanItem', 'mealPlanId'],
    ],
    MealRecord: [
      ['MealRecordDiner', 'mealRecordId'],
      ['MealRecordItem', 'mealRecordId'],
    ],
    ShoppingList: [['ShoppingListItem', 'shoppingListId']],
  };
  for (const [table, column] of children[entity] ?? []) {
    for (const child of rows(sql, `SELECT "id" FROM "${table}" WHERE "${column}" = ?`, parentId)) {
      const id = requireString(child, 'id');
      deleteRow(sql, table, id);
      changes.record(table, id, null);
    }
  }
}

export { ReplayValidationError };
