/**
 * 店铺（Store）本地读写。
 *
 * 契约来源：上游 `app/server/src/modules/stores/{routes,service}.ts`
 * （`da-fan-xiao-guan@e778d3bd3354123032e570e03ad85c6b19bd9ea4`）。
 *
 * 端侧差异（均与离线库 schema / 保留端点清单对齐）：
 * - 上游删除会额外写 `DeletedItem` 回收站行；该表属剔除模型，端侧只做软删 + 发件箱删除操作，
 *   保留 `deletedAt` 作为唯一删除证据；
 * - 上游 `GET /stores/candidates` 不在保留端点清单内，本模块不实现；
 * - 分页沿用上游 `normalizePagination`（有限数值后 floor、page ≥ 1、pageSize 夹取 1..100），
 *   因此不复用 `common.pageOptions` 的严格正整数口径；
 * - `Store` 没有 `mealTypes` / `menuItems` 列，二者是聚合子表，读写都按聚合整体处理：
 *   写侧与主表同事务整组替换，读侧按上游 orderBy 排序后嵌入 DTO。
 */

import type { MealType, PaginationResponse, StoreDto, StoreMenuItemDto } from '@dafan/shared/types';

import type { DatabaseClient, WriteTransaction } from '../../db/database.js';
import type { SqlValue } from '../../db/types.js';
import { LocalApiError } from '../../local-api/protocol.js';
import { localDate, paginated, sqlBoolean, validationError, type PageOptions } from '../common.js';

const STORE_TEXT_LIMIT = 2_000;
const STORE_NAME_LIMIT = 120;
const RECENT_DAYS_DEFAULT = 30;
const MENU_ITEM_LIMIT = 100;
const MENU_ITEM_NAME_LIMIT = 100;
const MENU_ITEM_ICON_LIMIT = 20;
const MENU_ITEM_DESC_LIMIT = 500;
const MENU_PRICE_MIN = 1;
const MENU_PRICE_MAX = 999;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

export const MEAL_TYPES: readonly MealType[] = [
  'BREAKFAST',
  'LUNCH',
  'DINNER',
  'AFTERNOON_TEA',
  'SOUP',
];

export type StoreAcquisitionMode = 'DINE_IN' | 'TAKEOUT';
export type StoreSortBy =
  'name' | 'averageCost' | 'rating' | 'createdAt' | 'updatedAt' | 'lastEaten';

const STORE_SORT_COLUMNS: Record<Exclude<StoreSortBy, 'lastEaten'>, string> = {
  name: 'name',
  averageCost: 'averageCost',
  rating: 'rating',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
};

const STORE_SORT_FIELDS: readonly StoreSortBy[] = [
  'name',
  'averageCost',
  'rating',
  'createdAt',
  'updatedAt',
  'lastEaten',
];

/** `Store` 行：SQLite BOOLEAN 可能是 0/1 或布尔。 */
interface StoreRow {
  readonly id: string;
  readonly name: string;
  readonly imagePath: string | null;
  readonly address: string | null;
  readonly storeType: string | null;
  readonly cuisine: string | null;
  readonly averageCost: number | null;
  readonly supportsDineIn: number | boolean | null;
  readonly supportsTakeout: number | boolean | null;
  readonly contact: string | null;
  readonly businessHours: string | null;
  readonly rating: number | null;
  readonly recommendedDishes: string | null;
  readonly avoidDishes: string | null;
  readonly tagsText: string | null;
  readonly notes: string | null;
  readonly favorite: number | boolean | null;
  readonly version: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface StoreMenuItemRow {
  readonly id: string;
  readonly storeId: string;
  readonly name: string;
  readonly price: number | null;
  readonly icon: string | null;
  readonly isSignature: number | boolean | null;
  readonly desc: string | null;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface StoreMealTypeRow {
  readonly storeId: string;
  readonly mealType: string;
}

interface StoreRecordAggRow {
  readonly storeId: string;
  readonly lastEatenDate: string | null;
  readonly historyCount: number;
}

interface RelatedRecordRow {
  readonly id: string;
  readonly recordDate: string;
  readonly recordTime: string | null;
  readonly mealType: string;
  readonly sourceType: string;
  readonly rating: number | null;
  readonly notes: string | null;
}

const STORE_COLUMNS =
  '"id", "name", "imagePath", "address", "storeType", "cuisine", "averageCost", "supportsDineIn", "supportsTakeout", "contact", "businessHours", "rating", "recommendedDishes", "avoidDishes", "tagsText", "notes", "favorite", "version", "deletedAt", "createdAt", "updatedAt"';

/** 列表 / 详情 DTO：上游 `mapStore` 额外给出最近食用日期与历史次数。 */
export interface StoreView extends StoreDto {
  readonly lastEatenDate: string | null;
  readonly historyCount: number;
}

export interface StoreRelatedRecord {
  readonly id: string;
  readonly recordDate: string;
  readonly recordTime: string | null;
  readonly mealType: MealType;
  readonly sourceType: string;
  readonly rating: number | null;
  readonly notes: string | null;
}

export type StoreDetailView = StoreView & { readonly relatedRecords: StoreRelatedRecord[] };

export interface StoreListQuery extends PageOptions {
  readonly search?: string;
  readonly mode?: StoreAcquisitionMode;
  readonly storeType?: string;
  readonly cuisine?: string;
  readonly minAverageCost?: number;
  readonly maxAverageCost?: number;
  readonly minRating?: number;
  readonly tags?: string[];
  readonly recentlyEaten?: boolean;
  readonly recentDays?: number;
  readonly favorite?: boolean;
  readonly mealTypes?: MealType[];
  readonly sortBy: StoreSortBy;
  readonly sortOrder: 'asc' | 'desc';
}

export interface StoreMenuItemInput {
  readonly name: string;
  readonly price: number | null;
  readonly icon: string | null;
  readonly isSignature: boolean;
  readonly desc: string | null;
  readonly sortOrder: number;
}

export function newStoreId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 文本列：null/undefined → null；非字符串或超限 400；去空白后为空同样落 null。 */
function cleanedText(value: unknown, field: string, limit = STORE_TEXT_LIMIT): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw validationError(`${field}必须是字符串`);
  const cleaned = value.trim();
  if (cleaned.length > limit) throw validationError(`${field}不能超过 ${limit} 个字符`);
  return cleaned || null;
}

/** 菜单文本：nullish → null；非字符串 / 超限直接 400，不做类型强转与静默截断。 */
function cleanedMenuText(value: unknown, field: string, limit: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw validationError(`${field}必须是字符串`);
  const cleaned = value.trim();
  if (cleaned.length > limit) throw validationError(`${field}不能超过 ${limit} 个字符`);
  return cleaned || null;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw validationError(`${field}必须是布尔值`);
  return value;
}

export function readMealTypes(value: unknown): MealType[] {
  if (!Array.isArray(value)) throw validationError('餐次类型必须是数组');
  const unique: unknown[] = [...new Set(value)];
  if (
    unique.some(
      (mealType) => typeof mealType !== 'string' || !MEAL_TYPES.includes(mealType as MealType),
    )
  ) {
    throw validationError('餐次类型无效');
  }
  return unique as MealType[];
}

/**
 * 招牌菜单入参规范化（与上游 `validateMenuItems` 同口径）：
 * name 必填、去空白后非空、≤ 100；price 可缺省为 null，其余必须是 1..999 整数；
 * icon ≤ 20、desc ≤ 500 可空；isSignature 可缺省（默认 false）；sortOrder 缺省取数组下标。
 * 任何非法值快速失败，绝不静默丢行或写假默认值。
 */
export function readMenuItems(value: unknown): StoreMenuItemInput[] {
  if (!Array.isArray(value)) throw validationError('招牌菜单必须是数组');
  if (value.length > MENU_ITEM_LIMIT) throw validationError(`招牌菜单最多 ${MENU_ITEM_LIMIT} 道菜`);
  return value.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw validationError(`第 ${index + 1} 道菜必须是对象`);
    }
    const item = raw as Record<string, unknown>;
    const name = cleanedMenuText(item.name, `第 ${index + 1} 道菜的菜名`, MENU_ITEM_NAME_LIMIT);
    if (!name) throw validationError(`第 ${index + 1} 道菜的菜名不能为空`);

    let price: number | null = null;
    if (item.price !== undefined && item.price !== null) {
      if (
        typeof item.price !== 'number' ||
        !Number.isInteger(item.price) ||
        item.price < MENU_PRICE_MIN ||
        item.price > MENU_PRICE_MAX
      ) {
        throw validationError(
          `第 ${index + 1} 道菜的单价必须是 ${MENU_PRICE_MIN} 到 ${MENU_PRICE_MAX} 之间的整数`,
        );
      }
      price = item.price;
    }

    let isSignature = false;
    if (item.isSignature !== undefined) {
      if (typeof item.isSignature !== 'boolean') {
        throw validationError(`第 ${index + 1} 道菜的招牌标记必须是布尔值`);
      }
      isSignature = item.isSignature;
    }

    let sortOrder = index;
    if (item.sortOrder !== undefined) {
      if (
        typeof item.sortOrder !== 'number' ||
        !Number.isInteger(item.sortOrder) ||
        item.sortOrder < 0
      ) {
        throw validationError(`第 ${index + 1} 道菜的排序必须是非负整数`);
      }
      sortOrder = item.sortOrder;
    }

    return {
      name,
      price,
      icon: cleanedMenuText(item.icon, `第 ${index + 1} 道菜的图标`, MENU_ITEM_ICON_LIMIT),
      isSignature,
      desc: cleanedMenuText(item.desc, `第 ${index + 1} 道菜的描述`, MENU_ITEM_DESC_LIMIT),
      sortOrder,
    };
  });
}

export interface ParsedStoreWrite {
  /** 主表列赋值；值为 undefined 的列由 updateVersioned 忽略。 */
  readonly values: Record<string, SqlValue | undefined>;
  readonly mealTypes: MealType[] | undefined;
  readonly menuItems: StoreMenuItemInput[] | undefined;
}

/**
 * 解析店铺写载荷。
 *
 * 与上游一致：只读取白名单字段（schema 未声明 `additionalProperties: false`，未知字段忽略），
 * 文本字段 trim 后落库，`null` 表示清空；`requireName` 对应创建时 name 必填。
 * 菜单 / 餐次校验先于事务内任何写操作，非法载荷不得先改掉主表字段。
 */
export function parseStoreWrite(
  body: Record<string, unknown>,
  options: { readonly requireName: boolean },
): ParsedStoreWrite {
  const values: Record<string, SqlValue | undefined> = {};

  if (options.requireName || body.name !== undefined) {
    const name = cleanedText(body.name, '店名', STORE_NAME_LIMIT);
    if (!name) throw validationError('店名不能为空');
    values.name = name;
  }

  const textFields = [
    ['imagePath', '图片路径'],
    ['address', '地址'],
    ['storeType', '店铺类型'],
    ['cuisine', '菜系'],
    ['contact', '联系方式'],
    ['businessHours', '营业时间'],
    ['recommendedDishes', '推荐菜品'],
    ['avoidDishes', '不推荐菜品'],
    ['tagsText', '标签'],
    ['notes', '备注'],
  ] as const;
  for (const [key, label] of textFields) {
    if (body[key] !== undefined) values[key] = cleanedText(body[key], label);
  }

  if (body.averageCost !== undefined) {
    const averageCost = body.averageCost;
    if (averageCost !== null) {
      if (typeof averageCost !== 'number' || !Number.isFinite(averageCost) || averageCost < 0) {
        throw validationError('人均消费不能为负数');
      }
    }
    values.averageCost = averageCost as number | null;
  }

  if (body.rating !== undefined) {
    const rating = body.rating;
    if (rating !== null) {
      if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 0 || rating > 5) {
        throw validationError('评分必须在 0 到 5 之间');
      }
    }
    values.rating = rating as number | null;
  }

  for (const [key, label] of [
    ['supportsDineIn', '堂食支持'],
    ['supportsTakeout', '外卖支持'],
    ['favorite', '收藏状态'],
  ] as const) {
    if (body[key] !== undefined) values[key] = readBoolean(body[key], label) ? 1 : 0;
  }

  return {
    values,
    mealTypes: body.mealTypes === undefined ? undefined : readMealTypes(body.mealTypes),
    menuItems: body.menuItems === undefined ? undefined : readMenuItems(body.menuItems),
  };
}

/** 上游 `numberValue`：缺省 / 空串视为未提供，非有限数 400。 */
function numberQuery(query: URLSearchParams, key: string, field: string): number | undefined {
  const raw = query.get(key);
  if (raw === null || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw validationError(`${field}必须是数字`);
  return parsed;
}

/** 上游 `booleanValue`：缺省 / 空串视为未提供，只接受字面量 true / false。 */
function booleanQuery(query: URLSearchParams, key: string, field: string): boolean | undefined {
  const raw = query.get(key);
  if (raw === null || raw === '') return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw validationError(`${field}必须是 true 或 false`);
}

function listQuery(query: URLSearchParams, key: string): string[] | undefined {
  const raw = query.get(key);
  if (!raw) return undefined;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 上游 `normalizePagination`：有限数值 floor 后夹取，与 `common.pageOptions` 的严格整数口径不同。 */
export function storePageOptions(query: URLSearchParams): PageOptions {
  const page = Math.max(1, Math.floor(numberQuery(query, 'page', '页码') ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(numberQuery(query, 'pageSize', '每页数量') ?? DEFAULT_PAGE_SIZE)),
  );
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function parseStoreListQuery(query: URLSearchParams): StoreListQuery {
  const mode = query.get('mode') ?? undefined;
  if (mode !== undefined && mode !== 'DINE_IN' && mode !== 'TAKEOUT') {
    throw validationError('获取方式无效');
  }
  const sortByRaw = query.get('sortBy') ?? undefined;
  if (sortByRaw !== undefined && !STORE_SORT_FIELDS.includes(sortByRaw as StoreSortBy)) {
    throw validationError('排序字段无效');
  }
  const sortOrderRaw = query.get('sortOrder') ?? undefined;
  if (sortOrderRaw !== undefined && sortOrderRaw !== 'asc' && sortOrderRaw !== 'desc') {
    throw validationError('排序方向无效');
  }
  const mealTypes = listQuery(query, 'mealTypes');

  return {
    ...storePageOptions(query),
    search: query.get('search') ?? undefined,
    mode: mode as StoreAcquisitionMode | undefined,
    storeType: query.get('storeType') || undefined,
    cuisine: query.get('cuisine') || undefined,
    minAverageCost: numberQuery(query, 'minAverageCost', '最低人均消费'),
    maxAverageCost: numberQuery(query, 'maxAverageCost', '最高人均消费'),
    minRating: numberQuery(query, 'minRating', '最低评分'),
    tags: listQuery(query, 'tags'),
    recentlyEaten: booleanQuery(query, 'recentlyEaten', '最近是否吃过'),
    recentDays: numberQuery(query, 'recentDays', '最近天数'),
    favorite: booleanQuery(query, 'favorite', '收藏状态'),
    mealTypes: mealTypes === undefined ? undefined : readMealTypes(mealTypes),
    sortBy: (sortByRaw as StoreSortBy | undefined) ?? 'updatedAt',
    sortOrder: (sortOrderRaw as 'asc' | 'desc' | undefined) ?? 'desc',
  };
}

function subtractDays(now: Date, days: number): string {
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw validationError('最近天数必须是 1 到 3650 的整数');
  }
  const date = new Date(now.getTime());
  date.setDate(date.getDate() - days);
  return localDate(date);
}

function toBoolean(value: number | boolean | null | undefined): boolean {
  return value === null || value === undefined ? false : sqlBoolean(value);
}

function mapStoreRow(row: StoreRow): StoreView {
  return {
    id: row.id,
    name: row.name,
    imagePath: row.imagePath ?? null,
    address: row.address ?? null,
    storeType: row.storeType ?? null,
    cuisine: row.cuisine ?? null,
    averageCost: row.averageCost ?? null,
    // 布尔列必须显式转换，禁止 0/1 泄漏到 DTO。
    supportsDineIn: toBoolean(row.supportsDineIn),
    supportsTakeout: toBoolean(row.supportsTakeout),
    contact: row.contact ?? null,
    businessHours: row.businessHours ?? null,
    rating: row.rating ?? null,
    recommendedDishes: row.recommendedDishes ?? null,
    avoidDishes: row.avoidDishes ?? null,
    tagsText: row.tagsText ?? null,
    notes: row.notes ?? null,
    favorite: toBoolean(row.favorite),
    version: Number(row.version),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    mealTypes: [],
    menuItems: [],
    lastEatenDate: null,
    historyCount: 0,
  };
}

function mapMenuItemRow(row: StoreMenuItemRow): StoreMenuItemDto {
  return {
    id: row.id,
    storeId: row.storeId,
    name: row.name,
    price: row.price ?? null,
    icon: row.icon ?? null,
    isSignature: toBoolean(row.isSignature),
    desc: row.desc ?? null,
    sortOrder: Number(row.sortOrder),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

type ReadClient = { query<T>(sql: string, values?: readonly SqlValue[]): Promise<T[]> };

/** 批量补齐聚合子表与食用统计，避免 N+1。 */
async function attachRelations(
  database: ReadClient,
  seeds: readonly StoreView[],
): Promise<StoreView[]> {
  if (!seeds.length) return seeds.map((seed) => ({ ...seed }));
  const ids = seeds.map((seed) => seed.id);
  const list = placeholders(ids.length);

  const [mealTypeRows, menuItemRows, recordRows] = await Promise.all([
    database.query<StoreMealTypeRow>(
      `SELECT "storeId", "mealType" FROM "StoreMealType" WHERE "storeId" IN (${list})
       ORDER BY "mealType" ASC`,
      ids,
    ),
    database.query<StoreMenuItemRow>(
      `SELECT "id", "storeId", "name", "price", "icon", "isSignature", "desc", "sortOrder", "createdAt", "updatedAt"
         FROM "StoreMenuItem" WHERE "storeId" IN (${list})
        ORDER BY "storeId" ASC, "sortOrder" ASC, "createdAt" ASC, "rowid" ASC`,
      ids,
    ),
    database.query<StoreRecordAggRow>(
      `SELECT mri."storeId" AS "storeId", MAX(mr."recordDate") AS "lastEatenDate",
              COUNT(DISTINCT mr."id") AS "historyCount"
         FROM "MealRecordItem" mri
         JOIN "MealRecord" mr ON mr."id" = mri."mealRecordId"
        WHERE mri."storeId" IN (${list}) AND mr."deletedAt" IS NULL AND mr."status" = 'CONFIRMED'
        GROUP BY mri."storeId"`,
      ids,
    ),
  ]);

  const mealTypesByStore = new Map<string, MealType[]>();
  for (const row of mealTypeRows) {
    const bucket = mealTypesByStore.get(row.storeId) ?? [];
    bucket.push(row.mealType as MealType);
    mealTypesByStore.set(row.storeId, bucket);
  }
  const menuItemsByStore = new Map<string, StoreMenuItemDto[]>();
  for (const row of menuItemRows) {
    const bucket = menuItemsByStore.get(row.storeId) ?? [];
    bucket.push(mapMenuItemRow(row));
    menuItemsByStore.set(row.storeId, bucket);
  }
  const recordsByStore = new Map(recordRows.map((row) => [row.storeId, row] as const));

  return seeds.map((seed) => {
    const records = recordsByStore.get(seed.id);
    return {
      ...seed,
      mealTypes: mealTypesByStore.get(seed.id) ?? [],
      menuItems: menuItemsByStore.get(seed.id) ?? [],
      lastEatenDate: records?.lastEatenDate ?? null,
      historyCount: Number(records?.historyCount ?? 0),
    };
  });
}

function storeWhere(query: StoreListQuery, now: Date): { sql: string; values: SqlValue[] } {
  const conditions: string[] = ['s."deletedAt" IS NULL'];
  const values: SqlValue[] = [];
  const { minAverageCost, maxAverageCost, minRating } = query;

  if (minAverageCost !== undefined && minAverageCost < 0) {
    throw validationError('最低人均消费不能为负数');
  }
  if (maxAverageCost !== undefined && maxAverageCost < 0) {
    throw validationError('最高人均消费不能为负数');
  }
  if (
    minAverageCost !== undefined &&
    maxAverageCost !== undefined &&
    minAverageCost > maxAverageCost
  ) {
    throw validationError('最低人均消费不能高于最高人均消费');
  }
  if (minRating !== undefined && (minRating < 0 || minRating > 5)) {
    throw validationError('最低评分必须在 0 到 5 之间');
  }

  if (query.mode === 'DINE_IN') conditions.push('s."supportsDineIn" = 1');
  if (query.mode === 'TAKEOUT') conditions.push('s."supportsTakeout" = 1');

  const storeType = query.storeType?.trim();
  if (storeType) {
    conditions.push('s."storeType" LIKE ?');
    values.push(`%${storeType}%`);
  }
  const cuisine = query.cuisine?.trim();
  if (cuisine) {
    conditions.push('s."cuisine" LIKE ?');
    values.push(`%${cuisine}%`);
  }
  if (query.favorite !== undefined) {
    conditions.push('s."favorite" = ?');
    values.push(query.favorite ? 1 : 0);
  }
  if (minAverageCost !== undefined) {
    conditions.push('s."averageCost" >= ?');
    values.push(minAverageCost);
  }
  if (maxAverageCost !== undefined) {
    conditions.push('s."averageCost" <= ?');
    values.push(maxAverageCost);
  }
  if (minRating !== undefined) {
    conditions.push('s."rating" >= ?');
    values.push(minRating);
  }

  const mealTypes = readMealTypes(query.mealTypes ?? []);
  if (mealTypes.length) {
    conditions.push(
      `EXISTS (SELECT 1 FROM "StoreMealType" smt WHERE smt."storeId" = s."id"
         AND smt."mealType" IN (${placeholders(mealTypes.length)}))`,
    );
    values.push(...mealTypes);
  }

  const tags = (query.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  for (const tag of tags) {
    conditions.push('s."tagsText" LIKE ?');
    values.push(`%${tag}%`);
  }

  const search = query.search?.trim();
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      `(s."name" LIKE ? OR s."storeType" LIKE ? OR s."cuisine" LIKE ? OR s."recommendedDishes" LIKE ?
        OR s."avoidDishes" LIKE ? OR s."tagsText" LIKE ?)`,
    );
    values.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }

  if (query.recentlyEaten !== undefined) {
    const since = subtractDays(now, query.recentDays ?? RECENT_DAYS_DEFAULT);
    const relation = `(SELECT 1 FROM "MealRecordItem" mri
        JOIN "MealRecord" mr ON mr."id" = mri."mealRecordId"
       WHERE mri."storeId" = s."id" AND mr."deletedAt" IS NULL AND mr."status" = 'CONFIRMED'
         AND mr."recordDate" >= ?)`;
    conditions.push(query.recentlyEaten ? `EXISTS ${relation}` : `NOT EXISTS ${relation}`);
    values.push(since);
  }

  return { sql: conditions.join(' AND '), values };
}

export async function listStores(
  database: DatabaseClient,
  query: StoreListQuery,
  now: Date,
): Promise<PaginationResponse<StoreView>> {
  const where = storeWhere(query, now);
  const direction = query.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const options: PageOptions = {
    page: query.page,
    pageSize: query.pageSize,
    skip: query.skip,
    take: query.take,
  };

  if (query.sortBy === 'lastEaten') {
    // 上游按投影后的 lastEatenDate 字符串排序，再在内存分页；id 仅作稳定基序。
    const rows = await database.query<StoreRow>(
      `SELECT ${STORE_COLUMNS} FROM "Store" s WHERE ${where.sql} ORDER BY s."id" ASC`,
      where.values,
    );
    const mapped = await attachRelations(database, rows.map(mapStoreRow));
    mapped.sort((left, right) => {
      const comparison = (left.lastEatenDate ?? '').localeCompare(right.lastEatenDate ?? '');
      return query.sortOrder === 'asc' ? comparison : -comparison;
    });
    return paginated(
      mapped.slice(options.skip, options.skip + options.take),
      mapped.length,
      options,
    );
  }

  const column = STORE_SORT_COLUMNS[query.sortBy];
  const [rows, counted] = await Promise.all([
    database.query<StoreRow>(
      `SELECT ${STORE_COLUMNS} FROM "Store" s WHERE ${where.sql}
       ORDER BY s."${column}" ${direction}, s."id" ${direction}
       LIMIT ? OFFSET ?`,
      [...where.values, options.take, options.skip],
    ),
    database.query<{ total: number }>(
      `SELECT COUNT(*) AS "total" FROM "Store" s WHERE ${where.sql}`,
      where.values,
    ),
  ]);
  const items = await attachRelations(database, rows.map(mapStoreRow));
  return paginated(items, Number(counted[0]?.total ?? 0), options);
}

async function loadStoreView(database: ReadClient, id: string): Promise<StoreView> {
  const rows = await database.query<StoreRow>(
    `SELECT ${STORE_COLUMNS} FROM "Store" s WHERE s."id" = ? AND s."deletedAt" IS NULL`,
    [id],
  );
  if (!rows.length) throw new LocalApiError(404, 'NOT_FOUND', '店铺不存在');
  const [view] = await attachRelations(database, rows.map(mapStoreRow));
  return view as StoreView;
}

export async function getStore(database: DatabaseClient, id: string): Promise<StoreDetailView> {
  const view = await loadStoreView(database, id);
  const relatedRecords = await database.query<RelatedRecordRow>(
    `SELECT mr."id", mr."recordDate", mr."recordTime", mr."mealType", mr."sourceType", mr."rating", mr."notes"
       FROM "MealRecord" mr
      WHERE mr."deletedAt" IS NULL AND mr."status" = 'CONFIRMED'
        AND EXISTS (SELECT 1 FROM "MealRecordItem" mri
                     WHERE mri."mealRecordId" = mr."id" AND mri."storeId" = ?)
      ORDER BY mr."recordDate" DESC, mr."recordTime" DESC`,
    [id],
  );
  return {
    ...view,
    relatedRecords: relatedRecords.map((row) => ({
      id: row.id,
      recordDate: row.recordDate,
      recordTime: row.recordTime ?? null,
      mealType: row.mealType as MealType,
      sourceType: row.sourceType,
      rating: row.rating ?? null,
      notes: row.notes ?? null,
    })),
  };
}

async function replaceMealTypes(
  transaction: WriteTransaction,
  storeId: string,
  mealTypes: readonly MealType[],
  timestamp: string,
): Promise<void> {
  await transaction.run(`DELETE FROM "StoreMealType" WHERE "storeId" = ?`, [storeId]);
  for (const mealType of mealTypes) {
    await transaction.run(
      `INSERT INTO "StoreMealType" ("id", "storeId", "mealType", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?)`,
      [newStoreId(), storeId, mealType, timestamp, timestamp],
    );
  }
}

/** 招牌菜单整组替换：先删该店铺全部菜单行，再按请求数组顺序重建（与菜谱子表同一模式）。 */
async function replaceMenuItems(
  transaction: WriteTransaction,
  storeId: string,
  menuItems: readonly StoreMenuItemInput[],
  timestamp: string,
): Promise<void> {
  await transaction.run(`DELETE FROM "StoreMenuItem" WHERE "storeId" = ?`, [storeId]);
  for (const item of menuItems) {
    await transaction.run(
      `INSERT INTO "StoreMenuItem"
        ("id", "storeId", "name", "price", "icon", "isSignature", "desc", "sortOrder", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newStoreId(),
        storeId,
        item.name,
        item.price,
        item.icon,
        item.isSignature ? 1 : 0,
        item.desc,
        item.sortOrder,
        timestamp,
        timestamp,
      ],
    );
  }
}

/** 发件箱载荷：业务列 + 完整聚合关联；version 由 baseVersion 表达，不重复写入。 */
function storePayload(view: StoreView): Record<string, unknown> {
  return {
    id: view.id,
    name: view.name,
    imagePath: view.imagePath,
    address: view.address,
    storeType: view.storeType,
    cuisine: view.cuisine,
    averageCost: view.averageCost,
    supportsDineIn: view.supportsDineIn,
    supportsTakeout: view.supportsTakeout,
    contact: view.contact,
    businessHours: view.businessHours,
    rating: view.rating,
    recommendedDishes: view.recommendedDishes,
    avoidDishes: view.avoidDishes,
    tagsText: view.tagsText,
    notes: view.notes,
    favorite: view.favorite,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    mealTypes: view.mealTypes,
    menuItems: view.menuItems,
  };
}

export async function createStore(
  database: DatabaseClient,
  body: Record<string, unknown>,
  now: Date,
): Promise<StoreView> {
  const parsed = parseStoreWrite(body, { requireName: true });
  const timestamp = now.toISOString();
  const id = newStoreId();

  return database.withWriteTransaction(async (transaction) => {
    const values: Record<string, SqlValue> = {
      name: parsed.values.name as string,
      imagePath: parsed.values.imagePath ?? null,
      address: parsed.values.address ?? null,
      storeType: parsed.values.storeType ?? null,
      cuisine: parsed.values.cuisine ?? null,
      averageCost: parsed.values.averageCost ?? null,
      supportsDineIn: (parsed.values.supportsDineIn as number | undefined) ?? 0,
      supportsTakeout: (parsed.values.supportsTakeout as number | undefined) ?? 0,
      contact: parsed.values.contact ?? null,
      businessHours: parsed.values.businessHours ?? null,
      rating: parsed.values.rating ?? null,
      recommendedDishes: parsed.values.recommendedDishes ?? null,
      avoidDishes: parsed.values.avoidDishes ?? null,
      tagsText: parsed.values.tagsText ?? null,
      notes: parsed.values.notes ?? null,
      favorite: (parsed.values.favorite as number | undefined) ?? 0,
    };
    const columns = Object.keys(values);
    await transaction.run(
      `INSERT INTO "Store" ("id", ${columns.map((column) => `"${column}"`).join(', ')},
         "version", "createdAt", "updatedAt")
       VALUES (?, ${placeholders(columns.length)}, 1, ?, ?)`,
      [id, ...columns.map((column) => values[column] as SqlValue), timestamp, timestamp],
    );
    if (parsed.mealTypes?.length) {
      await replaceMealTypes(transaction, id, parsed.mealTypes, timestamp);
    }
    if (parsed.menuItems?.length) {
      await replaceMenuItems(transaction, id, parsed.menuItems, timestamp);
    }
    const view = await loadStoreView(transaction, id);
    await transaction.enqueue({
      opId: newStoreId(),
      entity: 'Store',
      entityId: id,
      kind: 'upsert',
      baseVersion: null,
      payload: storePayload(view),
    });
    return view;
  });
}

export async function updateStore(
  database: DatabaseClient,
  id: string,
  body: Record<string, unknown>,
  version: number,
  now: Date,
): Promise<StoreView> {
  const parsed = parseStoreWrite(body, { requireName: false });
  const timestamp = now.toISOString();

  return database.withWriteTransaction(async (transaction) => {
    const values: Record<string, SqlValue | undefined> = { ...parsed.values };
    try {
      await transaction.updateVersioned({
        table: 'Store',
        id,
        expectedVersion: version,
        values,
      });
    } catch (error) {
      if (error instanceof LocalApiError) throw error;
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code?: string }).code === 'NOT_FOUND'
      ) {
        throw new LocalApiError(404, 'NOT_FOUND', '店铺不存在');
      }
      throw error;
    }

    // 省略 = 保持不变；[] = 清空；非空 = 整组替换。
    if (parsed.mealTypes !== undefined) {
      await replaceMealTypes(transaction, id, parsed.mealTypes, timestamp);
    }
    if (parsed.menuItems !== undefined) {
      await replaceMenuItems(transaction, id, parsed.menuItems, timestamp);
    }

    const view = await loadStoreView(transaction, id);
    await transaction.enqueue({
      opId: newStoreId(),
      entity: 'Store',
      entityId: id,
      kind: 'upsert',
      baseVersion: version,
      payload: storePayload(view),
    });
    return view;
  });
}

export async function setStoreFavorite(
  database: DatabaseClient,
  id: string,
  favorite: unknown,
  version: number,
  now: Date,
): Promise<StoreView> {
  if (typeof favorite !== 'boolean') throw validationError('收藏状态必须是布尔值');
  return updateStore(database, id, { favorite }, version, now);
}

export async function deleteStore(
  database: DatabaseClient,
  id: string,
  version: number,
  now: Date,
): Promise<{ id: string; deletedAt: string; version: number }> {
  const timestamp = now.toISOString();
  return database.withWriteTransaction(async (transaction) => {
    try {
      await transaction.updateVersioned({
        table: 'Store',
        id,
        expectedVersion: version,
        values: { deletedAt: timestamp },
      });
    } catch (error) {
      if (error instanceof LocalApiError) throw error;
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code?: string }).code === 'NOT_FOUND'
      ) {
        throw new LocalApiError(404, 'NOT_FOUND', '店铺不存在');
      }
      throw error;
    }
    await transaction.enqueue({
      opId: newStoreId(),
      entity: 'Store',
      entityId: id,
      kind: 'delete',
      baseVersion: version,
      payload: { id, version, deletedAt: timestamp },
    });
    return { id, deletedAt: timestamp, version: version + 1 };
  });
}
