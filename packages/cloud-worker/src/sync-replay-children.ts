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

/**
 * 排餐/记录内嵌的 `DinerDto` 只是引用：DO 已有该 `Diner` 时**不覆盖**主表字段，
 * 也不回退其 `version`；只有缺失时才兜底插入。
 */
function upsertDiner(sql: SqlStorage, source: RawRow, changes: ChangeCollector): string {
  const id = requireString(source, 'id');
  const existing = readRow(sql, 'Diner', id);
  if (existing) return String(existing.id);
  const values = resolveColumns(REPLAY_TABLES.Diner, source);
  values.id = id;
  insertRow(sql, 'Diner', values);
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
  // 先剪枝、后写入：同一复合唯一键（如 `RecipeStep(recipeId, stepNo)`）换主键重放时，
  // 旧行必须先删除，否则插入会撞唯一索引。
  const replace = (
    table: SyncEntityName,
    items: RawRow[],
    prepare: (item: RawRow) => { id: string; values: RawRow } | null,
  ) => {
    const prepared: { id: string; values: RawRow }[] = [];
    for (const item of items) {
      const entry = prepare(item);
      if (entry) prepared.push(entry);
    }
    // 同一载荷里出现重复主键时只保留最后一条，避免自我冲突。
    const unique = new Map(prepared.map((entry) => [entry.id, entry] as const));
    // 剪枝先于写入，也顺带清掉「复合唯一键相同但主键已变」的旧子行。
    pruneChildren(sql, table, 'recipeId', recipeId, new Set(unique.keys()), changes);
    for (const entry of unique.values()) {
      upsertChild(sql, table, entry.id, entry.values, changes);
    }
  };

  if (Array.isArray(payload.ingredients)) {
    replace('RecipeIngredient', payload.ingredients as RawRow[], (item) => ({
      id: requireString(item, 'id'),
      values: { ...item, recipeId },
    }));
  }
  if (Array.isArray(payload.steps)) {
    replace('RecipeStep', payload.steps as RawRow[], (item) => ({
      id: requireString(item, 'id'),
      values: { ...item, recipeId },
    }));
  }
  if (Array.isArray(payload.mealTypes)) {
    replace('RecipeMealType', payload.mealTypes as RawRow[], (item) => ({
      id: requireString(item, 'id'),
      values: { ...item, recipeId },
    }));
  }
  if (Array.isArray(payload.mealRoles)) {
    replace('RecipeMealRole', payload.mealRoles as RawRow[], (item) => ({
      id: requireString(item, 'id'),
      values: { ...item, recipeId },
    }));
  }
  if (Array.isArray(payload.tools)) {
    replace('RecipeTool', payload.tools as RawRow[], (item) => ({
      id: requireString(item, 'id'),
      values: { ...item, recipeId },
    }));
  }
  if (Array.isArray(payload.tags)) {
    const tags = payload.tags as RawRow[];
    // 旧/兼容载荷可能只带 `tagId`：复用既有关联行 ID，否则派生确定性 ID。
    const resolved = tags.map((tag) => {
      const tagRow = tag.tag && typeof tag.tag === 'object' ? (tag.tag as RawRow) : null;
      const tagId = tagRow
        ? upsertTag(sql, { ...tagRow, id: requireString(tagRow, 'id') }, changes)
        : requireString(tag, 'tagId');
      const declared = typeof tag.id === 'string' && tag.id.length > 0 ? tag.id : null;
      if (declared) return { tag, tagId, relationId: declared };
      const existing = rows(
        sql,
        `SELECT "id" FROM "RecipeTag" WHERE "recipeId" = ? AND "tagId" = ?`,
        recipeId,
        tagId,
      )[0];
      return {
        tag,
        tagId,
        relationId: existing ? String(existing.id) : derivedId('rt', recipeId, tagId),
      };
    });
    const unique = new Map(resolved.map((entry) => [entry.relationId, entry] as const));
    pruneChildren(sql, 'RecipeTag', 'recipeId', recipeId, new Set(unique.keys()), changes);
    for (const entry of unique.values()) {
      upsertChild(
        sql,
        'RecipeTag',
        entry.relationId,
        { ...entry.tag, recipeId, tagId: entry.tagId },
        changes,
      );
    }
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
