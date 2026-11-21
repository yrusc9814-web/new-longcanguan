import type { DatabaseClient } from '../../db/database.js';
import { LocalApiDataResult, LocalApiError } from '../../local-api/protocol.js';
import type { LocalApiRouter } from '../../local-api/router.js';
import { readObject, validationError } from '../common.js';
import { newLocalId } from '../meal-records/ids.js';
import { enqueueMealCommand } from '../meal-records/outbox.js';
import {
  insertRecord,
  isBusinessDate,
  isMealType,
  loadRecordDto,
  normalizePhotos,
  type MealRecordDto,
  type MealRecordItemRow,
  type MealRecordRow,
  type RecordSourceType,
} from '../meal-records/index.js';

const COOK_SOURCE_TYPES: readonly RecordSourceType[] = ['HOMEMADE', 'TAKEOUT', 'DINE_IN', 'CUSTOM'];
const SATIETY_LEVELS = [3, 5, 7, 8, 10] as const;

/** 上游 cook-checkin 的允许字段：不含任何库存/扣减语义。 */
const ALLOWED_KEYS = new Set([
  'recordDate',
  'mealType',
  'recordTime',
  'title',
  'notes',
  'photos',
  'calories',
  'rating',
  'satiety',
  'cost',
  'dinerIds',
  'sourceType',
]);

interface CookCheckinInput {
  readonly recordDate: string;
  readonly mealType: string;
  readonly recordTime: string | null;
  readonly title: string | null;
  readonly notes: string | null;
  readonly photos: readonly string[] | null;
  readonly calories: number | null;
  readonly rating: number | null;
  readonly satiety: number | null;
  readonly cost: number | null;
  readonly dinerIds: readonly string[];
  readonly sourceType: RecordSourceType;
}

function optionalNullableString(value: unknown, field: string, limit: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw validationError(`${field}必须是字符串或 null`);
  const text = value.trim();
  if (text.length > limit) throw validationError(`${field}不能超过 ${limit} 个字符`);
  return text || null;
}

function optionalNullableNumber(
  value: unknown,
  field: string,
  min: number,
  max?: number,
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw validationError(`${field}必须是数字或 null`);
  if (value < min || (max !== undefined && value > max))
    throw validationError(
      max === undefined ? `${field}不能小于 ${min}` : `${field}必须在 ${min} 到 ${max} 之间`,
    );
  return value;
}

function optionalNullableInteger(
  value: unknown,
  field: string,
  min: number,
  max?: number,
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw validationError(`${field}必须是整数或 null`);
  if (value < min || (max !== undefined && value > max))
    throw validationError(
      max === undefined ? `${field}不能小于 ${min}` : `${field}必须在 ${min} 到 ${max} 之间`,
    );
  return value;
}

function parseCookBody(body: Record<string, unknown>): CookCheckinInput {
  const unknown = Object.keys(body).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length) throw validationError(`打卡请求包含未支持的字段：${unknown.join(', ')}`);
  if (!isBusinessDate(body.recordDate))
    throw validationError('recordDate 必须是 YYYY-MM-DD 格式的真实日期');
  if (!isMealType(body.mealType)) throw validationError('mealType 不受支持');
  const sourceType = body.sourceType === undefined ? 'HOMEMADE' : body.sourceType;
  if (typeof sourceType !== 'string' || !COOK_SOURCE_TYPES.includes(sourceType as RecordSourceType))
    throw validationError('sourceType 不受支持');
  const satiety = optionalNullableInteger(body.satiety, '饱腹度', 0);
  if (satiety !== null && !(SATIETY_LEVELS as readonly number[]).includes(satiety))
    throw validationError(`饱腹度必须是 ${SATIETY_LEVELS.join('/')} 之一`);
  const dinerIds = body.dinerIds === undefined ? [] : body.dinerIds;
  if (!Array.isArray(dinerIds) || dinerIds.some((id) => typeof id !== 'string'))
    throw validationError('dinerIds 必须是字符串数组');
  return {
    recordDate: body.recordDate,
    mealType: body.mealType,
    recordTime: optionalNullableString(body.recordTime, '记录时间', 20),
    title: optionalNullableString(body.title, '记录标题', 200),
    notes: optionalNullableString(body.notes, '备注', 2_000),
    photos: normalizePhotos(body.photos) ?? null,
    calories: optionalNullableInteger(body.calories, '摄入热量', 0),
    rating: optionalNullableNumber(body.rating, '评分', 0, 5),
    satiety,
    cost: optionalNullableInteger(body.cost, '就餐消费', 0, 9999),
    dinerIds: [...new Set(dinerIds as string[])],
    sourceType: sourceType as RecordSourceType,
  };
}

function normalizePhotosForCompare(photos: readonly string[] | null): string[] | null {
  return photos && photos.length ? [...photos] : null;
}

/**
 * Google2 菜谱详情「🍳 打卡」：只创建一条真实烹饪记录，绝不触碰库存。
 *
 * - 同（菜谱, 日期, 餐次）已有未删 CONFIRMED 记录：内容一致返回既有记录（`repeated: true`），
 *   内容不同返回 409。
 * - 新建时 `RECIPE_COOK_CHECKIN` 命令载荷带上真实落库的 `record.id` 与 `itemIds`，供重放复用。
 * - 不产生 DRAFT、不写 `InventoryLog`，响应显式声明 `inventoryDeducted: false`。
 */
export async function cookCheckinRecipe(
  database: DatabaseClient,
  recipeId: string,
  body: Record<string, unknown>,
  options: { readonly now: () => Date; readonly newId?: () => string },
): Promise<{
  record: MealRecordDto;
  recipe: { id: string; name: string; calories: number | null };
  inventoryDeducted: false;
  inventoryDeductionPrompt: string;
  repeated: boolean;
}> {
  const input = parseCookBody(body);
  const now = options.now();
  const newId = options.newId ?? newLocalId;
  const timestamp = now.toISOString();

  return database.withWriteTransaction(async (transaction) => {
    const [recipe] = await transaction.query<{
      id: string;
      name: string;
      calories: number | null;
    }>(`SELECT "id","name","calories" FROM "Recipe" WHERE "id" = ? AND "deletedAt" IS NULL`, [
      recipeId,
    ]);
    if (!recipe) throw new LocalApiError(404, 'NOT_FOUND', '菜谱不存在');

    const [existing] = await transaction.query<MealRecordRow>(
      `SELECT r.* FROM "MealRecord" r
       WHERE r."deletedAt" IS NULL AND r."status" = 'CONFIRMED'
         AND r."recordDate" = ? AND r."mealType" = ?
         AND EXISTS (SELECT 1 FROM "MealRecordItem" ri WHERE ri."mealRecordId" = r."id" AND ri."recipeId" = ?)
       ORDER BY r.rowid ASC LIMIT 1`,
      [input.recordDate, input.mealType, recipeId],
    );

    const calories = input.calories ?? recipe.calories;
    if (existing) {
      const [existingItems, existingDinerRows] = await Promise.all([
        transaction.query<MealRecordItemRow>(
          `SELECT * FROM "MealRecordItem" WHERE "mealRecordId" = ? ORDER BY "sortOrder" ASC, rowid ASC`,
          [existing.id],
        ),
        transaction.query<{ dinerId: string | null }>(
          `SELECT "dinerId" FROM "MealRecordDiner" WHERE "mealRecordId" = ? ORDER BY rowid ASC`,
          [existing.id],
        ),
      ]);
      const existingDto = await loadRecordDto(transaction, existing.id);
      if (!existingDto) throw new LocalApiError(500, 'INTERNAL_ERROR', '打卡记录读取失败');
      const existingDiners = existingDinerRows
        .map((row) => row.dinerId)
        .filter((id): id is string => id !== null)
        .sort();
      const requestedDiners = [...input.dinerIds].sort();
      const existingTitle = input.title === undefined ? existing.title : input.title || null;
      const same =
        existing.recordTime === input.recordTime &&
        existing.sourceType === input.sourceType &&
        existing.title === existingTitle &&
        (existing.notes ?? null) === input.notes &&
        existing.calories === calories &&
        (existing.rating ?? null) === input.rating &&
        (existing.satiety ?? null) === input.satiety &&
        (existing.cost ?? null) === input.cost &&
        JSON.stringify(normalizePhotosForCompare(existingDto.photos)) ===
          JSON.stringify(normalizePhotosForCompare(input.photos)) &&
        JSON.stringify(existingDiners) === JSON.stringify(requestedDiners) &&
        existingItems.length === 1;
      if (!same)
        throw new LocalApiError(409, 'CONFLICT', '该菜谱在同一日期和餐次已有不同内容的打卡记录');
      return {
        record: existingDto,
        recipe: { id: recipe.id, name: recipe.name, calories: recipe.calories ?? null },
        inventoryDeducted: false as const,
        inventoryDeductionPrompt: '打卡仅生成饮食记录，未扣减库存；如需扣减请走库存扣减流程',
        repeated: true,
      };
    }

    const created = await insertRecord(
      transaction,
      {
        recordDate: input.recordDate,
        recordTime: input.recordTime,
        title: input.title,
        mealType: input.mealType as MealRecordRow['mealType'],
        sourceType: input.sourceType,
        status: 'CONFIRMED',
        imagePath: null,
        photos: input.photos,
        rating: input.rating,
        satiety: input.satiety,
        calories,
        cost: input.cost,
        isNewTry: false,
        favorite: false,
        notes: input.notes,
        relatedPlanId: null,
        items: [
          {
            itemType: 'RECIPE',
            mealRole: 'MAIN',
            recipeId,
            storeId: null,
            customName: null,
            sortOrder: 0,
          },
        ],
        dinerIds: input.dinerIds,
      },
      now,
      newId,
      { enqueueUpsert: false },
    );

    const items = await transaction.query<MealRecordItemRow>(
      `SELECT * FROM "MealRecordItem" WHERE "mealRecordId" = ? ORDER BY "sortOrder" ASC, rowid ASC`,
      [created.id],
    );
    const dinerRows = await transaction.query<{ id: string; dinerId: string | null }>(
      `SELECT "id","dinerId" FROM "MealRecordDiner" WHERE "mealRecordId" = ? ORDER BY rowid ASC`,
      [created.id],
    );

    await enqueueMealCommand(transaction, {
      opId: newLocalId(),
      entity: 'MealRecord',
      entityId: created.id,
      commandType: 'RECIPE_COOK_CHECKIN',
      // 新建记录没有「前一版本」：命令 baseVersion 与载荷 baseVersion 均为 null。
      baseVersion: null,
      payload: {
        id: created.id,
        baseVersion: null,
        executedAt: timestamp,
        recipeId,
        recordDate: input.recordDate,
        mealType: input.mealType,
        record: {
          id: created.id,
          recordDate: created.recordDate,
          recordTime: created.recordTime,
          mealType: created.mealType,
          sourceType: created.sourceType,
          status: created.status,
          title: created.title,
          relatedPlanId: created.relatedPlanId,
          sourceMealPlanId: created.sourceMealPlanId,
          confirmedAt: created.confirmedAt,
          version: created.version,
          deletedAt: created.deletedAt,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
          itemIds: items.map((row) => row.id),
          dinerRowIds: dinerRows.map((row) => row.id),
        },
        request: {
          recordTime: input.recordTime,
          title: input.title,
          notes: input.notes,
          photos: input.photos,
          calories,
          rating: input.rating,
          satiety: input.satiety,
          cost: input.cost,
          sourceType: input.sourceType,
          // 与落库顺序严格一致（`insertRecord` 按此顺序插入 MealRecordDiner），
          // 云端按 `dinerRowIds[i] <-> dinerIds[i]` 逐行对齐，禁止在这里再排序。
          dinerIds: [...input.dinerIds],
        },
      },
    });

    return {
      record: created,
      recipe: { id: recipe.id, name: recipe.name, calories: recipe.calories ?? null },
      inventoryDeducted: false as const,
      inventoryDeductionPrompt: '打卡仅生成饮食记录，未扣减库存；如需扣减请走库存扣减流程',
      repeated: false,
    };
  });
}

/**
 * 注册 `POST /api/v1/recipes/:id/cook-checkin`。
 *
 * 独立于 `registerRecipes`：菜谱域本体的注册表断言仍把它列为「不在 recipes/index 内」，
 * 由主线程在总注册时显式调用本函数。
 */
export function registerRecipeCookCheckin(
  router: LocalApiRouter,
  getDatabase: () => Promise<DatabaseClient>,
): void {
  const now = router.options.now ?? (() => new Date());
  router.register('POST', '/api/v1/recipes/:id/cook-checkin', async ({ request, params }) => {
    const recipeId = params.id ?? '';
    if (!recipeId) throw new LocalApiError(404, 'NOT_FOUND', '菜谱不存在');
    const body = await readObject(request);
    const database = await getDatabase();
    const result = await cookCheckinRecipe(database, recipeId, body, { now });
    return new LocalApiDataResult(result, result.repeated ? 200 : 201);
  });
}
