import type { MealType, QuantityUnit, RecommendationResultDto } from '@dafan/shared/types';
import type { DatabaseClient } from '../../db/database.js';
import type { LocalApiRouter } from '../../local-api/router.js';
import { localDate, readObject, sqlBoolean, validationError } from '../common.js';
import { forbidden, forbiddenWordsOf, type DinerRestrictionTexts } from '../diner-rules.js';
import { MEAL_TYPES } from '../stores/service.js';
import { convertQuantity } from '../units.js';

type Source = 'RECIPE' | 'STORE';
type Acquisition = 'DINE_IN' | 'TAKEOUT';
type Candidate = RecommendationResultDto & {
  resultType: Source;
  resultId: string;
  score: number;
  mealRoles?: string[];
};

interface Input {
  mealType?: MealType;
  dinerIds: string[];
  sourceTypes: Source[];
  acquisitionModes: Acquisition[];
  inventoryOnly: boolean;
  favoriteOnly: boolean;
  repeatDays?: number;
}

function list<T extends string>(value: unknown, field: string, allowed?: readonly T[]): T[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || (allowed && !allowed.includes(item as T)))
  ) {
    throw validationError(`${field} 无效`);
  }
  return [...new Set(value as T[])];
}

function parseInput(body: Record<string, unknown>): Input {
  if (body.mealType !== undefined && !MEAL_TYPES.includes(body.mealType as MealType))
    throw validationError('mealType 无效');
  for (const field of ['inventoryOnly', 'favoriteOnly', 'allowPurchase']) {
    if (body[field] !== undefined && typeof body[field] !== 'boolean')
      throw validationError(`${field} 必须是布尔值`);
  }
  const repeatDays = body.repeatDays;
  if (
    repeatDays !== undefined &&
    (typeof repeatDays !== 'number' ||
      !Number.isInteger(repeatDays) ||
      repeatDays < 0 ||
      repeatDays > 365)
  ) {
    throw validationError('repeatDays 必须是 0 至 365 的整数');
  }
  return {
    mealType: body.mealType as MealType | undefined,
    dinerIds: list(body.dinerIds, 'dinerIds'),
    sourceTypes:
      body.sourceTypes === undefined
        ? ['RECIPE', 'STORE']
        : list(body.sourceTypes, 'sourceTypes', ['RECIPE', 'STORE']),
    acquisitionModes: list(body.acquisitionModes, 'acquisitionModes', ['DINE_IN', 'TAKEOUT']),
    inventoryOnly: body.inventoryOnly === true,
    favoriteOnly: body.favoriteOnly === true,
    repeatDays,
  };
}

interface RecipeRow {
  id: string;
  name: string;
  ingredientsText: string | null;
  notes: string | null;
  favorite: boolean | number;
}
interface IngredientRow {
  recipeId: string;
  ingredientId: string | null;
  ingredientNameSnapshot: string;
  quantity: number | null;
  unit: QuantityUnit | null;
  optional: boolean | number;
}
interface StockRow {
  ingredientId: string;
  quantity: number;
  unit: QuantityUnit;
}

function groupBy<T>(rows: T[], keyOf: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

async function recipeCandidates(
  db: DatabaseClient,
  input: Input,
  now: Date,
  words: string[],
  recent: Set<string>,
): Promise<Candidate[]> {
  const today = localDate(now);
  const [rows, ingredients, stock, roles] = await Promise.all([
    db.query<RecipeRow>(
      `SELECT r."id", r."name", r."ingredientsText", r."notes", r."favorite"
      FROM "Recipe" r WHERE r."deletedAt" IS NULL AND r."enabledForRecommendation" = 1
       AND (? = 0 OR r."favorite" = 1)
       AND (? IS NULL OR EXISTS (SELECT 1 FROM "RecipeMealType" mt WHERE mt."recipeId" = r."id" AND mt."mealType" = ?))
       AND NOT EXISTS (SELECT 1 FROM "RecipeTool" rt LEFT JOIN "KitchenTool" t ON t."id" = rt."toolId"
        WHERE rt."recipeId" = r."id" AND rt."required" = 1 AND (t."id" IS NULL OR t."deletedAt" IS NOT NULL OR t."quantity" <= 0
          OR upper(COALESCE(t."status", '')) IN ('BROKEN', 'MISSING', 'UNAVAILABLE')))`,
      [input.favoriteOnly, input.mealType ?? null, input.mealType ?? null],
    ),
    db.query<IngredientRow>(`SELECT i.* FROM "RecipeIngredient" i JOIN "Recipe" r ON r."id" = i."recipeId"
      WHERE r."deletedAt" IS NULL AND r."enabledForRecommendation" = 1 ORDER BY i."sortOrder", i.rowid`),
    db.query<StockRow>(
      `SELECT b."ingredientId", b."quantity", b."unit" FROM "InventoryBatch" b JOIN "Ingredient" i ON i."id" = b."ingredientId"
      WHERE b."deletedAt" IS NULL AND i."deletedAt" IS NULL AND b."quantity" > 0 AND (b."expiryDate" IS NULL OR b."expiryDate" >= ?)
      UNION ALL SELECT i."id", i."quantity", i."unit" FROM "Ingredient" i WHERE i."deletedAt" IS NULL AND i."quantity" > 0
      AND (i."expiryDate" IS NULL OR i."expiryDate" >= ?) AND NOT EXISTS (
        SELECT 1 FROM "InventoryBatch" b WHERE b."ingredientId" = i."id" AND b."deletedAt" IS NULL AND b."quantity" > 0)`,
      [today, today],
    ),
    db.query<{ recipeId: string; mealRole: string }>(
      'SELECT "recipeId", "mealRole" FROM "RecipeMealRole" ORDER BY rowid',
    ),
  ]);
  const stockByIngredient = groupBy(stock, (row) => row.ingredientId);
  const ingredientsByRecipe = groupBy(ingredients, (row) => row.recipeId);
  const rolesByRecipe = groupBy(roles, (row) => row.recipeId);
  return rows.flatMap((row) => {
    const ingredients = ingredientsByRecipe.get(row.id) ?? [];
    const haystack = [
      row.name,
      row.ingredientsText,
      row.notes,
      ...ingredients.map((item) => item.ingredientNameSnapshot),
    ]
      .filter(Boolean)
      .join(' ');
    if (forbidden(haystack, words)) return [];
    const missingIngredients = ingredients
      .filter((item) => {
        if (sqlBoolean(item.optional)) return false;
        const { ingredientId, quantity, unit } = item;
        if (!ingredientId || quantity === null || unit === null) return true;
        const available = (stockByIngredient.get(ingredientId) ?? []).reduce(
          (sum, batch) => sum + (convertQuantity(batch.quantity, batch.unit, unit) ?? 0),
          0,
        );
        return available < quantity;
      })
      .map((item) => item.ingredientNameSnapshot);
    if (input.inventoryOnly && missingIngredients.length) return [];
    return [
      {
        resultType: 'RECIPE',
        resultId: row.id,
        title: row.name,
        reason: missingIngredients.length
          ? `还缺 ${missingIngredients.length} 种食材`
          : '现有库存可以完成',
        missingIngredients,
        score:
          (sqlBoolean(row.favorite) ? 30 : 0) +
          (missingIngredients.length ? 0 : 25) -
          (recent.has(row.id) ? 40 : 0) +
          (ingredients.length ? 5 : 0),
        mealRoles: (rolesByRecipe.get(row.id) ?? []).map((role) => role.mealRole),
      },
    ];
  });
}

async function storeCandidates(
  db: DatabaseClient,
  input: Input,
  words: string[],
  recent: Set<string>,
): Promise<Candidate[]> {
  const rows = await db.query<{
    id: string;
    name: string;
    haystack: string;
    rating: number | null;
    favorite: boolean | number;
  }>(
    `SELECT s."id", s."name", s."rating", s."favorite", s."name" || ' ' || COALESCE(s."cuisine", '') || ' ' ||
     COALESCE(s."recommendedDishes", '') || ' ' || COALESCE(s."avoidDishes", '') || ' ' || COALESCE(s."tagsText", '') || ' ' || COALESCE(s."notes", '') AS haystack
     FROM "Store" s WHERE s."deletedAt" IS NULL AND (? = 0 OR s."favorite" = 1)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM "StoreMealType" mt WHERE mt."storeId" = s."id" AND mt."mealType" = ?))
      AND (? = 0 OR (? = 1 AND s."supportsDineIn" = 1) OR (? = 1 AND s."supportsTakeout" = 1))`,
    [
      input.favoriteOnly,
      input.mealType ?? null,
      input.mealType ?? null,
      input.acquisitionModes.length,
      input.acquisitionModes.includes('DINE_IN'),
      input.acquisitionModes.includes('TAKEOUT'),
    ],
  );
  return rows
    .filter((row) => !forbidden(row.haystack, words))
    .map((row) => ({
      resultType: 'STORE',
      resultId: row.id,
      title: row.name,
      reason: row.rating == null ? '符合本次用餐条件' : `评分 ${row.rating}`,
      missingIngredients: [],
      score:
        (sqlBoolean(row.favorite) ? 30 : 0) + (row.rating ?? 0) * 4 - (recent.has(row.id) ? 40 : 0),
    }));
}

function weightedCandidate(candidates: Candidate[]) {
  const top = candidates
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, 5);
  if (!top.length) return undefined;
  const floor = top.at(-1)!.score;
  const weights = top.map((candidate) => candidate.score - floor + 1);
  let sample = Math.random() * weights.reduce((sum, weight) => sum + weight, 0);
  return top.find((_candidate, index) => (sample -= weights[index]!) < 0) ?? top.at(-1);
}

async function recommend(db: DatabaseClient, input: Input, now: Date) {
  const [setting] =
    input.repeatDays === undefined
      ? await db.query<{ defaultRepeatDays: number }>(
          'SELECT "defaultRepeatDays" FROM "Settings" WHERE "id" = 1',
        )
      : [];
  const repeatDays = input.repeatDays ?? setting?.defaultRepeatDays ?? 0;
  const [diners, recent] = await Promise.all([
    input.dinerIds.length
      ? db.query<DinerRestrictionTexts>(
          `SELECT "allergyText", "tabooText", "dislikesText" FROM "Diner" WHERE "active" = 1 AND "id" IN (SELECT value FROM json_each(?))`,
          [JSON.stringify(input.dinerIds)],
        )
      : [],
    // repeatDays <= 0 表示关闭「近期已吃」扣分：窗口为空，绝不给 -40。
    repeatDays <= 0
      ? []
      : db.query<{ recipeId: string | null; storeId: string | null }>(
          `SELECT DISTINCT i."recipeId", i."storeId"
      FROM "MealRecordItem" i JOIN "MealRecord" m ON m."id" = i."mealRecordId"
      WHERE m."deletedAt" IS NULL AND m."status" = 'CONFIRMED' AND m."recordDate" >= ?`,
          [localDate(now, -repeatDays)],
        ),
  ]);
  const words = forbiddenWordsOf(diners);
  const [recipes, stores] = await Promise.all([
    input.sourceTypes.includes('RECIPE')
      ? recipeCandidates(
          db,
          input,
          now,
          words,
          new Set(recent.flatMap((row) => row.recipeId ?? [])),
        )
      : [],
    input.sourceTypes.includes('STORE')
      ? storeCandidates(db, input, words, new Set(recent.flatMap((row) => row.storeId ?? [])))
      : [],
  ]);
  const candidates = [...recipes, ...stores];
  const selected = weightedCandidate(candidates);
  return { type: 'SINGLE', candidateCount: candidates.length, results: selected ? [selected] : [] };
}

export function registerRecommendations(
  router: LocalApiRouter,
  getDatabase: () => Promise<DatabaseClient>,
) {
  const now = router.options.now ?? (() => new Date());
  router.register('POST', '/api/v1/recommendations/random', async ({ request }) => {
    const input = parseInput(await readObject(request, true));
    return recommend(await getDatabase(), input, now());
  });
}
