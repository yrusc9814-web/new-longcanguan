import type {
  SyncEntityName,
  SyncOperation,
  SyncPayload,
  SyncRejection,
  SyncRowChange,
} from '@dafan/shared/sync';

import { REPLAY_ORDER, REPLAY_TABLES, type ReplayTableMeta } from './sync-replay-tables';

/** 基础类型与共享工具：SQL 读写、载荷校验、变更收集、单位换算、基线历史。 */

export type BindValue = string | number | null;
export type RawRow = Record<string, unknown>;

export const HISTORY_TABLE = 'sync_replay_history';

/**
 * 基线保留：长离线设备仍可能拿着很旧的 `baseVersion` 推送，因此不能只留最近
 * 若干版；按时间窗 + 每行版本上限共同裁剪，保证最新状态永远可回溯。
 */
const HISTORY_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const HISTORY_MIN_VERSIONS = 32;
const TOMBSTONE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
/**
 * 墓碑复用同一张历史表：`version = TOMBSTONE_VERSION` 表示「该行在此前已被删除」，
 * 与真实版本（>= 1）不冲突，避免新增控制表扩散到 DO 迁移与 schema 断言。
 */
const TOMBSTONE_VERSION = -1;
export const QUANTITY_EPSILON = 1e-9;

/** 冲突拒绝：运输层映射为 `SyncRejection` 并整批回滚。 */
export class ReplayConflict extends Error {
  readonly rejection: SyncRejection;
  /** 被拒绝的原操作；运输层在批事务回滚后据此读取权威聚合行。 */
  readonly operation?: SyncOperation;

  constructor(rejection: SyncRejection, message?: string, operation?: SyncOperation) {
    super(message ?? rejection.code);
    this.name = 'ReplayConflict';
    this.rejection = rejection;
    this.operation = operation;
  }
}

/** 载荷不合法（缺列、类型错误、外键不存在），运输层应返回 400。 */
export class ReplayValidationError extends Error {
  readonly code = 'VALIDATION_ERROR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ReplayValidationError';
  }
}

export interface ReplayResult {
  readonly newVersion: number;
  readonly changes: readonly SyncRowChange[];
}

export function rows(sql: SqlStorage, text: string, ...bindings: BindValue[]): RawRow[] {
  return sql.exec<Record<string, never>>(text, ...bindings).toArray() as unknown as RawRow[];
}

export function readRow(
  sql: SqlStorage,
  table: SyncEntityName,
  id: string | number,
): RawRow | null {
  return rows(sql, `SELECT * FROM "${table}" WHERE "id" = ?`, id)[0] ?? null;
}

export function bindable(value: unknown): BindValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ReplayValidationError('数值列必须是有限数字');
    return value;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new ReplayValidationError(`无法绑定的列值：${typeof value}`);
}

/** 只保留表结构内的列；`Tag` 载荷里多余的 `version` 直接丢弃。 */
export function resolveColumns(meta: ReplayTableMeta, values: RawRow): RawRow {
  const resolved: RawRow = {};
  for (const column of meta.columns) {
    if (values[column] !== undefined) resolved[column] = values[column];
    else if (meta.defaults && column in meta.defaults) resolved[column] = meta.defaults[column];
  }
  return resolved;
}

export function insertRow(sql: SqlStorage, table: SyncEntityName, values: RawRow): void {
  const resolved = resolveColumns(REPLAY_TABLES[table], values);
  const columns = REPLAY_TABLES[table].columns.filter((column) => resolved[column] !== undefined);
  sql.exec(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`,
    ...columns.map((column) => bindable(resolved[column])),
  );
}

export function updateRow(
  sql: SqlStorage,
  table: SyncEntityName,
  id: string | number,
  values: RawRow,
): void {
  const columns = REPLAY_TABLES[table].columns.filter(
    (column) => column !== 'id' && values[column] !== undefined,
  );
  if (!columns.length) return;
  sql.exec(
    `UPDATE "${table}" SET ${columns.map((column) => `"${column}" = ?`).join(', ')} WHERE "id" = ?`,
    ...columns.map((column) => bindable(values[column])),
    id,
  );
}

/** 按显式列集更新（忽略载荷里的聚合字段，如清单 `items`）。 */
export function replaceRowValues(
  sql: SqlStorage,
  table: SyncEntityName,
  id: string | number,
  values: RawRow,
): void {
  const columns = Object.keys(values).filter((column) =>
    REPLAY_TABLES[table].columns.includes(column),
  );
  if (!columns.length) return;
  sql.exec(
    `UPDATE "${table}" SET ${columns.map((column) => `"${column}" = ?`).join(', ')} WHERE "id" = ?`,
    ...columns.map((column) => bindable(values[column])),
    id,
  );
}

export function deleteRow(sql: SqlStorage, table: SyncEntityName, id: string | number): void {
  sql.exec(`DELETE FROM "${table}" WHERE "id" = ?`, id);
}

export function toPayload(row: RawRow): SyncPayload {
  return row as unknown as SyncPayload;
}

export function rowVersion(row: RawRow | null, table: SyncEntityName): number {
  if (!row || !REPLAY_TABLES[table].versioned) return 1;
  const version = Number(row.version);
  return Number.isFinite(version) ? version : 1;
}

export function isTrue(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

export function requireString(payload: RawRow, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ReplayValidationError(`${field} 必须是非空字符串`);
  }
  return value;
}

export function requireNumber(payload: RawRow, field: string): number {
  const value = payload[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ReplayValidationError(`${field} 必须是有限数字`);
  }
  return value;
}

export function objectPayload(value: unknown, field: string): RawRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReplayValidationError(`${field} 必须是对象`);
  }
  return value as RawRow;
}

export function arrayPayload(value: unknown): RawRow[] {
  return Array.isArray(value) ? (value as RawRow[]) : [];
}

const FOREIGN_KEYS: Partial<
  Record<SyncEntityName, ReadonlyArray<readonly [string, SyncEntityName]>>
> = {
  InventoryBatch: [['ingredientId', 'Ingredient']],
  InventoryLog: [
    ['ingredientId', 'Ingredient'],
    ['inventoryBatchId', 'InventoryBatch'],
    ['relatedPlanId', 'MealPlan'],
    ['relatedRecordId', 'MealRecord'],
  ],
  MealPlanDiner: [
    ['mealPlanId', 'MealPlan'],
    ['dinerId', 'Diner'],
  ],
  MealPlanItem: [
    ['mealPlanId', 'MealPlan'],
    ['recipeId', 'Recipe'],
    ['storeId', 'Store'],
  ],
  MealRecord: [
    ['relatedPlanId', 'MealPlan'],
    ['sourceMealPlanId', 'MealPlan'],
  ],
  MealRecordDiner: [
    ['mealRecordId', 'MealRecord'],
    ['dinerId', 'Diner'],
  ],
  MealRecordItem: [
    ['mealRecordId', 'MealRecord'],
    ['recipeId', 'Recipe'],
    ['storeId', 'Store'],
  ],
  RecipeIngredient: [
    ['recipeId', 'Recipe'],
    ['ingredientId', 'Ingredient'],
  ],
  RecipeMealRole: [['recipeId', 'Recipe']],
  RecipeMealType: [['recipeId', 'Recipe']],
  RecipeStep: [['recipeId', 'Recipe']],
  RecipeTag: [
    ['recipeId', 'Recipe'],
    ['tagId', 'Tag'],
  ],
  RecipeTool: [
    ['recipeId', 'Recipe'],
    ['toolId', 'KitchenTool'],
  ],
  ShoppingListItem: [
    ['shoppingListId', 'ShoppingList'],
    ['ingredientId', 'Ingredient'],
  ],
  StoreMealType: [['storeId', 'Store']],
  StoreMenuItem: [['storeId', 'Store']],
  UploadAsset: [
    ['recipeId', 'Recipe'],
    ['storeId', 'Store'],
    ['mealRecordId', 'MealRecord'],
  ],
};

export function assertForeignKeys(sql: SqlStorage, table: SyncEntityName, row: RawRow): void {
  for (const [column, target] of FOREIGN_KEYS[table] ?? []) {
    const value = row[column];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new ReplayValidationError(`${table}.${column} 外键类型无效`);
    }
    if (!readRow(sql, target, value)) {
      throw new ReplayValidationError(
        `${table}.${column} 指向不存在的 ${target}: ${String(value)}`,
      );
    }
  }
}

/** 变更收集：写入后按主键重读完整裸行，并按父表优先排序。 */
export class ChangeCollector {
  readonly #entries = new Map<string, SyncRowChange>();
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  record(table: SyncEntityName, id: string | number, row: RawRow | null): void {
    const key = `${table}\u0000${String(id)}`;
    this.#entries.delete(key);
    this.#entries.set(key, { table, id, row: row ? toPayload(row) : null });
  }

  capture(table: SyncEntityName, id: string | number): void {
    this.record(table, id, readRow(this.#sql, table, id));
  }

  /**
   * 物理删除（`row === null`）永远先于新增/更新落地：删除按子表优先（`REPLAY_ORDER` 逆序），
   * 写入按父表优先（正序）。端侧在同一事务内顺序复现，就不会出现「旧子行还没删、新子行
   * 已占用同一复合唯一键」或「父行未插入导致外键失败」。
   */
  list(): readonly SyncRowChange[] {
    const rank = new Map(REPLAY_ORDER.map((table, index) => [table, index] as const));
    const order = (direction: 1 | -1) => (left: SyncRowChange, right: SyncRowChange) => {
      const delta = ((rank.get(left.table) ?? 0) - (rank.get(right.table) ?? 0)) * direction;
      if (delta !== 0) return delta;
      return String(left.id).localeCompare(String(right.id)) * direction;
    };
    const entries = [...this.#entries.values()];
    const removed = entries.filter((entry) => entry.row === null).sort(order(-1));
    const written = entries.filter((entry) => entry.row !== null).sort(order(1));
    return [...removed, ...written];
  }
}

const UNIT_GROUPS: ReadonlyArray<Readonly<Partial<Record<string, number>>>> = [
  { GRAM: 1, KILOGRAM: 1000 },
  { MILLILITER: 1, LITER: 1000 },
];

export function convertQuantity(quantity: number, from: string, to: string): number | null {
  if (quantity < 0) throw new ReplayValidationError('数量不能为负数');
  if (from === to) return quantity;
  for (const group of UNIT_GROUPS) {
    const fromFactor = group[from];
    const toFactor = group[to];
    if (fromFactor !== undefined && toFactor !== undefined) {
      return quantity * (fromFactor / toFactor);
    }
  }
  return null;
}

export function roundQuantity(value: number): number {
  return Number(value.toFixed(6));
}

export function summarizeQuantity(list: ReadonlyArray<RawRow>, baseUnit: string): number {
  return roundQuantity(
    list.reduce((total, row) => {
      const quantity = Number(row.quantity ?? 0);
      if (!(quantity > 0)) return total;
      return total + (convertQuantity(quantity, String(row.unit), baseUnit) ?? 0);
    }, 0),
  );
}

export const ACTIVE_BATCH_ORDER = `"consumePriority" DESC, "expiryDate" ASC, "createdAt" ASC, "id" ASC`;

export function activeBatches(sql: SqlStorage, ingredientId: string): RawRow[] {
  return rows(
    sql,
    `SELECT * FROM "InventoryBatch" WHERE "ingredientId" = ? AND "deletedAt" IS NULL
     ORDER BY ${ACTIVE_BATCH_ORDER}`,
    ingredientId,
  );
}

export function summarizeBatchMeta(list: ReadonlyArray<RawRow>): {
  purchaseDate: string | null;
  expiryDate: string | null;
  location: string | null;
} {
  const active = list.filter((row) => Number(row.quantity ?? 0) > 0);
  const earliest = [...active].sort((left, right) =>
    String(left.expiryDate ?? '9999-12-31').localeCompare(String(right.expiryDate ?? '9999-12-31')),
  )[0];
  return {
    purchaseDate: (earliest?.purchaseDate as string | null | undefined) ?? null,
    expiryDate: (earliest?.expiryDate as string | null | undefined) ?? null,
    location:
      (earliest?.location as string | null | undefined) ??
      (active.find((row) => row.location)?.location as string | null | undefined) ??
      null,
  };
}

export function shoppingItems(sql: SqlStorage, listId: string): RawRow[] {
  return rows(
    sql,
    `SELECT * FROM "ShoppingListItem" WHERE "shoppingListId" = ? ORDER BY "sortOrder" ASC, rowid ASC`,
    listId,
  );
}

export function sameRow(left: RawRow | undefined, right: RawRow | undefined): boolean {
  if (!left || !right) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 字段级三方合并：客户端相对基线改动过的字段优先，其余取服务端。 */
export function mergeFields(client: RawRow, base: RawRow | undefined, server: RawRow): RawRow {
  const merged: RawRow = { ...server };
  for (const [key, value] of Object.entries(client)) {
    if (base === undefined || JSON.stringify(base[key]) !== JSON.stringify(value)) {
      merged[key] = value;
    }
  }
  return merged;
}

/** 建表：由运输层在 DO 迁移阶段调用，可重复执行。 */
export function migrateReplay(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS "${HISTORY_TABLE}" (
      "table_name" TEXT NOT NULL,
      "row_id" TEXT NOT NULL,
      "version" INTEGER NOT NULL,
      "row_json" TEXT NOT NULL,
      "items_json" TEXT,
      "created_at" INTEGER NOT NULL,
      PRIMARY KEY ("table_name", "row_id", "version")
    )`,
  );
}

/** 整库替换 / epoch 重置时清空，避免旧基线污染新账本。 */
export function clearReplayHistory(sql: SqlStorage): void {
  sql.exec(`DELETE FROM "${HISTORY_TABLE}"`);
}

export interface BaselineSnapshot {
  readonly row: RawRow;
  readonly items?: RawRow[];
}

/** 记录子行物理删除，供长离线客户端防止「复活已删行」。 */
export function rememberTombstone(
  sql: SqlStorage,
  table: SyncEntityName,
  rowId: string,
  version: number,
): void {
  const now = Date.now();
  sql.exec(
    `INSERT INTO "${HISTORY_TABLE}" ("table_name","row_id","version","row_json","items_json","created_at")
     VALUES (?, ?, ?, ?, NULL, ?)
     ON CONFLICT ("table_name","row_id","version") DO UPDATE SET
       "row_json" = excluded."row_json", "created_at" = excluded."created_at"`,
    table,
    rowId,
    TOMBSTONE_VERSION,
    String(version),
    now,
  );
  sql.exec(
    `DELETE FROM "${HISTORY_TABLE}"
      WHERE "table_name" = ? AND "row_id" = ? AND "version" = ? AND "created_at" < ?`,
    table,
    rowId,
    TOMBSTONE_VERSION,
    now - TOMBSTONE_RETENTION_MS,
  );
}

/** 返回该行被删除时的父版本；未删除返回 null。 */
export function readTombstone(
  sql: SqlStorage,
  table: SyncEntityName,
  rowId: string,
): number | null {
  const found = rows(
    sql,
    `SELECT "row_json" FROM "${HISTORY_TABLE}"
      WHERE "table_name" = ? AND "row_id" = ? AND "version" = ?`,
    table,
    rowId,
    TOMBSTONE_VERSION,
  )[0];
  if (!found) return null;
  const version = Number(found.row_json);
  return Number.isFinite(version) ? version : null;
}

/**
 * 每次写入前保存当前服务端状态；同版本重复保存即覆盖。
 *
 * 裁剪只删除「既超出时间窗、又不在最新 N 版内」的版本，长离线设备仍可拿到
 * 很久以前的基线做三方合并。
 */
export function rememberBaseline(sql: SqlStorage, table: SyncEntityName, row: RawRow | null): void {
  if (!row) return;
  const id = row.id;
  if (typeof id !== 'string' && typeof id !== 'number') return;
  const items = table === 'ShoppingList' ? shoppingItems(sql, String(id)) : undefined;
  sql.exec(
    `INSERT INTO "${HISTORY_TABLE}" ("table_name","row_id","version","row_json","items_json","created_at")
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT ("table_name","row_id","version") DO UPDATE SET
       "row_json" = excluded."row_json", "items_json" = excluded."items_json"`,
    table,
    String(id),
    rowVersion(row, table),
    JSON.stringify(row),
    items ? JSON.stringify(items) : null,
    Date.now(),
  );
  sql.exec(
    `DELETE FROM "${HISTORY_TABLE}"
      WHERE "table_name" = ? AND "row_id" = ?
        AND "created_at" < ?
        AND "version" NOT IN (
          SELECT "version" FROM "${HISTORY_TABLE}" WHERE "table_name" = ? AND "row_id" = ?
          ORDER BY "version" DESC LIMIT ${HISTORY_MIN_VERSIONS}
        )`,
    table,
    String(id),
    Date.now() - HISTORY_RETENTION_MS,
    table,
    String(id),
  );
}

export function readBaseline(
  sql: SqlStorage,
  table: SyncEntityName,
  id: string,
  version: number,
): BaselineSnapshot | null {
  const found = rows(
    sql,
    `SELECT "row_json","items_json" FROM "${HISTORY_TABLE}"
     WHERE "table_name" = ? AND "row_id" = ? AND "version" = ?`,
    table,
    id,
    version,
  )[0];
  if (!found) return null;
  try {
    return {
      row: JSON.parse(String(found.row_json)) as RawRow,
      items: found.items_json ? (JSON.parse(String(found.items_json)) as RawRow[]) : undefined,
    };
  } catch {
    return null;
  }
}
