import type { DatabaseClient, WriteTransaction } from '../../db/database.js';
import { VersionConflictError } from '../../db/errors.js';
import type { SqlValue } from '../../db/types.js';
import { LocalApiError } from '../../local-api/protocol.js';
import { paginated, sqlBoolean, validationError } from '../common.js';

import { mealRecordDinerId, newLocalId } from './ids.js';
import { enqueueMealCommand } from './outbox.js';
import {
  MEAL_ROLES,
  MEAL_TYPES,
  RECORD_ITEM_TYPES,
  RECORD_SOURCE_TYPES,
  RECORD_STATUSES,
  SATIETY_LEVELS,
  type DinerDto,
  type EmbeddedRecipe,
  type EmbeddedStore,
  type MealRecordDto,
  type MealRecordItemDto,
  type MealRecordItemRow,
  type MealRecordRow,
  type RecordItemType,
  type RecordSourceType,
  type RecordStatus,
  type SqlQuery,
} from './types.js';
import type { MealRole, MealType } from './types.js';

const RECORD_TITLE_LIMIT = 200;
const RECORD_NOTES_LIMIT = 2_000;
const RECORD_COST_MAX = 9999;
const PHOTOS_MAX = 3;
const UPLOAD_PATH_PATTERN = /^\/uploads\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export interface MealRecordItemInput {
  readonly itemType: RecordItemType;
  readonly mealRole: MealRole | null;
  readonly recipeId: string | null;
  readonly storeId: string | null;
  readonly customName: string | null;
  readonly sortOrder: number;
}

/** 规范化后的记录写入输入（与上游 `RecordInput` 同名同义）。 */
export interface MealRecordInput {
  readonly recordDate: string;
  readonly recordTime: string | null;
  readonly title: string | null | undefined;
  readonly mealType: MealType;
  readonly sourceType: RecordSourceType;
  readonly status: RecordStatus;
  readonly imagePath: string | null | undefined;
  readonly photos: readonly string[] | null | undefined;
  readonly rating: number | null;
  readonly satiety: number | null;
  readonly calories: number | null;
  readonly cost: number | null;
  readonly isNewTry: boolean;
  readonly favorite: boolean;
  readonly notes: string | null;
  readonly relatedPlanId: string | null;
  readonly items: readonly MealRecordItemInput[];
  readonly dinerIds: readonly string[];
}

/** 局部更新输入：undefined 表示「不修改」。 */
export interface MealRecordPatch {
  readonly recordDate?: string;
  readonly recordTime?: string | null;
  readonly title?: string | null;
  readonly mealType?: MealType;
  readonly sourceType?: RecordSourceType;
  readonly status?: RecordStatus;
  readonly imagePath?: string | null;
  readonly photos?: readonly string[] | null;
  readonly rating?: number | null;
  readonly satiety?: number | null;
  readonly calories?: number | null;
  readonly cost?: number | null;
  readonly isNewTry?: boolean;
  readonly favorite?: boolean;
  readonly notes?: string | null;
  readonly relatedPlanId?: string | null;
  readonly items?: readonly MealRecordItemInput[];
  readonly dinerIds?: readonly string[];
}

export interface MealRecordServiceContext {
  readonly database: DatabaseClient;
  readonly now: () => Date;
  readonly newId: () => string;
}

export function isMealType(value: unknown): value is MealType {
  return typeof value === 'string' && (MEAL_TYPES as readonly string[]).includes(value);
}

export function isMealRole(value: unknown): value is MealRole {
  return typeof value === 'string' && (MEAL_ROLES as readonly string[]).includes(value);
}

export function isSourceType(value: unknown): value is RecordSourceType {
  return typeof value === 'string' && (RECORD_SOURCE_TYPES as readonly string[]).includes(value);
}

export function isRecordStatus(value: unknown): value is RecordStatus {
  return typeof value === 'string' && (RECORD_STATUSES as readonly string[]).includes(value);
}

export function isRecordItemType(value: unknown): value is RecordItemType {
  return typeof value === 'string' && (RECORD_ITEM_TYPES as readonly string[]).includes(value);
}

/** 业务日期严格校验：形状 + 真实日历日期，拒绝 `2026-02-31` 之类的 rollover。 */
export function isBusinessDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const ITEMS_SQL = `SELECT * FROM "MealRecordItem" WHERE "mealRecordId" = ? ORDER BY "sortOrder" ASC, rowid ASC`;
const DINER_ROWS_SQL = `SELECT d.* FROM "MealRecordDiner" rd JOIN "Diner" d ON d."id" = rd."dinerId"
  WHERE rd."mealRecordId" = ? ORDER BY rd.rowid ASC`;

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

/** 读取侧解析 photosJson：NULL 回退单图 imagePath；损坏数据快速失败，不静默丢字段。 */
export function photosFromRow(row: {
  readonly photosJson: string | null;
  readonly imagePath: string | null;
}): string[] | null {
  if (row.photosJson === null) return row.imagePath ? [row.imagePath] : null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.photosJson);
  } catch {
    throw new LocalApiError(500, 'INTERNAL_ERROR', '饮食记录照片数据损坏（photosJson 非法 JSON）');
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string'))
    throw new LocalApiError(
      500,
      'INTERNAL_ERROR',
      '饮食记录照片数据损坏（photosJson 非字符串数组）',
    );
  return parsed.length ? (parsed as string[]) : row.imagePath ? [row.imagePath] : null;
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

function toEmbeddedRecipe(row: EmbeddedRecipeRow): EmbeddedRecipe {
  return {
    id: row.id,
    name: row.name,
    category: row.category ?? null,
    imagePath: row.imagePath ?? null,
    calories: row.calories ?? null,
    version: row.version,
    deletedAt: row.deletedAt ?? null,
  };
}

function toEmbeddedStore(row: EmbeddedStoreRow): EmbeddedStore {
  return {
    id: row.id,
    name: row.name,
    imagePath: row.imagePath ?? null,
    supportsDineIn: sqlBoolean(row.supportsDineIn),
    supportsTakeout: sqlBoolean(row.supportsTakeout),
    version: row.version,
    deletedAt: row.deletedAt ?? null,
  };
}

function toItemDto(
  row: MealRecordItemRow,
  recipe: EmbeddedRecipe | null,
  store: EmbeddedStore | null,
): MealRecordItemDto {
  return {
    id: row.id,
    mealRecordId: row.mealRecordId,
    itemType: row.itemType,
    mealRole: row.mealRole ?? null,
    recipeId: row.recipeId ?? null,
    storeId: row.storeId ?? null,
    customName: row.customName ?? null,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    recipe,
    store,
  };
}

/** 上游 `include: { recipe: true, store: true }` 的等价读取（只取适配器实际消费的列）。 */
async function loadItems(query: SqlQuery, recordId: string): Promise<MealRecordItemDto[]> {
  const rows = await query.query<MealRecordItemRow>(ITEMS_SQL, [recordId]);
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
  const recipeById = new Map(recipes.map((row) => [row.id, toEmbeddedRecipe(row)]));
  const storeById = new Map(stores.map((row) => [row.id, toEmbeddedStore(row)]));
  return rows.map((row) =>
    toItemDto(
      row,
      row.recipeId ? (recipeById.get(row.recipeId) ?? null) : null,
      row.storeId ? (storeById.get(row.storeId) ?? null) : null,
    ),
  );
}

export function toRecordDto(
  row: MealRecordRow,
  items: MealRecordItemDto[],
  diners: DinerDto[],
): MealRecordDto {
  return {
    id: row.id,
    recordDate: row.recordDate,
    recordTime: row.recordTime ?? null,
    mealType: row.mealType,
    sourceType: row.sourceType,
    title: row.title ?? null,
    status: row.status,
    imagePath: row.imagePath ?? null,
    photos: photosFromRow(row),
    rating: row.rating ?? null,
    satiety: row.satiety ?? null,
    calories: row.calories ?? null,
    cost: row.cost ?? null,
    isNewTry: sqlBoolean(row.isNewTry),
    favorite: sqlBoolean(row.favorite),
    notes: row.notes ?? null,
    relatedPlanId: row.relatedPlanId ?? null,
    sourceMealPlanId: row.sourceMealPlanId ?? null,
    confirmedAt: row.confirmedAt ?? null,
    items,
    diners,
    version: row.version,
    deletedAt: row.deletedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function loadRecordDto(query: SqlQuery, id: string): Promise<MealRecordDto | null> {
  const [row] = await query.query<MealRecordRow>(`SELECT * FROM "MealRecord" WHERE "id" = ?`, [id]);
  if (!row) return null;
  const [items, diners] = await Promise.all([
    loadItems(query, id),
    query.query<DinerRow>(DINER_ROWS_SQL, [id]),
  ]);
  return toRecordDto(row, items, diners.map(toDinerDto));
}

function httpError(status: number, code: string, message: string): LocalApiError {
  return new LocalApiError(status, code, message);
}

export function notFound(): LocalApiError {
  return httpError(404, 'NOT_FOUND', '饮食记录不存在');
}

function cleanedTitle(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw validationError('记录标题必须是字符串或 null');
  const title = value.trim();
  if (title.length > RECORD_TITLE_LIMIT)
    throw validationError(`记录标题不能超过 ${RECORD_TITLE_LIMIT} 个字符`);
  return title || null;
}

function cleanedText(value: unknown, field: string, limit: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw validationError(`${field}必须是字符串或 null`);
  const text = value.trim();
  if (text.length > limit) throw validationError(`${field}不能超过 ${limit} 个字符`);
  return text || null;
}

function nullableInteger(
  value: unknown,
  field: string,
  min: number,
  max?: number,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw validationError(`${field}必须是整数或 null`);
  if (value < min || (max !== undefined && value > max))
    throw validationError(
      max === undefined ? `${field}不能小于 ${min}` : `${field}必须在 ${min} 到 ${max} 之间`,
    );
  return value;
}

function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw validationError(`${field}必须是布尔值`);
  return value;
}

/** `HH:MM` 与上游 PLAN_TIME_PATTERN 同口径；记录侧仅做形状校验。 */
export function cleanedRecordTime(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw validationError('记录时间必须是字符串或 null');
  const time = value.trim();
  return time || null;
}

/** 照片路径只接受 `/uploads/` 相对路径，禁 data URL / 目录逃逸 / 重复。 */
function assertUploadPath(cleaned: string, label: string): string {
  if (/^data:/i.test(cleaned) || /;base64,/i.test(cleaned))
    throw validationError(`${label}不能使用 data URL / base64`);
  if (cleaned.includes('\0') || cleaned.includes('\\') || cleaned.includes('..'))
    throw validationError(`${label}不能包含非法字符`);
  if (!UPLOAD_PATH_PATTERN.test(cleaned))
    throw validationError(`${label}必须是 /uploads/ 下的图片路径`);
  return cleaned;
}

export function normalizePhotos(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value)) throw validationError('多图照片必须是数组或 null');
  if (!value.length) return null;
  if (value.length > PHOTOS_MAX) throw validationError(`多图照片最多 ${PHOTOS_MAX} 张`);
  const photos = value.map((entry, index) => {
    if (typeof entry !== 'string') throw validationError(`第 ${index + 1} 张照片路径必须是字符串`);
    const cleaned = entry.trim();
    if (!cleaned) throw validationError(`第 ${index + 1} 张照片路径不能为空`);
    if (cleaned.length > 300) throw validationError(`第 ${index + 1} 张照片路径过长`);
    return assertUploadPath(cleaned, `第 ${index + 1} 张照片`);
  });
  if (new Set(photos).size !== photos.length) throw validationError('多图照片不能重复');
  return photos;
}

/** 单图 `imagePath`：与 photos 同一路径形状约束（伪造引用在落库边界再校验登记）。 */
export function normalizeImagePath(value: unknown): string | null | undefined {
  const cleaned = cleanedText(value, 'imagePath', 300);
  if (!cleaned) return cleaned;
  return assertUploadPath(cleaned, 'imagePath');
}

/** 照片必须是本机已登记且未删除的 UploadAsset，否则 400（禁止伪造引用）。 */
async function assertUploadedPhotos(
  transaction: WriteTransaction,
  photos: readonly string[],
  label = '照片',
): Promise<void> {
  const names = photos.map((path) => path.slice('/uploads/'.length));
  const rows = await transaction.query<{
    filename: string;
    storagePath: string;
    thumbnailPath: string | null;
  }>(
    `SELECT "filename","storagePath","thumbnailPath" FROM "UploadAsset"
     WHERE "deletedAt" IS NULL AND ("filename" IN (${names.map(() => '?').join(', ')})
       OR "storagePath" IN (${names.map(() => '?').join(', ')}))
     LIMIT 200`,
    [...names, ...names],
  );
  const known = new Set<string>();
  for (const row of rows) {
    for (const value of [row.filename, row.storagePath, row.thumbnailPath]) {
      if (!value) continue;
      known.add(value);
      known.add(`/uploads/${value}`);
    }
  }
  const missing = photos.filter(
    (path) => !known.has(path) && !known.has(path.slice('/uploads/'.length)),
  );
  if (missing.length)
    throw validationError(`${label}不是本机已上传的图片：${missing.join('、')}，请重新上传`);
}

function validateItems(items: readonly MealRecordItemInput[]): void {
  for (const item of items) {
    const links =
      Number(Boolean(item.recipeId)) +
      Number(Boolean(item.storeId)) +
      Number(Boolean(item.customName?.trim()));
    if (links !== 1) throw validationError('每个记录项目必须且只能关联菜谱、店铺或自定义名称之一');
    if (
      (item.itemType === 'RECIPE') !== Boolean(item.recipeId) ||
      (item.itemType === 'STORE') !== Boolean(item.storeId) ||
      (item.itemType === 'CUSTOM') !== Boolean(item.customName?.trim())
    )
      throw validationError('记录项目类型与关联内容不一致');
  }
}

/** 关联对象必须存在且未软删（上游 Prisma 外键要求真实行）。 */
async function assertItemTargets(
  transaction: WriteTransaction,
  items: readonly MealRecordItemInput[],
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
    if (rows.length !== recipeIds.length) throw validationError('记录关联的菜谱不存在或已删除');
  }
  if (storeIds.length) {
    const rows = await transaction.query<{ id: string }>(
      `SELECT "id" FROM "Store" WHERE "deletedAt" IS NULL AND "id" IN (${storeIds.map(() => '?').join(', ')})`,
      storeIds,
    );
    if (rows.length !== storeIds.length) throw validationError('记录关联的店铺不存在或已删除');
  }
}

function validate(input: {
  readonly recordDate: string;
  readonly sourceType: RecordSourceType;
  readonly rating: number | null;
  readonly satiety: number | null;
  readonly calories: number | null;
  readonly cost: number | null;
  readonly items: readonly MealRecordItemInput[];
}): void {
  if (!isBusinessDate(input.recordDate))
    throw validationError('记录日期必须使用 YYYY-MM-DD 格式且为真实日期');
  if (!isSourceType(input.sourceType)) throw validationError('就餐类型不受支持');
  if (
    input.rating !== null &&
    (!Number.isFinite(input.rating) || input.rating < 0 || input.rating > 5)
  )
    throw validationError('评分必须在 0 到 5 之间');
  if (input.satiety !== null && !(SATIETY_LEVELS as readonly number[]).includes(input.satiety))
    throw validationError(`饱腹度必须是 ${SATIETY_LEVELS.join('/')} 之一`);
  if (input.calories !== null && (!Number.isInteger(input.calories) || input.calories < 0))
    throw validationError('摄入热量必须是大于等于 0 的整数');
  if (
    input.cost !== null &&
    (!Number.isInteger(input.cost) || input.cost < 0 || input.cost > RECORD_COST_MAX)
  )
    throw validationError(`就餐消费必须是 0 到 ${RECORD_COST_MAX} 的整数`);
  validateItems(input.items);
}

/** 解析写请求体（形状与类型），未知字段 fail-closed。 */
export function parseRecordBody(
  body: Record<string, unknown>,
  options: { readonly forUpdate: boolean },
): { readonly input: MealRecordInput; readonly version?: number } {
  const allowed = new Set([
    'recordDate',
    'recordTime',
    'title',
    'mealType',
    'sourceType',
    'status',
    'imagePath',
    'photos',
    'rating',
    'satiety',
    'calories',
    'cost',
    'isNewTry',
    'favorite',
    'notes',
    'relatedPlanId',
    'items',
    'dinerIds',
    ...(options.forUpdate ? ['version'] : []),
  ]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) throw validationError(`请求包含未支持的字段：${unknown.join(', ')}`);

  if (!isBusinessDate(body.recordDate)) throw validationError('recordDate 必须是真实业务日期');
  if (!isMealType(body.mealType)) throw validationError('mealType 不受支持');
  if (!isSourceType(body.sourceType)) throw validationError('sourceType 不受支持');
  if (body.status !== undefined && !isRecordStatus(body.status))
    throw validationError('status 必须是 DRAFT 或 CONFIRMED');
  if (
    body.relatedPlanId !== undefined &&
    body.relatedPlanId !== null &&
    typeof body.relatedPlanId !== 'string'
  )
    throw validationError('relatedPlanId 必须是字符串或 null');

  const items: MealRecordItemInput[] =
    body.items === undefined
      ? []
      : Array.isArray(body.items)
        ? body.items.map((raw, index) => {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw))
              throw validationError(`第 ${index + 1} 个记录项目必须是对象`);
            const item = raw as Record<string, unknown>;
            if (!isRecordItemType(item.itemType)) throw validationError('记录项目类型不受支持');
            if (item.mealRole !== undefined && item.mealRole !== null && !isMealRole(item.mealRole))
              throw validationError('记录项目餐次角色不受支持');
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
          })
        : (() => {
            throw validationError('items 必须是数组');
          })();

  const dinerIds = body.dinerIds === undefined ? [] : body.dinerIds;
  if (!Array.isArray(dinerIds) || dinerIds.some((id) => typeof id !== 'string'))
    throw validationError('dinerIds 必须是字符串数组');

  const input: MealRecordInput = {
    recordDate: body.recordDate,
    recordTime: cleanedRecordTime(body.recordTime) ?? null,
    title: cleanedTitle(body.title),
    mealType: body.mealType,
    sourceType: body.sourceType,
    status: (body.status as RecordStatus | undefined) ?? 'CONFIRMED',
    imagePath: normalizeImagePath(body.imagePath) ?? null,
    photos: normalizePhotos(body.photos) ?? null,
    rating: nullableInteger(body.rating, '评分', 0, 5) ?? null,
    satiety: nullableInteger(body.satiety, '饱腹度', 0) ?? null,
    calories: nullableInteger(body.calories, '摄入热量', 0) ?? null,
    cost: nullableInteger(body.cost, '就餐消费', 0, RECORD_COST_MAX) ?? null,
    isNewTry: optionalBoolean(body.isNewTry, 'isNewTry', false),
    favorite: optionalBoolean(body.favorite, 'favorite', false),
    notes: cleanedText(body.notes, '备注', RECORD_NOTES_LIMIT) ?? null,
    relatedPlanId: (body.relatedPlanId as string | null | undefined) ?? null,
    items,
    dinerIds: [...new Set(dinerIds as string[])],
  };
  validate(input);
  return {
    input,
    ...(options.forUpdate ? { version: requireRecordVersion(body.version) } : {}),
  };
}

export function requireRecordVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw validationError('version 必须为正整数');
  return value;
}

/**
 * 解析 PUT 局部更新体：只规范化请求中出现的字段，未出现的字段保持 undefined（不修改）。
 *
 * 与上游 Fastify + Prisma 的语义一致：非法值快速失败，绝不静默丢弃或补默认值。
 */
export function parseRecordPatch(body: Record<string, unknown>): MealRecordPatch {
  const fields = [
    'recordDate',
    'recordTime',
    'title',
    'mealType',
    'sourceType',
    'status',
    'imagePath',
    'photos',
    'rating',
    'satiety',
    'calories',
    'cost',
    'isNewTry',
    'favorite',
    'notes',
    'relatedPlanId',
    'items',
    'dinerIds',
  ] as const;
  const unknown = Object.keys(body).filter(
    (key) => !(fields as readonly string[]).includes(key) && key !== 'version',
  );
  if (unknown.length) throw validationError(`请求包含未支持的字段：${unknown.join(', ')}`);

  const patch: Record<string, unknown> = {};
  if ('recordDate' in body) {
    if (!isBusinessDate(body.recordDate)) throw validationError('recordDate 必须是真实业务日期');
    patch.recordDate = body.recordDate;
  }
  if ('recordTime' in body) patch.recordTime = cleanedRecordTime(body.recordTime) ?? null;
  if ('title' in body) patch.title = cleanedTitle(body.title);
  if ('mealType' in body) {
    if (!isMealType(body.mealType)) throw validationError('mealType 不受支持');
    patch.mealType = body.mealType;
  }
  if ('sourceType' in body) {
    if (!isSourceType(body.sourceType)) throw validationError('sourceType 不受支持');
    patch.sourceType = body.sourceType;
  }
  if ('status' in body) {
    if (!isRecordStatus(body.status)) throw validationError('status 必须是 DRAFT 或 CONFIRMED');
    patch.status = body.status;
  }
  if ('imagePath' in body) patch.imagePath = normalizeImagePath(body.imagePath) ?? null;
  if ('photos' in body) patch.photos = normalizePhotos(body.photos) ?? null;
  if ('rating' in body) {
    const rating = nullableInteger(body.rating, '评分', 0, 5) ?? null;
    if (rating !== null && (!Number.isFinite(rating) || rating < 0 || rating > 5))
      throw validationError('评分必须在 0 到 5 之间');
    patch.rating = rating;
  }
  if ('satiety' in body) {
    const satiety = nullableInteger(body.satiety, '饱腹度', 0) ?? null;
    if (satiety !== null && !(SATIETY_LEVELS as readonly number[]).includes(satiety))
      throw validationError(`饱腹度必须是 ${SATIETY_LEVELS.join('/')} 之一`);
    patch.satiety = satiety;
  }
  if ('calories' in body) patch.calories = nullableInteger(body.calories, '摄入热量', 0) ?? null;
  if ('cost' in body)
    patch.cost = nullableInteger(body.cost, '就餐消费', 0, RECORD_COST_MAX) ?? null;
  if ('isNewTry' in body) patch.isNewTry = optionalBoolean(body.isNewTry, 'isNewTry', false);
  if ('favorite' in body) patch.favorite = optionalBoolean(body.favorite, 'favorite', false);
  if ('notes' in body) patch.notes = cleanedText(body.notes, '备注', RECORD_NOTES_LIMIT) ?? null;
  if ('relatedPlanId' in body) {
    if (body.relatedPlanId !== null && typeof body.relatedPlanId !== 'string')
      throw validationError('relatedPlanId 必须是字符串或 null');
    patch.relatedPlanId = (body.relatedPlanId as string | null) || null;
  }
  if ('items' in body) {
    const parsed = parseRecordBody(
      {
        recordDate: '1970-01-01',
        mealType: 'BREAKFAST',
        sourceType: 'CUSTOM',
        items: body.items,
      },
      { forUpdate: false },
    );
    patch.items = parsed.input.items;
  }
  if ('dinerIds' in body) {
    const dinerIds = body.dinerIds;
    if (!Array.isArray(dinerIds) || dinerIds.some((id) => typeof id !== 'string'))
      throw validationError('dinerIds 必须是字符串数组');
    patch.dinerIds = [...new Set(dinerIds as string[])];
  }
  return patch as MealRecordPatch;
}

export interface CreateRecordOptions {
  /** 覆盖 status / confirmedAt 语义（计划完成与打卡都写 DRAFT 或 CONFIRMED）。 */
  readonly sourceMealPlanId?: string | null;
  readonly enqueueUpsert?: boolean;
}

/** 落一条记录（含子项与就餐人），可在任意写事务内调用。 */
export async function insertRecord(
  transaction: WriteTransaction,
  input: MealRecordInput,
  now: Date,
  newId: () => string,
  options: CreateRecordOptions = {},
): Promise<MealRecordDto> {
  validate(input);
  await assertItemTargets(transaction, input.items);
  const timestamp = now.toISOString();
  const recordId = newId();
  const photos = input.photos ?? null;
  if (photos && photos.length) await assertUploadedPhotos(transaction, photos);
  const imagePath = photos && photos.length ? photos[0] : (input.imagePath ?? null);
  if (!(photos && photos.length) && imagePath)
    await assertUploadedPhotos(transaction, [imagePath], '单图 imagePath');
  const status: RecordStatus = input.status;
  await transaction.run(
    `INSERT INTO "MealRecord"
      ("id","recordDate","recordTime","mealType","sourceType","title","status","imagePath","photosJson",
       "rating","satiety","calories","cost","isNewTry","favorite","notes","relatedPlanId","sourceMealPlanId",
       "confirmedAt","version","deletedAt","planUncompleteProof","createdAt","updatedAt")
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL,NULL,?,?)`,
    [
      recordId,
      input.recordDate,
      input.recordTime,
      input.mealType,
      input.sourceType,
      input.title ?? null,
      status,
      imagePath,
      photos && photos.length ? JSON.stringify(photos) : null,
      input.rating,
      input.satiety,
      input.calories,
      input.cost,
      input.isNewTry ? 1 : 0,
      input.favorite ? 1 : 0,
      input.notes,
      input.relatedPlanId,
      options.sourceMealPlanId ?? null,
      status === 'CONFIRMED' ? timestamp : null,
      timestamp,
      timestamp,
    ],
  );
  await replaceItems(transaction, recordId, input.items, timestamp, newId);
  await replaceDiners(transaction, recordId, input.dinerIds, timestamp);
  const dto = await loadRecordDto(transaction, recordId);
  if (!dto) throw httpError(500, 'INTERNAL_ERROR', '饮食记录创建后读取失败');
  if (options.enqueueUpsert !== false) {
    await transaction.enqueue({
      opId: newLocalId(),
      entity: 'MealRecord',
      entityId: recordId,
      kind: 'upsert',
      baseVersion: null,
      payload: dto as unknown as Record<string, unknown>,
    });
  }
  return dto;
}

async function replaceItems(
  transaction: WriteTransaction,
  recordId: string,
  items: readonly MealRecordItemInput[],
  timestamp: string,
  newId: () => string,
): Promise<void> {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    await transaction.run(
      `INSERT INTO "MealRecordItem"
        ("id","mealRecordId","itemType","mealRole","recipeId","storeId","customName","sortOrder","createdAt","updatedAt")
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        newId(),
        recordId,
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

async function replaceDiners(
  transaction: WriteTransaction,
  recordId: string,
  dinerIds: readonly string[],
  timestamp: string,
): Promise<void> {
  for (const dinerId of [...new Set(dinerIds)]) {
    const [row] = await transaction.query<{ id: string }>(
      `SELECT "id" FROM "Diner" WHERE "id" = ?`,
      [dinerId],
    );
    if (!row) throw validationError('记录关联的食用者不存在');
    // 行 ID 可派生：载荷 `diners` 只带 DinerDto，云端按 (recordId, dinerId) 复算同一 ID。
    await transaction.run(
      `INSERT INTO "MealRecordDiner" ("id","mealRecordId","dinerId","createdAt","updatedAt")
       VALUES (?,?,?,?,?)`,
      [mealRecordDinerId(recordId, dinerId), recordId, dinerId, timestamp, timestamp],
    );
  }
}

export async function listRecords(
  database: SqlQuery,
  query: {
    readonly from?: string;
    readonly to?: string;
    readonly sourceType?: RecordSourceType;
    readonly mealType?: MealType;
    readonly status?: RecordStatus;
    readonly minRating?: string;
    readonly dinerId?: string;
    readonly q?: string;
    readonly page: number;
    readonly pageSize: number;
  },
) {
  const clauses = ['r."deletedAt" IS NULL'];
  const values: SqlValue[] = [];
  if (query.from) {
    clauses.push('r."recordDate" >= ?');
    values.push(query.from);
  }
  if (query.to) {
    clauses.push('r."recordDate" <= ?');
    values.push(query.to);
  }
  if (query.sourceType) {
    clauses.push('r."sourceType" = ?');
    values.push(query.sourceType);
  }
  if (query.mealType) {
    clauses.push('r."mealType" = ?');
    values.push(query.mealType);
  }
  if (query.status) {
    clauses.push('r."status" = ?');
    values.push(query.status);
  }
  if (query.minRating !== undefined) {
    clauses.push('r."rating" >= ?');
    values.push(Number(query.minRating));
  }
  if (query.dinerId) {
    clauses.push(
      'EXISTS (SELECT 1 FROM "MealRecordDiner" rd WHERE rd."mealRecordId" = r."id" AND rd."dinerId" = ?)',
    );
    values.push(query.dinerId);
  }
  const search = query.q?.trim();
  if (search) {
    const like = `%${search}%`;
    clauses.push(
      `(r."notes" LIKE ?
        OR EXISTS (SELECT 1 FROM "MealRecordItem" ri WHERE ri."mealRecordId" = r."id" AND ri."customName" LIKE ?)
        OR EXISTS (SELECT 1 FROM "MealRecordItem" ri JOIN "Recipe" rc ON rc."id" = ri."recipeId"
                   WHERE ri."mealRecordId" = r."id" AND rc."name" LIKE ?)
        OR EXISTS (SELECT 1 FROM "MealRecordItem" ri JOIN "Store" st ON st."id" = ri."storeId"
                   WHERE ri."mealRecordId" = r."id" AND st."name" LIKE ?))`,
    );
    values.push(like, like, like, like);
  }
  const where = clauses.join(' AND ');
  const [totalRow] = await database.query<{ total: number }>(
    `SELECT COUNT(*) AS "total" FROM "MealRecord" r WHERE ${where}`,
    values,
  );
  const rows = await database.query<MealRecordRow>(
    `SELECT r.* FROM "MealRecord" r WHERE ${where}
     ORDER BY r."recordDate" DESC, r."recordTime" DESC, r."id" DESC
     LIMIT ? OFFSET ?`,
    [...values, query.pageSize, (query.page - 1) * query.pageSize],
  );
  const items = await Promise.all(rows.map((row) => loadRecordDto(database, row.id)));
  return paginated(
    items.filter((item): item is MealRecordDto => item !== null),
    Number(totalRow?.total ?? 0),
    {
      page: query.page,
      pageSize: query.pageSize,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    },
  );
}

export async function getRecord(database: SqlQuery, id: string): Promise<MealRecordDto> {
  const dto = await loadRecordDto(database, id);
  if (!dto || dto.deletedAt !== null) throw notFound();
  return dto;
}

export async function createRecord(
  context: MealRecordServiceContext,
  input: MealRecordInput,
): Promise<MealRecordDto> {
  const now = context.now();
  return context.database.withWriteTransaction((tx) => insertRecord(tx, input, now, context.newId));
}

/** 局部更新：undefined 保留旧值，显式 null 清空（与上游 Prisma 语义一致）。 */
export async function updateRecord(
  context: MealRecordServiceContext,
  id: string,
  version: number,
  patch: MealRecordPatch,
): Promise<MealRecordDto> {
  const now = context.now();
  return context.database.withWriteTransaction(async (tx) => {
    const [current] = await tx.query<MealRecordRow>(
      `SELECT * FROM "MealRecord" WHERE "id" = ? AND "deletedAt" IS NULL`,
      [id],
    );
    if (!current) throw notFound();
    if (current.version !== version)
      throw new VersionConflictError('MealRecord', id, version, current.version);
    if (current.status === 'CONFIRMED' && patch.status === 'DRAFT')
      throw httpError(409, 'CONFLICT', '已确认记录不能退回草稿');
    // 计划完成生成的自动草稿：菜品与就餐人是计划事实的投影，改动会让撤销/复活无法证明未被编辑。
    if (
      current.status === 'DRAFT' &&
      current.sourceMealPlanId !== null &&
      (patch.items !== undefined || patch.dinerIds !== undefined)
    )
      throw httpError(409, 'CONFLICT', '自动草稿的菜品与就餐人由排餐计划决定，请修改计划本身');

    const timestamp = now.toISOString();
    const photos = patch.photos;
    const status = patch.status ?? current.status;
    const confirmedAt =
      current.status === 'DRAFT' && status === 'CONFIRMED' ? timestamp : current.confirmedAt;
    const imagePath =
      photos === undefined
        ? patch.imagePath === undefined
          ? current.imagePath
          : patch.imagePath
        : photos && photos.length
          ? photos[0]
          : null;
    if (photos && photos.length) await assertUploadedPhotos(tx, photos);
    else if (photos === undefined && patch.imagePath)
      await assertUploadedPhotos(tx, [patch.imagePath], '单图 imagePath');
    const values: SqlValue[] = [
      patch.recordDate ?? current.recordDate,
      patch.recordTime === undefined ? current.recordTime : patch.recordTime,
      patch.title === undefined ? current.title : (patch.title ?? null),
      patch.mealType ?? current.mealType,
      patch.sourceType ?? current.sourceType,
      status,
      imagePath,
      photos === undefined
        ? current.photosJson
        : photos && photos.length
          ? JSON.stringify(photos)
          : null,
      patch.rating === undefined ? current.rating : patch.rating,
      patch.satiety === undefined ? current.satiety : patch.satiety,
      patch.calories === undefined ? current.calories : patch.calories,
      patch.cost === undefined ? current.cost : patch.cost,
      patch.isNewTry === undefined ? current.isNewTry : patch.isNewTry ? 1 : 0,
      patch.favorite === undefined ? current.favorite : patch.favorite ? 1 : 0,
      patch.notes === undefined ? current.notes : patch.notes,
      patch.relatedPlanId === undefined ? current.relatedPlanId : patch.relatedPlanId,
      confirmedAt,
      timestamp,
    ];
    const updated = await tx.run(
      `UPDATE "MealRecord" SET
         "recordDate" = ?, "recordTime" = ?, "title" = ?, "mealType" = ?, "sourceType" = ?, "status" = ?,
         "imagePath" = ?, "photosJson" = ?, "rating" = ?, "satiety" = ?, "calories" = ?, "cost" = ?,
         "isNewTry" = ?, "favorite" = ?, "notes" = ?, "relatedPlanId" = ?, "confirmedAt" = ?,
         "version" = "version" + 1, "updatedAt" = ?
       WHERE "id" = ? AND "version" = ? AND "deletedAt" IS NULL`,
      [...values, id, version],
    );
    if (updated.changes !== 1)
      throw new VersionConflictError('MealRecord', id, version, current.version + 1);

    if (patch.items !== undefined) {
      validateItems(patch.items);
      await assertItemTargets(tx, patch.items);
      await tx.run(`DELETE FROM "MealRecordItem" WHERE "mealRecordId" = ?`, [id]);
      await replaceItems(tx, id, patch.items, timestamp, context.newId);
    }
    if (patch.dinerIds !== undefined) {
      await tx.run(`DELETE FROM "MealRecordDiner" WHERE "mealRecordId" = ?`, [id]);
      await replaceDiners(tx, id, patch.dinerIds, timestamp);
    }

    const dto = await loadRecordDto(tx, id);
    if (!dto) throw notFound();
    await tx.enqueue({
      opId: newLocalId(),
      entity: 'MealRecord',
      entityId: id,
      kind: 'upsert',
      baseVersion: version,
      payload: dto as unknown as Record<string, unknown>,
    });
    return dto;
  });
}

export async function confirmRecord(
  context: MealRecordServiceContext,
  id: string,
  version: number,
): Promise<MealRecordDto> {
  const current = await getRecord(context.database, id);
  if (current.status === 'CONFIRMED') return current;
  return updateRecord(context, id, version, { status: 'CONFIRMED' });
}

/**
 * 普通删除记录：软删 + 释放 `sourceMealPlanId` + 同事务把关联活跃计划回退为 PLANNED。
 *
 * 回退只针对仍为 COMPLETED 的活跃计划；不做任何库存回滚，也不复活已删记录。
 * 整个链路只入队一条 `RECORD_DELETE` 命令（包含计划回退后的确定性事实）。
 */
export async function deleteRecord(
  context: MealRecordServiceContext,
  id: string,
  version: number,
): Promise<{ id: string; revertedPlanId: string | null }> {
  const now = context.now();
  return context.database.withWriteTransaction(async (tx) => {
    const [current] = await tx.query<MealRecordRow>(
      `SELECT * FROM "MealRecord" WHERE "id" = ? AND "deletedAt" IS NULL`,
      [id],
    );
    if (!current) throw notFound();
    if (current.version !== version)
      throw new VersionConflictError('MealRecord', id, version, current.version);

    const timestamp = now.toISOString();
    await tx.run(
      `UPDATE "MealRecord" SET "deletedAt" = ?, "version" = "version" + 1, "updatedAt" = ?
       WHERE "id" = ? AND "version" = ?`,
      [timestamp, timestamp, id, version],
    );

    const sourceMealPlanId = current.sourceMealPlanId ?? null;
    let revertedPlan: {
      id: string;
      planDate: string;
      mealType: MealType;
      status: string;
      dinerCount: number;
      completedAt: string | null;
      version: number;
      updatedAt: string;
    } | null = null;
    if (sourceMealPlanId) {
      const [plan] = await tx.query<{
        id: string;
        planDate: string;
        mealType: MealType;
        status: string;
        dinerCount: number;
        completedAt: string | null;
        version: number;
      }>(
        `SELECT "id","planDate","mealType","status","dinerCount","completedAt","version"
         FROM "MealPlan" WHERE "id" = ? AND "deletedAt" IS NULL`,
        [sourceMealPlanId],
      );
      if (plan && plan.status === 'COMPLETED') {
        const planVersion = plan.version + 1;
        const reverted = await tx.run(
          `UPDATE "MealPlan" SET "status" = 'PLANNED', "completedAt" = NULL,
             "version" = "version" + 1, "updatedAt" = ?
           WHERE "id" = ? AND "version" = ? AND "deletedAt" IS NULL`,
          [timestamp, plan.id, plan.version],
        );
        if (reverted.changes !== 1)
          throw new VersionConflictError('MealPlan', plan.id, plan.version, plan.version + 1);
        revertedPlan = {
          id: plan.id,
          planDate: plan.planDate,
          mealType: plan.mealType,
          status: 'PLANNED',
          dinerCount: plan.dinerCount,
          completedAt: null,
          version: planVersion,
          updatedAt: timestamp,
        };
      }
      await tx.run(
        `UPDATE "MealRecord" SET "sourceMealPlanId" = NULL, "updatedAt" = ? WHERE "id" = ?`,
        [timestamp, id],
      );
    }

    await enqueueMealCommand(tx, {
      opId: newLocalId(),
      entity: 'MealRecord',
      entityId: id,
      commandType: 'RECORD_DELETE',
      baseVersion: version,
      payload: {
        id,
        baseVersion: version,
        executedAt: timestamp,
        deletedAt: timestamp,
        releasedSourceMealPlanId: sourceMealPlanId,
        revertedPlan,
      },
    });
    return { id, revertedPlanId: revertedPlan?.id ?? null };
  });
}

export { newLocalId };
