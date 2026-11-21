import type { DatabaseClient, WriteTransaction } from '../../db/database.js';
import { VersionConflictError } from '../../db/errors.js';
import type { SqlValue } from '../../db/types.js';
import { LocalApiError } from '../../local-api/protocol.js';
import { sqlBoolean, validationError } from '../common.js';
import {
  insertRecord,
  isBusinessDate,
  isMealRole,
  isMealType,
  loadRecordDto,
  type DinerDto,
  type MealRecordDto,
  type MealRecordItemRow,
  type MealRecordRow,
  type MealRole,
  type MealType,
} from '../meal-records/index.js';
import { newLocalId } from '../meal-records/ids.js';
import { enqueueMealCommand } from '../meal-records/outbox.js';

import {
  MEAL_PLAN_STATUSES,
  PLAN_ITEM_TYPES,
  type MealPlanDto,
  type MealPlanItemDto,
  type MealPlanItemRow,
  type MealPlanRow,
  type MealPlanStatus,
  type PlanInput,
  type PlanItemInput,
  type PlanItemType,
  type PlanPatch,
  type SqlQuery,
} from './types.js';

const PLAN_TITLE_LIMIT = 200;
const PLAN_SUBTEXT_LIMIT = 200;
const PLAN_ICON_LIMIT = 20;
const PLAN_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export interface MealPlanServiceContext {
  readonly database: DatabaseClient;
  readonly now: () => Date;
  readonly newId: () => string;
}

const PLAN_INCLUDE_ITEMS_SQL = `SELECT * FROM "MealPlanItem" WHERE "mealPlanId" = ? ORDER BY "sortOrder" ASC, rowid ASC`;
const PLAN_DINER_ROWS_SQL = `SELECT d.* FROM "MealPlanDiner" pd JOIN "Diner" d ON d."id" = pd."dinerId"
  WHERE pd."mealPlanId" = ? ORDER BY pd.rowid ASC`;

interface EmbeddedRecipeRow {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly imagePath: string | null;
  readonly calories: number | null;
  readonly version: number;
  readonly deletedAt: string | null;
}

interface EmbeddedStoreRow {
  readonly id: string;
  readonly name: string;
  readonly imagePath: string | null;
  readonly supportsDineIn: number | boolean;
  readonly supportsTakeout: number | boolean;
  readonly version: number;
  readonly deletedAt: string | null;
}

interface DinerRow {
  readonly id: string;
  readonly name: string;
  readonly avatarPath: string | null;
  readonly active: number | boolean;
  readonly likesText: string | null;
  readonly dislikesText: string | null;
  readonly tabooText: string | null;
  readonly allergyText: string | null;
  readonly portionNote: string | null;
  readonly notes: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function notFound(): LocalApiError {
  return new LocalApiError(404, 'NOT_FOUND', '计划不存在');
}

function conflict(message: string): LocalApiError {
  return new LocalApiError(409, 'CONFLICT', message);
}

function toDinerDto(row: DinerRow): DinerDto {
  return {
    id: row.id,
    name: row.name,
    avatarPath: row.avatarPath ?? null,
    active: sqlBoolean(row.active),
    likesText: row.likesText ?? null,
    dislikesText: row.dislikesText ?? null,
    tabooText: row.tabooText ?? null,
    allergyText: row.allergyText ?? null,
    portionNote: row.portionNote ?? null,
    notes: row.notes ?? null,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadPlanItems(query: SqlQuery, planId: string): Promise<MealPlanItemDto[]> {
  const rows = await query.query<MealPlanItemRow>(PLAN_INCLUDE_ITEMS_SQL, [planId]);
  const recipeIds = [
    ...new Set(rows.map((row) => row.recipeId).filter((id): id is string => !!id)),
  ];
  const storeIds = [...new Set(rows.map((row) => row.storeId).filter((id): id is string => !!id))];
  const recipes = recipeIds.length
    ? await query.query<EmbeddedRecipeRow>(
        `SELECT "id","name","category","imagePath","calories","version","deletedAt" FROM "Recipe"
         WHERE "id" IN (${recipeIds.map(() => '?').join(', ')})`,
        recipeIds,
      )
    : [];
  const stores = storeIds.length
    ? await query.query<EmbeddedStoreRow>(
        `SELECT "id","name","imagePath","supportsDineIn","supportsTakeout","version","deletedAt" FROM "Store"
         WHERE "id" IN (${storeIds.map(() => '?').join(', ')})`,
        storeIds,
      )
    : [];
  const recipeById = new Map(recipes.map((row) => [row.id, row]));
  const storeById = new Map(stores.map((row) => [row.id, row]));
  return rows.map((row) => {
    const recipe = row.recipeId ? (recipeById.get(row.recipeId) ?? null) : null;
    const store = row.storeId ? (storeById.get(row.storeId) ?? null) : null;
    return {
      id: row.id,
      mealPlanId: row.mealPlanId,
      itemType: row.itemType,
      mealRole: row.mealRole ?? null,
      recipeId: row.recipeId ?? null,
      storeId: row.storeId ?? null,
      customName: row.customName ?? null,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      recipe: recipe
        ? {
            id: recipe.id,
            name: recipe.name,
            category: recipe.category ?? null,
            imagePath: recipe.imagePath ?? null,
            calories: recipe.calories ?? null,
            version: recipe.version,
            deletedAt: recipe.deletedAt ?? null,
          }
        : null,
      store: store
        ? {
            id: store.id,
            name: store.name,
            imagePath: store.imagePath ?? null,
            supportsDineIn: sqlBoolean(store.supportsDineIn),
            supportsTakeout: sqlBoolean(store.supportsTakeout),
            version: store.version,
            deletedAt: store.deletedAt ?? null,
          }
        : null,
    };
  });
}

export function toPlanDto(
  row: MealPlanRow,
  items: MealPlanItemDto[],
  diners: DinerDto[],
): MealPlanDto {
  return {
    id: row.id,
    planDate: row.planDate,
    mealType: row.mealType,
    dinerCount: row.dinerCount,
    status: row.status,
    notes: row.notes ?? null,
    time: row.time ?? null,
    title: row.title ?? null,
    subtext: row.subtext ?? null,
    icon: row.icon ?? null,
    items,
    diners,
    completedAt: row.completedAt ?? null,
    version: row.version,
    deletedAt: row.deletedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function loadPlanDto(query: SqlQuery, id: string): Promise<MealPlanDto | null> {
  const [row] = await query.query<MealPlanRow>(`SELECT * FROM "MealPlan" WHERE "id" = ?`, [id]);
  if (!row) return null;
  const [items, diners] = await Promise.all([
    loadPlanItems(query, id),
    query.query<DinerRow>(PLAN_DINER_ROWS_SQL, [id]),
  ]);
  return toPlanDto(row, items, diners.map(toDinerDto));
}

export function isPlanStatus(value: unknown): value is MealPlanStatus {
  return typeof value === 'string' && (MEAL_PLAN_STATUSES as readonly string[]).includes(value);
}

function isPlanItemType(value: unknown): value is PlanItemType {
  return typeof value === 'string' && (PLAN_ITEM_TYPES as readonly string[]).includes(value);
}

function cleanedText(value: unknown, field: string, limit: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw validationError(`${field}必须是字符串或 null`);
  const text = value.trim();
  if (text.length > limit) throw validationError(`${field}不能超过 ${limit} 个字符`);
  return text || null;
}

function cleanedTime(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw validationError('计划时间必须是字符串或 null');
  const time = value.trim();
  if (!time) return null;
  if (!PLAN_TIME_PATTERN.test(time)) throw validationError('计划时间必须使用 HH:MM 24 小时制格式');
  return time;
}

function parseItems(raw: unknown): PlanItemInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw validationError('items 必须是数组');
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw validationError(`第 ${index + 1} 个计划项目必须是对象`);
    const item = entry as Record<string, unknown>;
    if (!isPlanItemType(item.itemType)) throw validationError('计划项目类型不受支持');
    if (item.mealRole !== undefined && item.mealRole !== null && !isMealRole(item.mealRole))
      throw validationError('计划项目餐次角色不受支持');
    const text = (value: unknown, field: string): string | null => {
      if (value === undefined || value === null) return null;
      if (typeof value !== 'string') throw validationError(`${field}必须是字符串或 null`);
      return value.trim() || null;
    };
    const sortOrder =
      item.sortOrder === undefined
        ? index
        : typeof item.sortOrder === 'number' && Number.isInteger(item.sortOrder)
          ? item.sortOrder
          : (() => {
              throw validationError('sortOrder 必须是整数');
            })();
    return {
      itemType: item.itemType,
      mealRole: (item.mealRole as MealRole | null | undefined) ?? null,
      recipeId: text(item.recipeId, 'recipeId'),
      storeId: text(item.storeId, 'storeId'),
      customName: text(item.customName, 'customName'),
      sortOrder,
    };
  });
}

function validatePlan(input: {
  readonly planDate: string;
  readonly mealType: MealType;
  readonly dinerCount: number;
  readonly items: readonly PlanItemInput[];
}): void {
  if (!isBusinessDate(input.planDate))
    throw validationError('计划日期必须使用 YYYY-MM-DD 格式且为真实日期');
  if (!isMealType(input.mealType)) throw validationError('餐次不受支持');
  if (!Number.isInteger(input.dinerCount) || input.dinerCount < 0)
    throw validationError('食用人数必须是非负整数');
  for (const item of input.items) {
    const links =
      Number(Boolean(item.recipeId)) +
      Number(Boolean(item.storeId)) +
      Number(Boolean(item.customName?.trim()));
    if (links !== 1) throw validationError('每个计划项目必须且只能关联菜谱、店铺或自定义名称之一');
    if (
      (item.itemType === 'RECIPE') !== Boolean(item.recipeId) ||
      (item.itemType === 'STORE') !== Boolean(item.storeId) ||
      (item.itemType === 'CUSTOM') !== Boolean(item.customName?.trim())
    )
      throw validationError('计划项目类型与关联内容不一致');
  }
}

async function assertPlanTargets(
  transaction: WriteTransaction,
  items: readonly PlanItemInput[],
  dinerIds: readonly string[],
): Promise<void> {
  const recipeIds = [
    ...new Set(items.map((item) => item.recipeId).filter((id): id is string => !!id)),
  ];
  const storeIds = [
    ...new Set(items.map((item) => item.storeId).filter((id): id is string => !!id)),
  ];
  if (recipeIds.length) {
    const rows = await transaction.query<{ id: string }>(
      `SELECT "id" FROM "Recipe" WHERE "deletedAt" IS NULL AND "id" IN (${recipeIds.map(() => '?').join(', ')})`,
      recipeIds,
    );
    if (rows.length !== recipeIds.length) throw validationError('计划关联的菜谱不存在或已删除');
  }
  if (storeIds.length) {
    const rows = await transaction.query<{ id: string }>(
      `SELECT "id" FROM "Store" WHERE "deletedAt" IS NULL AND "id" IN (${storeIds.map(() => '?').join(', ')})`,
      storeIds,
    );
    if (rows.length !== storeIds.length) throw validationError('计划关联的店铺不存在或已删除');
  }
  for (const dinerId of [...new Set(dinerIds)]) {
    const [row] = await transaction.query<{ id: string }>(
      `SELECT "id" FROM "Diner" WHERE "id" = ?`,
      [dinerId],
    );
    if (!row) throw validationError('计划关联的食用者不存在');
  }
}

/** 解析写请求体；`forUpdate` 允许部分字段（上游 PUT 语义）。 */
export function parsePlanBody(
  body: Record<string, unknown>,
  options: { readonly forUpdate: boolean },
): { readonly input: Partial<PlanInput>; readonly version?: number } {
  const fields = [
    'planDate',
    'mealType',
    'dinerCount',
    'status',
    'notes',
    'time',
    'title',
    'subtext',
    'icon',
    'items',
    'dinerIds',
  ] as const;
  const allowed = new Set<string>([...fields, ...(options.forUpdate ? ['version'] : [])]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) throw validationError(`请求包含未支持的字段：${unknown.join(', ')}`);

  const input: Record<string, unknown> = {};
  if ('planDate' in body) input.planDate = body.planDate;
  if ('mealType' in body) {
    if (!isMealType(body.mealType)) throw validationError('mealType 不受支持');
    input.mealType = body.mealType;
  }
  if ('dinerCount' in body) {
    if (
      typeof body.dinerCount !== 'number' ||
      !Number.isInteger(body.dinerCount) ||
      body.dinerCount < 0
    )
      throw validationError('食用人数必须是非负整数');
    input.dinerCount = body.dinerCount;
  }
  if ('status' in body) {
    if (!isPlanStatus(body.status)) throw validationError('status 不受支持');
    input.status = body.status;
  }
  if ('notes' in body) input.notes = cleanedText(body.notes, 'notes', 2_000);
  if ('time' in body) input.time = cleanedTime(body.time);
  if ('title' in body) input.title = cleanedText(body.title, '计划标题', PLAN_TITLE_LIMIT);
  if ('subtext' in body)
    input.subtext = cleanedText(body.subtext, '计划副文案', PLAN_SUBTEXT_LIMIT);
  if ('icon' in body) input.icon = cleanedText(body.icon, '计划图标', PLAN_ICON_LIMIT);
  if ('items' in body) input.items = parseItems(body.items);
  if ('dinerIds' in body) {
    if (!Array.isArray(body.dinerIds) || body.dinerIds.some((id) => typeof id !== 'string'))
      throw validationError('dinerIds 必须是字符串数组');
    input.dinerIds = [...new Set(body.dinerIds as string[])];
  }
  if (options.forUpdate) {
    if (typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1)
      throw validationError('version 必须为正整数');
  }
  return {
    input: input as Partial<PlanInput>,
    ...(options.forUpdate ? { version: body.version as number } : {}),
  };
}

async function replacePlanItems(
  transaction: WriteTransaction,
  planId: string,
  items: readonly PlanItemInput[],
  timestamp: string,
  newId: () => string,
): Promise<void> {
  for (const item of items) {
    await transaction.run(
      `INSERT INTO "MealPlanItem"
        ("id","mealPlanId","itemType","mealRole","recipeId","storeId","customName","sortOrder","createdAt","updatedAt")
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        newId(),
        planId,
        item.itemType,
        item.mealRole,
        item.recipeId,
        item.storeId,
        item.customName,
        item.sortOrder,
        timestamp,
        timestamp,
      ],
    );
  }
}

async function replacePlanDiners(
  transaction: WriteTransaction,
  planId: string,
  dinerIds: readonly string[],
  timestamp: string,
  newId: () => string,
): Promise<void> {
  for (const dinerId of [...new Set(dinerIds)]) {
    await transaction.run(
      `INSERT INTO "MealPlanDiner" ("id","mealPlanId","dinerId","createdAt","updatedAt")
       VALUES (?,?,?,?,?)`,
      [newId(), planId, dinerId, timestamp, timestamp],
    );
  }
}

export async function listPlans(
  database: SqlQuery,
  query: { readonly from?: string; readonly to?: string; readonly status?: MealPlanStatus },
): Promise<MealPlanDto[]> {
  const clauses = ['"deletedAt" IS NULL'];
  const values: SqlValue[] = [];
  if (query.from) {
    clauses.push('"planDate" >= ?');
    values.push(query.from);
  }
  if (query.to) {
    clauses.push('"planDate" <= ?');
    values.push(query.to);
  }
  if (query.status) {
    clauses.push('"status" = ?');
    values.push(query.status);
  }
  const rows = await database.query<MealPlanRow>(
    `SELECT * FROM "MealPlan" WHERE ${clauses.join(' AND ')}
     ORDER BY "planDate" ASC, "mealType" ASC, "id" ASC`,
    values,
  );
  const plans = await Promise.all(rows.map((row) => loadPlanDto(database, row.id)));
  return plans.filter((plan): plan is MealPlanDto => plan !== null);
}

export async function getPlan(database: SqlQuery, id: string): Promise<MealPlanDto> {
  const plan = await loadPlanDto(database, id);
  if (!plan || plan.deletedAt !== null) throw notFound();
  return plan;
}

/**
 * 新建计划。
 *
 * 端侧不再复用墓碑行：软删计划保留原 ID，同日同餐重新建计划生成新随机 ID
 * （`version = 1`, `baseVersion: null`）；仅在活跃计划已占用（日期、餐次）时返回 409。
 */
export async function createPlan(
  context: MealPlanServiceContext,
  input: PlanInput,
): Promise<MealPlanDto> {
  validatePlan(input);
  if (input.status === 'COMPLETED' || input.status === 'CANCELLED')
    throw validationError('新计划只能是未安排或已安排状态');
  const now = context.now();
  const timestamp = now.toISOString();
  return context.database.withWriteTransaction(async (transaction) => {
    await assertPlanTargets(transaction, input.items, input.dinerIds);
    const [active] = await transaction.query<{ id: string }>(
      `SELECT "id" FROM "MealPlan" WHERE "planDate" = ? AND "mealType" = ? AND "deletedAt" IS NULL`,
      [input.planDate, input.mealType],
    );
    if (active) throw conflict('该日期和餐次已存在计划');
    const planId = context.newId();
    await transaction.run(
      `INSERT INTO "MealPlan"
        ("id","planDate","mealType","dinerCount","status","notes","time","title","subtext","icon",
         "version","completedAt","deletedAt","createdAt","updatedAt")
       VALUES (?,?,?,?,?,?,?,?,?,?,1,NULL,NULL,?,?)`,
      [
        planId,
        input.planDate,
        input.mealType,
        input.dinerCount,
        input.status,
        input.notes,
        input.time,
        input.title,
        input.subtext,
        input.icon,
        timestamp,
        timestamp,
      ],
    );
    await replacePlanItems(transaction, planId, input.items, timestamp, context.newId);
    await replacePlanDiners(transaction, planId, input.dinerIds, timestamp, context.newId);
    const plan = await loadPlanDto(transaction, planId);
    if (!plan) throw new LocalApiError(500, 'INTERNAL_ERROR', '计划创建后读取失败');
    await transaction.enqueue({
      opId: context.newId(),
      entity: 'MealPlan',
      entityId: planId,
      kind: 'upsert',
      baseVersion: null,
      payload: plan as unknown as Record<string, unknown>,
    });
    return plan;
  });
}

/** 更新计划：状态迁移约束与上游一致，冲突检测只拦活跃计划。 */
export async function updatePlan(
  context: MealPlanServiceContext,
  id: string,
  version: number,
  patch: PlanPatch,
): Promise<MealPlanDto> {
  const now = context.now();
  const timestamp = now.toISOString();
  return context.database.withWriteTransaction(async (transaction) => {
    const [current] = await transaction.query<MealPlanRow>(
      `SELECT * FROM "MealPlan" WHERE "id" = ? AND "deletedAt" IS NULL`,
      [id],
    );
    if (!current) throw notFound();
    if (current.version !== version)
      throw new VersionConflictError('MealPlan', id, version, current.version);
    if (current.status === 'COMPLETED') throw conflict('已完成计划不能修改');
    if (current.status === 'CANCELLED' && patch.status !== 'CANCELLED')
      throw conflict('已取消计划不能恢复为其他状态');
    if (patch.status === 'COMPLETED') throw conflict('请使用完成计划操作，不能直接修改为已完成');
    if (current.status === 'PLANNED' && patch.status === 'UNPLANNED')
      throw conflict('已安排计划不能退回未安排');

    const merged = {
      planDate: patch.planDate ?? current.planDate,
      mealType: patch.mealType ?? current.mealType,
      dinerCount: patch.dinerCount ?? current.dinerCount,
      status: patch.status ?? current.status,
      notes: patch.notes === undefined ? current.notes : patch.notes,
      time: patch.time === undefined ? current.time : patch.time,
      title: patch.title === undefined ? current.title : patch.title,
      subtext: patch.subtext === undefined ? current.subtext : patch.subtext,
      icon: patch.icon === undefined ? current.icon : patch.icon,
      items: patch.items,
    };
    validatePlan({
      planDate: merged.planDate,
      mealType: merged.mealType,
      dinerCount: merged.dinerCount,
      items: merged.items ?? [],
    });
    if (merged.planDate !== current.planDate || merged.mealType !== current.mealType) {
      const [clashing] = await transaction.query<{ id: string }>(
        `SELECT "id" FROM "MealPlan" WHERE "planDate" = ? AND "mealType" = ? AND "deletedAt" IS NULL`,
        [merged.planDate, merged.mealType],
      );
      if (clashing && clashing.id !== id) throw conflict('该日期和餐次已存在计划');
    }
    if (patch.items) {
      await assertPlanTargets(transaction, patch.items, patch.dinerIds ?? []);
      await transaction.run(`DELETE FROM "MealPlanItem" WHERE "mealPlanId" = ?`, [id]);
    }
    if (patch.dinerIds) {
      await assertPlanTargets(transaction, [], patch.dinerIds);
      await transaction.run(`DELETE FROM "MealPlanDiner" WHERE "mealPlanId" = ?`, [id]);
    }
    const updated = await transaction.run(
      `UPDATE "MealPlan" SET
         "planDate" = ?, "mealType" = ?, "dinerCount" = ?, "status" = ?, "notes" = ?, "time" = ?,
         "title" = ?, "subtext" = ?, "icon" = ?, "version" = "version" + 1, "updatedAt" = ?
       WHERE "id" = ? AND "version" = ? AND "deletedAt" IS NULL`,
      [
        merged.planDate,
        merged.mealType,
        merged.dinerCount,
        merged.status,
        merged.notes,
        merged.time,
        merged.title,
        merged.subtext,
        merged.icon,
        timestamp,
        id,
        version,
      ],
    );
    if (updated.changes !== 1)
      throw new VersionConflictError('MealPlan', id, version, current.version + 1);
    if (patch.items) await replacePlanItems(transaction, id, patch.items, timestamp, context.newId);
    if (patch.dinerIds)
      await replacePlanDiners(transaction, id, patch.dinerIds, timestamp, context.newId);
    const plan = await loadPlanDto(transaction, id);
    if (!plan) throw notFound();
    await transaction.enqueue({
      opId: context.newId(),
      entity: 'MealPlan',
      entityId: id,
      kind: 'upsert',
      baseVersion: version,
      payload: plan as unknown as Record<string, unknown>,
    });
    return plan;
  });
}

export async function deletePlan(
  context: MealPlanServiceContext,
  id: string,
  version: number,
): Promise<{ id: string }> {
  const timestamp = context.now().toISOString();
  return context.database.withWriteTransaction(async (transaction) => {
    const [current] = await transaction.query<MealPlanRow>(
      `SELECT * FROM "MealPlan" WHERE "id" = ? AND "deletedAt" IS NULL`,
      [id],
    );
    if (!current) throw notFound();
    if (current.version !== version)
      throw new VersionConflictError('MealPlan', id, version, current.version);
    if (current.status === 'COMPLETED') throw conflict('已完成计划已关联饮食记录，不能删除');
    await transaction.run(
      `UPDATE "MealPlan" SET "deletedAt" = ?, "version" = "version" + 1, "updatedAt" = ?
       WHERE "id" = ? AND "version" = ?`,
      [timestamp, timestamp, id, version],
    );
    await transaction.enqueue({
      opId: context.newId(),
      entity: 'MealPlan',
      entityId: id,
      kind: 'delete',
      baseVersion: version,
      payload: { deletedAt: timestamp },
    });
    return { id };
  });
}

// ---------------------------------------------------------------------------
// 完成 / 撤销完成：provenance 与确定性命令
// ---------------------------------------------------------------------------

interface PlanUncompleteSnapshot {
  readonly recordDate: string;
  readonly recordTime: string | null;
  readonly mealType: string;
  readonly sourceType: string;
  readonly title: string | null;
  readonly imagePath: string | null;
  readonly photosJson: string | null;
  readonly rating: number | null;
  readonly satiety: number | null;
  readonly calories: number | null;
  readonly cost: number | null;
  readonly isNewTry: boolean;
  readonly favorite: boolean;
  readonly notes: string | null;
  readonly relatedPlanId: string | null;
  readonly sourceMealPlanId: string | null;
  readonly status: string;
  readonly items: ReadonlyArray<{
    readonly itemType: string;
    readonly mealRole: MealRole | null;
    readonly recipeId: string | null;
    readonly storeId: string | null;
    readonly customName: string | null;
    readonly sortOrder: number;
  }>;
  readonly dinerIds: ReadonlyArray<string | null>;
}

interface PlanUncompleteProof {
  readonly origin: 'PLAN_UNCOMPLETE';
  readonly sourcePlanId: string;
  readonly sourceRecordId: string;
  readonly sourcePlanVersion: number;
  readonly sourceRecordVersion: number;
  readonly snapshot: PlanUncompleteSnapshot;
}

function snapshotOf(
  record: MealRecordRow,
  items: readonly MealRecordItemRow[],
  dinerIds: ReadonlyArray<string | null>,
): PlanUncompleteSnapshot {
  return {
    recordDate: record.recordDate,
    recordTime: record.recordTime ?? null,
    mealType: record.mealType,
    sourceType: record.sourceType,
    title: record.title ?? null,
    imagePath: record.imagePath ?? null,
    photosJson: record.photosJson ?? null,
    rating: record.rating ?? null,
    satiety: record.satiety ?? null,
    calories: record.calories ?? null,
    cost: record.cost ?? null,
    isNewTry: sqlBoolean(record.isNewTry),
    favorite: sqlBoolean(record.favorite),
    notes: record.notes ?? null,
    relatedPlanId: record.relatedPlanId ?? null,
    sourceMealPlanId: record.sourceMealPlanId ?? null,
    status: record.status,
    items: items.map(({ itemType, mealRole, recipeId, storeId, customName, sortOrder }) => ({
      itemType,
      mealRole: mealRole ?? null,
      recipeId: recipeId ?? null,
      storeId: storeId ?? null,
      customName: customName ?? null,
      sortOrder,
    })),
    dinerIds: [...dinerIds].sort((left, right) => String(left).localeCompare(String(right))),
  };
}

function parseProof(value: string | null): PlanUncompleteProof | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    const proof = parsed as Partial<PlanUncompleteProof>;
    if (
      proof.origin !== 'PLAN_UNCOMPLETE' ||
      typeof proof.sourcePlanId !== 'string' ||
      typeof proof.sourceRecordId !== 'string' ||
      !Number.isSafeInteger(proof.sourcePlanVersion) ||
      !Number.isSafeInteger(proof.sourceRecordVersion) ||
      (proof.sourcePlanVersion as number) <= 0 ||
      (proof.sourceRecordVersion as number) <= 0 ||
      !proof.snapshot ||
      typeof proof.snapshot !== 'object'
    )
      return null;
    return proof as PlanUncompleteProof;
  } catch {
    return null;
  }
}

/** 自动草稿判定：字段全空且项目/就餐人与计划逐项一致。 */
function isUneditedAutomaticRecord(
  record: MealRecordRow,
  snapshot: PlanUncompleteSnapshot,
  sourceType: string,
): boolean {
  return (
    snapshot.sourceType === sourceType &&
    snapshot.title === null &&
    snapshot.recordTime === null &&
    snapshot.imagePath === null &&
    snapshot.photosJson === null &&
    snapshot.rating === null &&
    snapshot.satiety === null &&
    snapshot.calories === null &&
    snapshot.cost === null &&
    !snapshot.isNewTry &&
    !snapshot.favorite &&
    snapshot.notes === null
  );
}

function planSourceType(plan: MealPlanDto): string {
  return plan.items.length > 0 && plan.items.every((item) => item.itemType === 'STORE')
    ? 'DINE_IN'
    : 'HOMEMADE';
}

async function hasConsumptionHistory(
  transaction: WriteTransaction,
  recordId: string,
): Promise<boolean> {
  const [row] = await transaction.query<{ count: number }>(
    `SELECT COUNT(*) AS "count" FROM "InventoryLog" WHERE "relatedRecordId" = ?`,
    [recordId],
  );
  return Number(row?.count ?? 0) > 0;
}

interface CompleteRecordResult {
  readonly plan: MealPlanDto;
  readonly record: MealRecordDto;
  readonly idempotent: boolean;
  readonly recordCreated: boolean;
  readonly recordRevived: boolean;
  readonly inventoryDeductionPromptEnabled?: boolean;
}

export async function completePlan(
  context: MealPlanServiceContext,
  id: string,
  version: number,
): Promise<CompleteRecordResult> {
  const now = context.now();
  const timestamp = now.toISOString();
  return context.database.withWriteTransaction(async (transaction) => {
    const plan = await loadPlanDto(transaction, id);
    if (!plan) throw notFound();
    const [existing] = await transaction.query<MealRecordRow>(
      `SELECT * FROM "MealRecord" WHERE "sourceMealPlanId" = ?`,
      [id],
    );
    if (plan.status === 'COMPLETED' && existing && existing.deletedAt === null) {
      const record = await loadRecordDto(transaction, existing.id);
      if (!record) throw new LocalApiError(500, 'INTERNAL_ERROR', '关联记录读取失败');
      return {
        plan,
        record,
        idempotent: true,
        recordCreated: false,
        recordRevived: false,
      };
    }
    if (plan.version !== version)
      throw new VersionConflictError('MealPlan', id, version, plan.version);
    if (plan.status === 'CANCELLED') throw conflict('已取消计划不能完成');
    if (plan.items.length === 0) throw validationError('空计划不能完成');

    const sourceType = planSourceType(plan) as 'DINE_IN' | 'HOMEMADE';
    let recordCreated = false;
    let recordRevived = false;
    let recordId: string;

    if (existing && existing.deletedAt !== null) {
      // 仅允许「上一轮完成 → 撤销」产生的软删自动草稿复活：provenance 必须完整且快照一致。
      const [oldItems, oldDinerRows] = await Promise.all([
        transaction.query<MealRecordItemRow>(
          `SELECT * FROM "MealRecordItem" WHERE "mealRecordId" = ? ORDER BY "sortOrder" ASC, rowid ASC`,
          [existing.id],
        ),
        transaction.query<{ dinerId: string | null }>(
          `SELECT "dinerId" FROM "MealRecordDiner" WHERE "mealRecordId" = ? ORDER BY rowid ASC`,
          [existing.id],
        ),
      ]);
      const snapshot = snapshotOf(
        existing,
        oldItems,
        oldDinerRows.map((row) => row.dinerId),
      );
      const proof = parseProof(existing.planUncompleteProof);
      const snapshotMatches =
        proof !== null &&
        proof.sourcePlanId === id &&
        proof.sourceRecordId === existing.id &&
        proof.sourceRecordVersion === existing.version &&
        JSON.stringify(proof.snapshot) === JSON.stringify(snapshot);
      if (
        plan.status === 'COMPLETED' ||
        !proof ||
        !snapshotMatches ||
        !isUneditedAutomaticRecord(existing, snapshot, sourceType)
      )
        throw conflict('关联饮食记录包含用户编辑或无法证明为自动草稿，不能覆盖；请先处理该记录');
      if (await hasConsumptionHistory(transaction, existing.id)) {
        throw conflict('关联饮食记录已确认或已有消费历史，不能覆盖；请先处理该记录');
      }
      // 复活：清空 provenance，刷新为当前计划内容。
      await transaction.run(`DELETE FROM "MealRecordItem" WHERE "mealRecordId" = ?`, [existing.id]);
      await transaction.run(`DELETE FROM "MealRecordDiner" WHERE "mealRecordId" = ?`, [
        existing.id,
      ]);
      const revivedItemIds: string[] = [];
      for (const item of plan.items) {
        const itemId = context.newId();
        revivedItemIds.push(itemId);
        await transaction.run(
          `INSERT INTO "MealRecordItem"
            ("id","mealRecordId","itemType","mealRole","recipeId","storeId","customName","sortOrder","createdAt","updatedAt")
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            itemId,
            existing.id,
            item.itemType,
            item.mealRole,
            item.recipeId,
            item.storeId,
            item.customName,
            item.sortOrder,
            timestamp,
            timestamp,
          ],
        );
      }
      for (const diner of plan.diners) {
        await transaction.run(
          `INSERT INTO "MealRecordDiner" ("id","mealRecordId","dinerId","createdAt","updatedAt")
           VALUES (?,?,?,?,?)`,
          [context.newId(), existing.id, diner.id, timestamp, timestamp],
        );
      }
      await transaction.run(
        `UPDATE "MealRecord" SET
           "recordDate" = ?, "recordTime" = NULL, "mealType" = ?, "sourceType" = ?, "title" = NULL,
           "status" = 'DRAFT', "imagePath" = NULL, "photosJson" = NULL, "rating" = NULL,
           "satiety" = NULL, "calories" = NULL, "cost" = NULL, "isNewTry" = 0, "favorite" = 0,
           "notes" = NULL, "relatedPlanId" = ?, "sourceMealPlanId" = ?, "confirmedAt" = NULL,
           "deletedAt" = NULL, "planUncompleteProof" = NULL,
           "version" = "version" + 1, "updatedAt" = ?
         WHERE "id" = ? AND "version" = ?`,
        [
          plan.planDate,
          plan.mealType,
          sourceType,
          id,
          id,
          timestamp,
          existing.id,
          existing.version,
        ],
      );
      recordId = existing.id;
      recordRevived = true;
    } else if (existing) {
      // 已存在活跃草稿（未编辑）：按上游语义直接复用，不覆盖内容。
      recordId = existing.id;
    } else {
      const created = await insertRecord(
        transaction,
        {
          recordDate: plan.planDate,
          recordTime: null,
          title: null,
          mealType: plan.mealType,
          sourceType,
          status: 'DRAFT',
          imagePath: null,
          photos: null,
          rating: null,
          satiety: null,
          calories: null,
          cost: null,
          isNewTry: false,
          favorite: false,
          notes: null,
          relatedPlanId: id,
          items: plan.items.map((item) => ({
            itemType: item.itemType,
            mealRole: item.mealRole,
            recipeId: item.recipeId,
            storeId: item.storeId,
            customName: item.customName,
            sortOrder: item.sortOrder,
          })),
          dinerIds: plan.diners.map((diner) => diner.id),
        },
        now,
        context.newId,
        // 记录事实完整包含在 PLAN_COMPLETE 载荷内，不再额外入队一条 MealRecord upsert，
        // 否则云端会把同一业务事实重放两次（且新建 upsert 的 baseVersion=null 与复活语义冲突）。
        { sourceMealPlanId: id, enqueueUpsert: false },
      );
      recordId = created.id;
      recordCreated = true;
    }

    const planUpdated = await transaction.run(
      `UPDATE "MealPlan" SET "status" = 'COMPLETED', "completedAt" = ?,
         "version" = "version" + 1, "updatedAt" = ?
       WHERE "id" = ? AND "version" = ? AND "deletedAt" IS NULL`,
      [timestamp, timestamp, id, version],
    );
    if (planUpdated.changes !== 1)
      throw new VersionConflictError('MealPlan', id, version, plan.version + 1);

    const nextPlan = await loadPlanDto(transaction, id);
    const nextRecord = await loadRecordDto(transaction, recordId);
    if (!nextPlan || !nextRecord)
      throw new LocalApiError(500, 'INTERNAL_ERROR', '计划完成后读取失败');

    const [recordItems, recordDinerRows] = await Promise.all([
      transaction.query<MealRecordItemRow>(
        `SELECT * FROM "MealRecordItem" WHERE "mealRecordId" = ? ORDER BY "sortOrder" ASC, rowid ASC`,
        [recordId],
      ),
      transaction.query<{ id: string; dinerId: string | null }>(
        `SELECT "id","dinerId" FROM "MealRecordDiner" WHERE "mealRecordId" = ? ORDER BY rowid ASC`,
        [recordId],
      ),
    ]);
    const [settings] = await transaction.query<{ autoDeductInventory: number | boolean }>(
      'SELECT "autoDeductInventory" FROM "Settings" WHERE "id" = 1',
    );
    const inventoryDeductionPromptEnabled = sqlBoolean(settings?.autoDeductInventory ?? false);
    await enqueueMealCommand(transaction, {
      opId: context.newId(),
      entity: 'MealPlan',
      entityId: id,
      commandType: 'PLAN_COMPLETE',
      baseVersion: version,
      payload: {
        id,
        baseVersion: version,
        executedAt: timestamp,
        plan: {
          id: nextPlan.id,
          planDate: nextPlan.planDate,
          mealType: nextPlan.mealType,
          status: nextPlan.status,
          dinerCount: nextPlan.dinerCount,
          completedAt: nextPlan.completedAt,
          version: nextPlan.version,
          updatedAt: nextPlan.updatedAt,
        },
        record: {
          id: nextRecord.id,
          recordDate: nextRecord.recordDate,
          recordTime: nextRecord.recordTime,
          mealType: nextRecord.mealType,
          sourceType: nextRecord.sourceType,
          status: nextRecord.status,
          title: nextRecord.title,
          relatedPlanId: nextRecord.relatedPlanId,
          sourceMealPlanId: nextRecord.sourceMealPlanId,
          confirmedAt: nextRecord.confirmedAt,
          version: nextRecord.version,
          deletedAt: nextRecord.deletedAt,
          createdAt: nextRecord.createdAt,
          updatedAt: nextRecord.updatedAt,
          itemIds: recordItems.map((row) => row.id),
          dinerRowIds: recordDinerRows.map((row) => row.id),
        },
        recordCreated,
        recordRevived,
        inventoryDeductionPromptEnabled,
      },
    });

    return {
      plan: nextPlan,
      record: nextRecord,
      idempotent: false,
      recordCreated,
      recordRevived,
      inventoryDeductionPromptEnabled,
    };
  });
}

export interface UncompleteResult {
  readonly plan: MealPlanDto;
  readonly removedRecord: { readonly id: string } | null;
  readonly idempotent: boolean;
}

/**
 * 撤销完成：仅 COMPLETED → PLANNED。
 *
 * 自动草稿软删并把 provenance 写入 `MealRecord.planUncompleteProof`；
 * 已 INVENTORY 扣减（InventoryLog 有记录）或用户编辑/已确认的记录一律 409。
 */
export async function uncompletePlan(
  context: MealPlanServiceContext,
  id: string,
  version: number,
): Promise<UncompleteResult> {
  const now = context.now();
  const timestamp = now.toISOString();
  return context.database.withWriteTransaction(async (transaction) => {
    const plan = await loadPlanDto(transaction, id);
    if (!plan) throw notFound();
    if (plan.status !== 'COMPLETED') return { plan, removedRecord: null, idempotent: true };
    if (plan.version !== version)
      throw new VersionConflictError('MealPlan', id, version, plan.version);

    const [source] = await transaction.query<MealRecordRow>(
      `SELECT * FROM "MealRecord" WHERE "sourceMealPlanId" = ? AND "deletedAt" IS NULL`,
      [id],
    );
    let removed: { id: string; version: number; proof: string } | null = null;
    if (source) {
      if (source.status === 'CONFIRMED')
        throw conflict('关联饮食记录已确认，不能撤销完成；请先在饮食记录中处理该记录');
      if (await hasConsumptionHistory(transaction, source.id))
        throw conflict('关联饮食记录已有库存扣减历史，不能撤销完成');
      const [items, dinerRows] = await Promise.all([
        transaction.query<MealRecordItemRow>(
          `SELECT * FROM "MealRecordItem" WHERE "mealRecordId" = ? ORDER BY "sortOrder" ASC, rowid ASC`,
          [source.id],
        ),
        transaction.query<{ dinerId: string | null }>(
          `SELECT "dinerId" FROM "MealRecordDiner" WHERE "mealRecordId" = ? ORDER BY rowid ASC`,
          [source.id],
        ),
      ]);
      const snapshot = snapshotOf(
        source,
        items,
        dinerRows.map((row) => row.dinerId),
      );
      if (!isUneditedAutomaticRecord(source, snapshot, planSourceType(plan)))
        throw conflict('关联饮食记录包含用户编辑，不能撤销完成；请先处理该记录');
      const proof: PlanUncompleteProof = {
        origin: 'PLAN_UNCOMPLETE',
        sourcePlanId: id,
        sourceRecordId: source.id,
        sourcePlanVersion: plan.version,
        sourceRecordVersion: source.version + 1,
        snapshot,
      };
      const proofJson = JSON.stringify(proof);
      const softDeleted = await transaction.run(
        `UPDATE "MealRecord" SET "deletedAt" = ?, "planUncompleteProof" = ?,
           "version" = "version" + 1, "updatedAt" = ?
         WHERE "id" = ? AND "version" = ? AND "deletedAt" IS NULL`,
        [timestamp, proofJson, timestamp, source.id, source.version],
      );
      if (softDeleted.changes !== 1)
        throw new VersionConflictError('MealRecord', source.id, source.version, source.version + 1);
      removed = { id: source.id, version: source.version + 1, proof: proofJson };
    }

    const planUpdated = await transaction.run(
      `UPDATE "MealPlan" SET "status" = 'PLANNED', "completedAt" = NULL,
         "version" = "version" + 1, "updatedAt" = ?
       WHERE "id" = ? AND "version" = ? AND "deletedAt" IS NULL`,
      [timestamp, id, version],
    );
    if (planUpdated.changes !== 1)
      throw new VersionConflictError('MealPlan', id, version, plan.version + 1);

    const nextPlan = await loadPlanDto(transaction, id);
    if (!nextPlan) throw notFound();
    await enqueueMealCommand(transaction, {
      opId: context.newId(),
      entity: 'MealPlan',
      entityId: id,
      commandType: 'PLAN_UNCOMPLETE',
      baseVersion: version,
      payload: {
        id,
        baseVersion: version,
        executedAt: timestamp,
        plan: {
          id: nextPlan.id,
          planDate: nextPlan.planDate,
          mealType: nextPlan.mealType,
          status: nextPlan.status,
          dinerCount: nextPlan.dinerCount,
          completedAt: nextPlan.completedAt,
          version: nextPlan.version,
          updatedAt: nextPlan.updatedAt,
        },
        removedRecord: removed
          ? {
              id: removed.id,
              version: removed.version,
              deletedAt: timestamp,
              planUncompleteProof: removed.proof,
            }
          : null,
      },
    });
    return {
      plan: nextPlan,
      removedRecord: removed ? { id: removed.id } : null,
      idempotent: false,
    };
  });
}

export { newLocalId };
