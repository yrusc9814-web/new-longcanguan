/**
 * 购物清单服务：D5 补缺、勾选入库与幂等购物同步。
 *
 * 关键约束（T-004 铁律）：
 * - 默认活跃清单固定 ID `shopping_list_active_default`；端云预置 v1，冷启动补建与软删恢复
 *   **都不入发件箱**，仅真实用户变更才入队；恢复时保留既有版本链（不重置、不推进版本）；
 * - 清单 upsert 的 `baseVersion` 只取本次写入的期望版本：新建副单为 null（载荷 version 1），
 *   其余写入一律等于 `expectedVersion`，不再借发件箱瞬态推断；
 * - `replenish-recipe` 同菜谱同食材对齐最新差额，跨菜谱与手工项保持独立行，整批只推进一次版本；
 * - `check-in` 勾选买完与入库同事务完成；含无结构化数量（如「少许」）的条目整单 422 回滚；
 * - `ShoppingCheckinOperation` 以 operationId 幂等防重，重复请求返回首次结果；
 * - 发件箱载荷固化本次真实落库的全部主键、`executedAt` 与必要事实，供云端逐行重放。
 */
import type { QuantityUnit, ShoppingSourceType } from '@dafan/shared/types';
import {
  SHOPPING_DEFAULT_LIST_ID,
  SHOPPING_DEFAULT_LIST_NAME,
  STANDARD_SHOPPING_UNITS,
  type ShoppingCheckinCommandPayload,
  type ShoppingCheckinInventoryFactPayload,
  type ShoppingListItemFactPayload,
  type ShoppingListUpsertPayload,
} from '@dafan/shared/sync';

import type { DatabaseClient, WriteTransaction } from '../../db/database.js';
import { VersionConflictError } from '../../db/errors.js';
import type { SqlValue } from '../../db/types.js';
import { LocalApiError } from '../../local-api/protocol.js';
import { localDate, validationError } from '../common.js';
import {
  insertLog,
  loadBatches,
  persistImplicitBatch,
  summarizeBatchMeta,
  summarizeQuantity,
} from '../ingredients/batches.js';
import { normalizeIngredientCategory } from '../ingredients/categories.js';
import type { IngredientRow } from '../ingredients/dto.js';
import { isQuantityUnit } from '../ingredients/dto.js';
import { roundQuantity } from '../ingredients/numbers.js';
import { newLocalId } from '../meal-records/ids.js';
import { convertQuantity } from '../units.js';
import {
  ITEM_ORDER,
  SHOPPING_LIST_STATUSES,
  SHOPPING_SOURCE_TYPES,
  toShoppingListDto,
  type ShoppingListItemRow,
  type ShoppingListRow,
} from './types.js';

/** 固定默认清单 ID（与 `@dafan/shared/sync` 的常量一致，避免端侧写死多份）。 */
export const DEFAULT_SHOPPING_LIST_ID = SHOPPING_DEFAULT_LIST_ID;
export const DEFAULT_SHOPPING_LIST_NAME = SHOPPING_DEFAULT_LIST_NAME;

/** 可用结构化写回的标准单位：与 Google2 适配器一致（不含 OTHER），单一事实源在 shared。 */
const STANDARD_UNITS = new Set<QuantityUnit>(STANDARD_SHOPPING_UNITS);

/** 结构化数量项校验：必须同时提供数量与标准单位，否则视为自由规格。 */
export function isStructuredQuantity(quantity: number | null, unit: QuantityUnit | null): boolean {
  return quantity !== null && quantity > 0 && unit !== null && STANDARD_UNITS.has(unit);
}

export interface ShoppingServiceContext {
  readonly database: DatabaseClient;
  readonly now: () => Date;
  /** 主键生成器：重放时注入命令载荷中的固定 ID。 */
  readonly newId?: () => string;
}

let idCounter = 0;

export function newShoppingId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  idCounter = (idCounter + 1) % 0x10000;
  bytes[12] = (bytes[12] + (idCounter >> 8)) & 0xff;
  bytes[13] = (bytes[13] + (idCounter & 0xff)) & 0xff;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function idFactory(ctx: ShoppingServiceContext): () => string {
  return ctx.newId ?? newShoppingId;
}

function itemNotFound(): LocalApiError {
  return new LocalApiError(404, 'SHOPPING_ITEM_NOT_FOUND', '购物清单项目不存在');
}

function listNotFound(): LocalApiError {
  return new LocalApiError(404, 'SHOPPING_LIST_NOT_FOUND', '购物清单不存在');
}

function itemInvalid(message: string): LocalApiError {
  return new LocalApiError(422, 'SHOPPING_ITEM_INVALID', message);
}

function checkinQuantityInvalid(message: string): LocalApiError {
  return new LocalApiError(422, 'SHOPPING_CHECKIN_QUANTITY_INVALID', message);
}

/** 规范化名称匹配（与 Google2 适配器 `normalizeShoppingName` 一致）。 */
function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

async function readListRow(
  client: DatabaseClient | WriteTransaction,
  id: string,
): Promise<ShoppingListRow | null> {
  const rows = await client.query<ShoppingListRow>(
    `SELECT * FROM "ShoppingList" WHERE "id" = ? AND "deletedAt" IS NULL`,
    [id],
  );
  return rows[0] ?? null;
}

async function readItems(
  client: DatabaseClient | WriteTransaction,
  listId: string,
): Promise<ShoppingListItemRow[]> {
  return client.query<ShoppingListItemRow>(
    `SELECT * FROM "ShoppingListItem" WHERE "shoppingListId" = ? ORDER BY ${ITEM_ORDER}`,
    [listId],
  );
}

async function readListDto(
  client: DatabaseClient | WriteTransaction,
  row: ShoppingListRow,
): Promise<ReturnType<typeof toShoppingListDto>> {
  return toShoppingListDto(row, await readItems(client, row.id));
}

function toItemFact(row: ShoppingListItemRow): ShoppingListItemFactPayload {
  return {
    id: row.id,
    shoppingListId: row.shoppingListId,
    ingredientId: row.ingredientId,
    ingredientNameSnapshot: row.ingredientNameSnapshot,
    quantity: row.quantity,
    unit: row.unit,
    amountText: row.amountText,
    category: row.category,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    completed: row.completed === 1 || row.completed === true,
    sortOrder: row.sortOrder,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 清单聚合 upsert 载荷：清单行 + 全部条目，重放后逐列一致。 */
async function listUpsertPayload(
  tx: WriteTransaction,
  list: ShoppingListRow,
  baseItems?: readonly ShoppingListItemFactPayload[],
): Promise<ShoppingListUpsertPayload> {
  const items = await readItems(tx, list.id);
  return {
    id: list.id,
    name: list.name,
    status: list.status,
    notes: list.notes,
    version: list.version,
    deletedAt: list.deletedAt,
    createdAt: list.createdAt,
    updatedAt: list.updatedAt,
    items: items.map(toItemFact),
    // 本次操作实际基于的本地条目快照（形态同 items），云端据此做真实三方合并。
    ...(baseItems ? { baseItems: baseItems.map(toItemFact) } : {}),
  };
}

/** 本次写入前的条目快照：必须在写业务表之前读取。 */
async function itemBaseSnapshot(
  tx: WriteTransaction,
  listId: string,
): Promise<ShoppingListItemFactPayload[]> {
  return (await readItems(tx, listId)).map(toItemFact);
}

/**
 * 真实用户变更才入队：默认空清单初始化与软删恢复不得走这里。
 *
 * `baseVersion` 由调用方给出真实期望版本，不再读取发件箱瞬态状态推断：
 * 新建副单为 `null`（载荷 version 1），其余实际写入一律等于本次 `expectedVersion`。
 * `baseItems` 是本次操作前的本地条目快照，连续多次离线修改时云端靠它区分
 * 「客户端没看到」与「客户端真的删了」。
 */
async function enqueueListUpsert(
  tx: WriteTransaction,
  list: ShoppingListRow,
  baseVersion: number | null,
  baseItems?: readonly ShoppingListItemFactPayload[],
): Promise<void> {
  const payload = await listUpsertPayload(tx, list, baseItems);
  await tx.enqueue({
    opId: newLocalId(),
    entity: 'ShoppingList',
    entityId: list.id,
    kind: 'upsert',
    baseVersion,
    payload: { ...payload } as unknown as Record<string, unknown>,
  });
}

/** 乐观锁推进清单版本；版本不匹配抛 409 `VERSION_CONFLICT`（适配器据此重试一次）。 */
async function bumpListVersion(
  tx: WriteTransaction,
  listId: string,
  expectedVersion: number,
  timestamp: string,
): Promise<ShoppingListRow> {
  const result = await tx.run(
    `UPDATE "ShoppingList" SET "version" = "version" + 1, "updatedAt" = ?
     WHERE "id" = ? AND "version" = ? AND "deletedAt" IS NULL`,
    [timestamp, listId, expectedVersion],
  );
  if (result.changes !== 1) {
    const current = await readListRow(tx, listId);
    if (!current) throw listNotFound();
    throw new VersionConflictError('ShoppingList', listId, expectedVersion, current.version);
  }
  const next = await readListRow(tx, listId);
  if (!next) throw listNotFound();
  return next;
}

async function nextSortOrder(tx: WriteTransaction, listId: string): Promise<number> {
  const [row] = await tx.query<{ value: number | null }>(
    'SELECT MAX("sortOrder") AS "value" FROM "ShoppingListItem" WHERE "shoppingListId" = ?',
    [listId],
  );
  const value = row?.value;
  return typeof value === 'number' ? value + 1 : 0;
}

/**
 * 确保默认活跃清单存在（只在本机没有任何活跃清单时处理）。
 *
 * - 端云预置默认清单 v1；冷启动补建同一固定 ID，**零发件箱**（不是用户真实变更）；
 * - 默认清单被软删且无其他活跃清单时，原地恢复为空活跃单，保留既有版本链：
 *   不重置版本、不推进版本、不写发件箱。
 */
async function ensureDefaultList(
  database: DatabaseClient,
  timestamp: string,
): Promise<ShoppingListRow> {
  return database.withWriteTransaction(async (tx) => {
    const active = await tx.query<ShoppingListRow>(
      `SELECT * FROM "ShoppingList" WHERE "status" = 'ACTIVE' AND "deletedAt" IS NULL
       ORDER BY "updatedAt" DESC, "id" ASC LIMIT 1`,
    );
    if (active[0]) return active[0];

    const [deleted] = await tx.query<ShoppingListRow>(
      'SELECT * FROM "ShoppingList" WHERE "id" = ? AND "deletedAt" IS NOT NULL',
      [DEFAULT_SHOPPING_LIST_ID],
    );
    if (deleted) {
      // 恢复为空活跃单：清空旧条目，但保留既有版本链（版本号不动）。
      await tx.run('DELETE FROM "ShoppingListItem" WHERE "shoppingListId" = ?', [deleted.id]);
      await tx.run(
        `UPDATE "ShoppingList" SET "status" = 'ACTIVE', "deletedAt" = NULL, "updatedAt" = ?
         WHERE "id" = ?`,
        [timestamp, deleted.id],
      );
      const restored = await readListRow(tx, deleted.id);
      if (!restored) throw listNotFound();
      return restored;
    }

    await tx.run(
      `INSERT INTO "ShoppingList" ("id", "name", "status", "notes", "version", "deletedAt", "createdAt", "updatedAt")
       VALUES (?, ?, 'ACTIVE', NULL, 1, NULL, ?, ?)
       ON CONFLICT ("id") DO NOTHING`,
      [DEFAULT_SHOPPING_LIST_ID, DEFAULT_SHOPPING_LIST_NAME, timestamp, timestamp],
    );
    const created = await readListRow(tx, DEFAULT_SHOPPING_LIST_ID);
    if (!created) throw listNotFound();
    return created;
  });
}

export interface ListQuery {
  readonly status?: string;
}

/** `GET /shopping-lists`：返回清单 DTO 数组；ACTIVE 查询会自动确保默认空清单。 */
export async function listShoppingLists(
  ctx: ShoppingServiceContext,
  query: ListQuery = {},
): Promise<ReturnType<typeof toShoppingListDto>[]> {
  const status = query.status?.trim();
  if (status && !(SHOPPING_LIST_STATUSES as readonly string[]).includes(status)) {
    throw validationError('status 必须是 ACTIVE / COMPLETED / ARCHIVED');
  }
  const database = ctx.database;
  const timestamp = ctx.now().toISOString();
  if ((status ?? 'ACTIVE') === 'ACTIVE') {
    await ensureDefaultList(database, timestamp);
  }
  const rows = await database.query<ShoppingListRow>(
    `SELECT * FROM "ShoppingList" WHERE "deletedAt" IS NULL${status ? ' AND "status" = ?' : ''}
     ORDER BY "updatedAt" DESC, "id" ASC`,
    status ? [status] : [],
  );
  return Promise.all(rows.map((row) => readListDto(database, row)));
}

export async function getShoppingList(
  ctx: ShoppingServiceContext,
  id: string,
): Promise<ReturnType<typeof toShoppingListDto>> {
  const row = await readListRow(ctx.database, id);
  if (!row) throw listNotFound();
  return readListDto(ctx.database, row);
}

export interface CreateListInput {
  readonly name?: string;
  readonly notes?: string | null;
}

/** `POST /shopping-lists`：真实用户创建副单，入队单条清单 upsert（items 为空，version 1）。 */
export async function createShoppingList(
  ctx: ShoppingServiceContext,
  input: CreateListInput,
): Promise<ReturnType<typeof toShoppingListDto>> {
  const name = (input.name ?? '').trim() || DEFAULT_SHOPPING_LIST_NAME;
  const timestamp = ctx.now().toISOString();
  const nextId = idFactory(ctx);
  return ctx.database.withWriteTransaction(async (tx) => {
    const id = nextId();
    await tx.run(
      `INSERT INTO "ShoppingList" ("id", "name", "status", "notes", "version", "deletedAt", "createdAt", "updatedAt")
       VALUES (?, ?, 'ACTIVE', ?, 1, NULL, ?, ?)`,
      [id, name, input.notes ?? null, timestamp, timestamp],
    );
    const list = await readListRow(tx, id);
    if (!list) throw listNotFound();
    // 副单是云端从未存在的新实体：baseVersion 为 null，载荷 version 为 1。
    await enqueueListUpsert(tx, list, null);
    return readListDto(tx, list);
  });
}

export interface ItemWriteInput {
  readonly ingredientName?: string;
  readonly ingredientId?: string | null;
  readonly quantity?: number | null;
  readonly unit?: QuantityUnit | null;
  readonly amountText?: string | null;
  readonly category?: string | null;
  readonly sourceType?: ShoppingSourceType;
  readonly sourceId?: string | null;
  readonly completed?: boolean;
  readonly sortOrder?: number;
  readonly notes?: string | null;
}

/** 数量/单位成对校验：任一缺失即视为自由规格，两者皆空才合法。 */
function resolveStructured(
  quantity: number | null | undefined,
  unit: QuantityUnit | null | undefined,
): { quantity: number | null; unit: QuantityUnit | null } {
  const hasQuantity = quantity !== undefined && quantity !== null;
  const hasUnit = unit !== undefined && unit !== null;
  if (!hasQuantity && !hasUnit) return { quantity: null, unit: null };
  if (hasQuantity !== hasUnit) throw itemInvalid('采购数量与单位必须同时提供或同时为空');
  const value = Number(quantity);
  if (!Number.isFinite(value) || value <= 0) throw itemInvalid('采购数量必须是大于 0 的有限数');
  if (!isQuantityUnit(unit)) throw itemInvalid('采购单位不是受支持的单位');
  return { quantity: roundQuantity(value), unit };
}

export interface AddItemInput extends ItemWriteInput {
  readonly version: number;
}

/** `POST /shopping-lists/:id/items`：一次版本推进 + 单条清单 upsert。 */
export async function addShoppingItem(
  ctx: ShoppingServiceContext,
  listId: string,
  input: AddItemInput,
): Promise<ReturnType<typeof toShoppingListDto>> {
  const name = (input.ingredientName ?? '').trim();
  if (!name) throw itemInvalid('采购物品名称与规格不能为空');
  const structured = resolveStructured(input.quantity, input.unit);
  const sourceType = input.sourceType ?? 'MANUAL';
  if (!(SHOPPING_SOURCE_TYPES as readonly string[]).includes(sourceType)) {
    throw itemInvalid('采购来源类型不受支持');
  }
  const timestamp = ctx.now().toISOString();
  const nextId = idFactory(ctx);
  return ctx.database.withWriteTransaction(async (tx) => {
    const list = await readListRow(tx, listId);
    if (!list) throw listNotFound();
    if (list.version !== input.version) {
      throw new VersionConflictError('ShoppingList', listId, input.version, list.version);
    }
    const baseItems = await itemBaseSnapshot(tx, listId);
    const id = nextId();
    const sortOrder = input.sortOrder ?? (await nextSortOrder(tx, listId));
    await tx.run(
      `INSERT INTO "ShoppingListItem"
        ("id", "shoppingListId", "ingredientId", "ingredientNameSnapshot", "quantity", "unit", "amountText",
         "category", "sourceType", "sourceId", "completed", "sortOrder", "notes", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        listId,
        input.ingredientId ?? null,
        name,
        structured.quantity,
        structured.unit,
        input.amountText ?? null,
        input.category ?? null,
        sourceType,
        input.sourceId ?? null,
        input.completed ? 1 : 0,
        sortOrder,
        input.notes ?? null,
        timestamp,
        timestamp,
      ],
    );
    const next = await bumpListVersion(tx, listId, input.version, timestamp);
    await enqueueListUpsert(tx, next, input.version, baseItems);
    return readListDto(tx, next);
  });
}

export interface UpdateItemInput extends ItemWriteInput {
  readonly version: number;
}

/**
 * `PUT /shopping-list-items/:id`：只改显式提供的字段。
 * 显式写回结构化数量/单位而未带 `amountText` 时清空过期的自由规格原文（对齐适配器语义）。
 */
export async function updateShoppingItem(
  ctx: ShoppingServiceContext,
  itemId: string,
  input: UpdateItemInput,
): Promise<ReturnType<typeof toShoppingListDto>> {
  const timestamp = ctx.now().toISOString();
  return ctx.database.withWriteTransaction(async (tx) => {
    const [item] = await tx.query<ShoppingListItemRow>(
      'SELECT * FROM "ShoppingListItem" WHERE "id" = ?',
      [itemId],
    );
    if (!item) throw itemNotFound();
    const list = await readListRow(tx, item.shoppingListId);
    if (!list) throw listNotFound();
    if (list.version !== input.version) {
      throw new VersionConflictError('ShoppingList', list.id, input.version, list.version);
    }
    const baseItems = await itemBaseSnapshot(tx, list.id);

    const assignments: string[] = [];
    const values: SqlValue[] = [];
    if (input.ingredientName !== undefined) {
      const name = (input.ingredientName ?? '').trim();
      if (!name) throw itemInvalid('采购物品名称不能为空');
      assignments.push('"ingredientNameSnapshot" = ?');
      values.push(name);
    }
    if (input.quantity !== undefined || input.unit !== undefined) {
      const structured = resolveStructured(input.quantity, input.unit);
      assignments.push('"quantity" = ?', '"unit" = ?');
      values.push(structured.quantity, structured.unit);
      if (input.amountText === undefined) assignments.push('"amountText" = NULL');
    }
    if (input.amountText !== undefined) {
      assignments.push('"amountText" = ?');
      values.push(input.amountText);
    }
    if (input.category !== undefined) {
      assignments.push('"category" = ?');
      values.push(input.category);
    }
    if (input.ingredientId !== undefined) {
      assignments.push('"ingredientId" = ?');
      values.push(input.ingredientId);
    }
    if (input.completed !== undefined) {
      assignments.push('"completed" = ?');
      values.push(input.completed ? 1 : 0);
    }
    if (input.sortOrder !== undefined) {
      if (!Number.isInteger(input.sortOrder)) throw itemInvalid('排序值必须是整数');
      assignments.push('"sortOrder" = ?');
      values.push(input.sortOrder);
    }
    if (input.notes !== undefined) {
      assignments.push('"notes" = ?');
      values.push(input.notes);
    }
    if (!assignments.length) throw itemInvalid('没有需要更新的字段');

    assignments.push('"updatedAt" = ?');
    values.push(timestamp);
    await tx.run(`UPDATE "ShoppingListItem" SET ${assignments.join(', ')} WHERE "id" = ?`, [
      ...values,
      itemId,
    ]);
    const next = await bumpListVersion(tx, list.id, input.version, timestamp);
    await enqueueListUpsert(tx, next, input.version, baseItems);
    return readListDto(tx, next);
  });
}

/** `DELETE /shopping-list-items/:id?version=`：硬删除（该表无软删列）+ 一次版本推进。 */
export async function deleteShoppingItem(
  ctx: ShoppingServiceContext,
  itemId: string,
  version: number,
): Promise<{ id: string; deleted: true }> {
  const timestamp = ctx.now().toISOString();
  return ctx.database.withWriteTransaction(async (tx) => {
    const [item] = await tx.query<ShoppingListItemRow>(
      'SELECT * FROM "ShoppingListItem" WHERE "id" = ?',
      [itemId],
    );
    if (!item) throw itemNotFound();
    const list = await readListRow(tx, item.shoppingListId);
    if (!list) throw listNotFound();
    if (list.version !== version) {
      throw new VersionConflictError('ShoppingList', list.id, version, list.version);
    }
    const baseItems = await itemBaseSnapshot(tx, list.id);
    await tx.run('DELETE FROM "ShoppingListItem" WHERE "id" = ?', [itemId]);
    const next = await bumpListVersion(tx, list.id, version, timestamp);
    await enqueueListUpsert(tx, next, version, baseItems);
    return { id: itemId, deleted: true as const };
  });
}

/** `POST /shopping-lists/:id/clear-completed`：返回 `{ list, cleared }`；无清理时不推进版本。 */
export async function clearCompletedItems(
  ctx: ShoppingServiceContext,
  listId: string,
  version: number,
): Promise<{ list: ReturnType<typeof toShoppingListDto>; cleared: number }> {
  const timestamp = ctx.now().toISOString();
  return ctx.database.withWriteTransaction(async (tx) => {
    const list = await readListRow(tx, listId);
    if (!list) throw listNotFound();
    if (list.version !== version) {
      throw new VersionConflictError('ShoppingList', listId, version, list.version);
    }
    const baseItems = await itemBaseSnapshot(tx, listId);
    const removed = await tx.run(
      'DELETE FROM "ShoppingListItem" WHERE "shoppingListId" = ? AND "completed" = 1',
      [listId],
    );
    const cleared = removed.changes;
    if (cleared === 0) return { list: await readListDto(tx, list), cleared };
    const next = await bumpListVersion(tx, listId, version, timestamp);
    await enqueueListUpsert(tx, next, version, baseItems);
    return { list: await readListDto(tx, next), cleared };
  });
}

export interface ReplenishItemInput {
  readonly ingredientId?: string | null;
  readonly ingredientName: string;
  readonly quantity?: number | null;
  readonly unit?: QuantityUnit | null;
  readonly amountText?: string | null;
  readonly category?: string | null;
  readonly notes?: string | null;
}

export interface ReplenishInput {
  readonly version: number;
  readonly recipeId: string;
  readonly items: readonly ReplenishItemInput[];
}

/**
 * `POST /shopping-lists/:id/replenish-recipe`：菜谱缺料批量补齐。
 *
 * 对齐规则（D5）：
 * - 同菜谱（sourceId = recipeId）同食材的行视为同一需求，更新为最新差额，不新增重复行；
 * - 跨菜谱与手工项（不同 sourceId / 不同来源）保持独立行，绝不被覆盖；
 * - 整批只推进一次清单版本，只写一条清单 upsert。
 */
export async function replenishRecipe(
  ctx: ShoppingServiceContext,
  listId: string,
  input: ReplenishInput,
): Promise<ReturnType<typeof toShoppingListDto>> {
  const recipeId = (input.recipeId ?? '').trim();
  if (!recipeId) throw new LocalApiError(422, 'SHOPPING_RECIPE_REQUIRED', '菜谱 ID 不能为空');
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw itemInvalid('补货项目不能为空');
  }
  const normalized = input.items.map((item) => {
    const name = (item.ingredientName ?? '').trim();
    if (!name) throw itemInvalid('补货食材名称不能为空');
    const structured = resolveStructured(item.quantity, item.unit);
    return {
      ingredientId: item.ingredientId ?? null,
      name,
      ...structured,
      amountText: item.amountText ?? null,
      category: item.category?.trim() || null,
      notes: item.notes?.trim() || null,
    };
  });
  const timestamp = ctx.now().toISOString();
  const nextId = idFactory(ctx);
  return ctx.database.withWriteTransaction(async (tx) => {
    const list = await readListRow(tx, listId);
    if (!list) throw listNotFound();
    if (list.version !== input.version) {
      throw new VersionConflictError('ShoppingList', listId, input.version, list.version);
    }
    if (list.status !== 'ACTIVE')
      throw new LocalApiError(409, 'CONFLICT', '仅进行中的购物清单支持补齐缺料');
    const baseItems = await itemBaseSnapshot(tx, listId);
    let sortOrder = await nextSortOrder(tx, listId);
    const keyFor = (ingredientId: string | null, name: string) =>
      ingredientId ? `id:${ingredientId}` : `name:${normalizeName(name)}`;
    const byKey = new Map<string, (typeof normalized)[number]>();
    for (const item of normalized) {
      const [ingredient] = item.ingredientId
        ? await tx.query<{ id: string }>(
            'SELECT "id" FROM "Ingredient" WHERE "id" = ? AND "deletedAt" IS NULL',
            [item.ingredientId],
          )
        : [];
      const ingredientId = ingredient?.id ?? null;
      byKey.set(keyFor(ingredientId, item.name), { ...item, ingredientId });
    }
    const rows = await tx.query<ShoppingListItemRow>(
      `SELECT * FROM "ShoppingListItem" WHERE "shoppingListId" = ? AND "sourceType" = 'RECIPE'
       AND "sourceId" = ? AND "completed" = 0 ORDER BY ${ITEM_ORDER}`,
      [listId, recipeId],
    );
    for (const [key, item] of byKey) {
      const existing = rows.find(
        (row) => keyFor(row.ingredientId, row.ingredientNameSnapshot) === key,
      );
      if (existing) {
        await tx.run(
          `UPDATE "ShoppingListItem" SET
             "ingredientId" = ?, "ingredientNameSnapshot" = ?, "quantity" = ?, "unit" = ?,
             "amountText" = ?, "category" = ?, "notes" = ?, "updatedAt" = ?
           WHERE "id" = ?`,
          [
            item.ingredientId,
            item.name,
            item.quantity,
            item.unit,
            item.amountText,
            item.category ?? existing.category,
            item.notes ?? existing.notes,
            timestamp,
            existing.id,
          ],
        );
        continue;
      }
      await tx.run(
        `INSERT INTO "ShoppingListItem"
          ("id", "shoppingListId", "ingredientId", "ingredientNameSnapshot", "quantity", "unit", "amountText",
           "category", "sourceType", "sourceId", "completed", "sortOrder", "notes", "createdAt", "updatedAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RECIPE', ?, 0, ?, ?, ?, ?)`,

        [
          nextId(),
          listId,
          item.ingredientId,
          item.name,
          item.quantity,
          item.unit,
          item.amountText,
          item.category,
          recipeId,
          sortOrder,
          item.notes,
          timestamp,
          timestamp,
        ],
      );
      sortOrder += 1;
    }
    const next = await bumpListVersion(tx, listId, input.version, timestamp);
    await enqueueListUpsert(tx, next, input.version, baseItems);
    return readListDto(tx, next);
  });
}

export interface CheckinInput {
  readonly version: number;
  readonly operationId: string;
  readonly itemIds: readonly string[];
}

export interface CheckinResult {
  readonly list: ReturnType<typeof toShoppingListDto>;
  readonly imported: {
    readonly operationId: string;
    readonly itemIds: readonly string[];
    readonly inventory: readonly ShoppingCheckinInventoryFactPayload[];
  };
}

const OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

async function hashCheckinRequest(listId: string, itemIds: readonly string[]): Promise<string> {
  const canonical = JSON.stringify({ shoppingListId: listId, itemIds: [...itemIds] });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface OperationRow {
  readonly id: string;
  readonly shoppingListId: string;
  readonly payloadHash: string;
  readonly resultJson: string;
  readonly createdAt: string;
}

/** 名称精确唯一匹配（绝不使用子串），与适配器补货匹配口径一致。 */
async function findMatchIngredient(
  tx: WriteTransaction,
  item: ShoppingListItemRow,
): Promise<IngredientRow | null> {
  if (item.ingredientId) {
    const [byId] = await tx.query<IngredientRow>(
      'SELECT * FROM "Ingredient" WHERE "id" = ? AND "deletedAt" IS NULL',
      [item.ingredientId],
    );
    if (byId) return byId;
  }
  const candidates = await tx.query<IngredientRow>(
    'SELECT * FROM "Ingredient" WHERE "deletedAt" IS NULL',
  );
  const target = normalizeName(item.ingredientNameSnapshot);
  const matched = candidates.filter((row) => normalizeName(row.name) === target);
  return matched.length === 1 ? matched[0]! : null;
}

/**
 * 既有食材与本次入库单位的关系判定。
 *
 * - 可换算：直接累加，不需要动基础单位；
 * - 不可换算但有库存：整单 422（不静默换算，也不悄悄改写库存单位）；
 * - 不可换算且空库存：允许把基础单位对齐为本次真实单位，返回 true 交调用方刷新内存态后重算。
 */
async function unitNeedsReset(
  tx: WriteTransaction,
  ingredient: IngredientRow,
  unit: QuantityUnit,
  name: string,
): Promise<boolean> {
  if (convertQuantity(1, unit, ingredient.unit) !== null) return false;
  const activeBatches = await loadBatches(tx, ingredient.id);
  const hasStock = ingredient.quantity > 0 || activeBatches.some((batch) => batch.quantity > 0);
  if (hasStock) {
    throw checkinQuantityInvalid(`「${name}」的单位与现有库存「${ingredient.name}」不兼容`);
  }
  return true;
}

/**
 * `POST /shopping-lists/:id/check-in`：勾选买完 + 入库冰箱（同事务、幂等）。
 *
 * - 所有条目必须已具备结构化数量与标准单位，否则整单 422 且零写入；
 * - 复用既有食材时单位必须可换算；无库存的历史食材允许直接对齐单位；
 * - 每个条目写一条 PURCHASE 批次与库存日志，主键固定进 `SHOPPING_CHECKIN` 载荷；
 * - `ShoppingCheckinOperation` 以 operationId 幂等；同 ID 不同内容返回 409。
 */
export async function checkInShoppingItems(
  ctx: ShoppingServiceContext,
  listId: string,
  input: CheckinInput,
): Promise<CheckinResult> {
  const operationId = (input.operationId ?? '').trim();
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw checkinQuantityInvalid('入库操作 ID 格式无效');
  }
  if (!Array.isArray(input.itemIds) || input.itemIds.length === 0) {
    throw checkinQuantityInvalid('请先勾选已采购的物品再入库');
  }
  const itemIds = [...input.itemIds];
  if (new Set(itemIds).size !== itemIds.length) {
    throw checkinQuantityInvalid('入库条目 ID 不能重复');
  }
  itemIds.sort();
  const requestHash = await hashCheckinRequest(listId, itemIds);
  const now = ctx.now();
  const purchaseDate = localDate(now);
  const timestamp = now.toISOString();
  const nextId = idFactory(ctx);

  return ctx.database.withWriteTransaction(async (tx) => {
    const [existingOperation] = await tx.query<OperationRow>(
      'SELECT * FROM "ShoppingCheckinOperation" WHERE "id" = ?',
      [operationId],
    );
    if (existingOperation) {
      if (
        existingOperation.shoppingListId !== listId ||
        existingOperation.payloadHash !== requestHash
      ) {
        throw new LocalApiError(409, 'IDEMPOTENCY_CONFLICT', '入库操作 ID 已用于不同内容', {
          details: { operationId },
        });
      }
      return JSON.parse(existingOperation.resultJson) as CheckinResult;
    }

    const list = await readListRow(tx, listId);
    if (!list) throw listNotFound();
    if (list.version !== input.version) {
      throw new VersionConflictError('ShoppingList', listId, input.version, list.version);
    }

    const rows = await tx.query<ShoppingListItemRow>(
      `SELECT * FROM "ShoppingListItem" WHERE "shoppingListId" = ?`,
      [listId],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const selected: ShoppingListItemRow[] = [];
    for (const id of itemIds) {
      const row = byId.get(id);
      if (!row) throw itemNotFound();
      selected.push(row);
    }
    // 先整批校验，再开始任何写操作：任意一条不合格都必须零写入。
    for (const row of selected) {
      if (!isStructuredQuantity(row.quantity, row.unit)) {
        throw checkinQuantityInvalid(
          `「${row.ingredientNameSnapshot}」缺少结构化数量或单位，无法入库`,
        );
      }
    }
    // 先整批只读校验一次：任意一条已知食材单位不兼容即整单 422（写入前的快速失败）。
    // 循环内还会按最新状态复核（含同单前序新建的同名食材）。
    for (const row of selected) {
      const matched = await findMatchIngredient(tx, row);
      if (!matched) continue;
      await unitNeedsReset(tx, matched, row.unit as QuantityUnit, row.ingredientNameSnapshot);
    }

    const inventory: ShoppingCheckinInventoryFactPayload[] = [];
    for (const row of selected) {
      const quantity = row.quantity as number;
      const unit = row.unit as QuantityUnit;
      const name = row.ingredientNameSnapshot;
      // 每行按当前库状态重新匹配：同单前序新建的同名食材要被后续行累加，
      // 既有食材也要读取最新版本，避免同批重复入库产生重复食材或使用旧 version。
      let ingredient = await findMatchIngredient(tx, row);
      let createdIngredient = false;
      let ingredientBaseVersion: number | null = null;
      if (ingredient) {
        const resetUnit = await unitNeedsReset(tx, ingredient, unit, name);
        if (resetUnit) {
          // 空库存 + 单位不可换算：把基础单位对齐为本批次真实单位，避免入库数量丢失。
          await tx.run('UPDATE "Ingredient" SET "unit" = ?, "updatedAt" = ? WHERE "id" = ?', [
            unit,
            timestamp,
            ingredient.id,
          ]);
        }
        // 换单位后必须刷新内存态，后续库存汇总才按新基础单位计算。
        const [latest] = await tx.query<IngredientRow>(
          'SELECT * FROM "Ingredient" WHERE "id" = ? AND "deletedAt" IS NULL',
          [ingredient.id],
        );
        if (!latest) throw itemInvalid('入库食材已被删除，请刷新后重试');
        ingredient = latest;
        ingredientBaseVersion = latest.version;
        // 历史存量（quantity > 0 但无活批次）先真实补建，避免入库后汇总数量丢失。
        const activeBatches = await loadBatches(tx, ingredient.id);
        const healed = await persistImplicitBatch(
          tx,
          {
            ingredientId: ingredient.id,
            name: ingredient.name,
            quantity: ingredient.quantity,
            unit: ingredient.unit,
            purchaseDate: ingredient.purchaseDate,
            expiryDate: ingredient.expiryDate,
            location: ingredient.location,
            opened: ingredient.opened === 1 || ingredient.opened === true,
          },
          activeBatches,
          now,
          nextId,
        );
        if (healed) {
          inventory.push({
            kind: 'LEGACY_HEAL',
            createdIngredient: false,
            ingredientId: ingredient.id,
            ingredientNameSnapshot: ingredient.name,
            ingredientUnit: ingredient.unit,
            ingredientQuantity: ingredient.quantity,
            // 补建历史批次不推进食材版本：前后版本一致。
            ingredientBaseVersion: ingredient.version,
            ingredientVersion: ingredient.version,
            ingredientCategory: normalizeIngredientCategory(ingredient.category, ingredient.name),
            batchId: healed.batchId,
            batchQuantity: healed.quantity,
            batchUnit: healed.unit,
            logId: healed.logId,
            beforeQuantity: 0,
            afterQuantity: healed.quantity,
            executedAt: timestamp,
          });
        }
      } else {
        const ingredientId = nextId();
        await tx.run(
          `INSERT INTO "Ingredient"
            ("id", "name", "imagePath", "category", "quantity", "unit", "purchaseDate", "expiryDate",
             "location", "minStock", "maxStock", "opened", "notes", "version", "deletedAt", "createdAt", "updatedAt")
           VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, NULL, 1, NULL, ?, ?)`,
          [
            ingredientId,
            name,
            normalizeIngredientCategory(row.category, name),
            quantity,
            unit,
            purchaseDate,
            timestamp,
            timestamp,
          ],
        );
        const [createdRow] = await tx.query<IngredientRow>(
          'SELECT * FROM "Ingredient" WHERE "id" = ?',
          [ingredientId],
        );
        ingredient = createdRow!;
        createdIngredient = true;
      }

      const batchId = nextId();
      await tx.run(
        `INSERT INTO "InventoryBatch"
          ("id", "ingredientId", "quantity", "unit", "purchaseDate", "expiryDate", "location", "opened",
           "consumePriority", "notes", "version", "deletedAt", "createdAt", "updatedAt")
         VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, 0, NULL, 1, NULL, ?, ?)`,
        [batchId, ingredient.id, quantity, unit, purchaseDate, timestamp, timestamp],
      );
      const logId = await insertLog(
        tx,
        {
          ingredientId: ingredient.id,
          ingredientNameSnapshot: ingredient.name,
          inventoryBatchId: batchId,
          beforeQuantity: 0,
          changeQuantity: quantity,
          afterQuantity: quantity,
          unit,
          changeType: 'PURCHASE',
          notes: '购物清单入库',
          now,
        },
        nextId,
      );

      const batches = await loadBatches(tx, ingredient.id);
      const summary = summarizeBatchMeta(batches);
      const total = summarizeQuantity(batches, ingredient.unit);
      const finalCategory = row.category
        ? normalizeIngredientCategory(row.category, ingredient.name)
        : normalizeIngredientCategory(ingredient.category, ingredient.name);
      // 首次入库的新食材保留 v1（版本链起点）；既有食材按乐观锁 +1。
      const nextVersion = createdIngredient ? ingredient.version : ingredient.version + 1;
      const updated = await tx.run(
        `UPDATE "Ingredient" SET
           "quantity" = ?, "purchaseDate" = ?, "expiryDate" = ?, "location" = ?, "category" = ?,
           "version" = ?, "updatedAt" = ?
         WHERE "id" = ? AND "version" = ? AND "deletedAt" IS NULL`,
        [
          total,
          summary.purchaseDate ?? purchaseDate,
          summary.expiryDate ?? ingredient.expiryDate,
          summary.location ?? ingredient.location,
          finalCategory,
          nextVersion,
          timestamp,
          ingredient.id,
          ingredient.version,
        ],
      );
      if (updated.changes !== 1) {
        throw new VersionConflictError(
          'Ingredient',
          ingredient.id,
          ingredient.version,
          ingredient.version + 1,
        );
      }
      inventory.push({
        kind: 'INGREDIENT_IMPORT',
        createdIngredient,
        ingredientId: ingredient.id,
        ingredientNameSnapshot: ingredient.name,
        ingredientUnit: ingredient.unit,
        ingredientQuantity: total,
        ingredientBaseVersion,
        ingredientVersion: nextVersion,
        ingredientCategory: finalCategory,
        batchId,
        batchQuantity: quantity,
        batchUnit: unit,
        logId,
        beforeQuantity: 0,
        afterQuantity: quantity,
        executedAt: timestamp,
      });
    }

    const removed = await tx.run(
      `DELETE FROM "ShoppingListItem" WHERE "shoppingListId" = ? AND "id" IN (${itemIds.map(() => '?').join(', ')})`,
      [listId, ...itemIds],
    );
    if (removed.changes !== itemIds.length) {
      throw checkinQuantityInvalid('入库条目已变化，请刷新后重试');
    }
    const next = await bumpListVersion(tx, listId, input.version, timestamp);

    const committedRows = await tx.query<ShoppingListItemRow>(
      `SELECT * FROM "ShoppingListItem" WHERE "shoppingListId" = ? ORDER BY ${ITEM_ORDER}`,
      [listId],
    );
    const result: CheckinResult = {
      list: toShoppingListDto(next, committedRows),
      imported: { operationId, itemIds, inventory },
    };
    const resultJson = JSON.stringify(result);
    await tx.run(
      `INSERT INTO "ShoppingCheckinOperation" ("id", "shoppingListId", "payloadHash", "resultJson", "createdAt")
       VALUES (?, ?, ?, ?, ?)`,
      [operationId, listId, requestHash, resultJson, timestamp],
    );

    const payload: ShoppingCheckinCommandPayload = {
      shoppingListId: listId,
      baseVersion: input.version,
      executedAt: timestamp,
      listVersion: next.version,
      purchaseDate,
      request: { shoppingListId: listId, baseVersion: input.version, operationId, itemIds },
      items: selected.map(toItemFact),
      inventory,
      operation: {
        id: operationId,
        shoppingListId: listId,
        payloadHash: requestHash,
        resultJson,
        createdAt: timestamp,
      },
    };
    // `ShoppingList` 命令类型已由 db 层 `SYNC_COMMAND_ENTITIES` 开通，无需窄化。
    await tx.enqueue({
      opId: newLocalId(),
      entity: 'ShoppingList',
      entityId: listId,
      kind: 'command',
      commandType: 'SHOPPING_CHECKIN',
      baseVersion: input.version,
      payload: { ...payload } as unknown as Record<string, unknown>,
    });

    return result;
  });
}

/** 供路由层复用：把 body 中的字符串/数字统一收敛。 */
export function requireListVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw validationError('version 必须为正整数');
  }
  return value;
}

export function parseQuantityUnit(value: unknown): QuantityUnit | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !isQuantityUnit(value)) {
    throw itemInvalid('采购单位不是受支持的单位');
  }
  return value;
}
