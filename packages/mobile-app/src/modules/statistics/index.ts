import type {
  MealRecordSourceType,
  StatisticsCostSummary,
  StatisticsDto,
  StatisticsSatietyBucket,
} from '@dafan/shared/types';
import type { DatabaseClient } from '../../db/database.js';
import type { SqlValue } from '../../db/types.js';
import type { LocalApiRouter } from '../../local-api/router.js';
import { localDate, sqlBoolean, validationError } from '../common.js';

const DAY_MS = 86_400_000;
const SATIETY: readonly [number, StatisticsSatietyBucket['category']][] = [
  [3, 'LOW'],
  [5, 'LOW'],
  [7, 'COMFORTABLE'],
  [8, 'COMFORTABLE'],
  [10, 'OVER'],
];

interface RecordRow {
  recordDate: string;
  mealType: string;
  sourceType: MealRecordSourceType;
  rating: number | null;
  calories: number | null;
  cost: number | null;
  satiety: number | null;
  isNewTry: number | boolean;
  favorite: number | boolean;
}

function parseDate(input: string) {
  const ms = Date.parse(`${input}T00:00:00.000Z`);
  if (
    !/^(?!0000)\d{4}-\d\d-\d\d$/.test(input) ||
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 10) !== input
  ) {
    throw validationError('统计起止日期必须是真实日历日期（YYYY-MM-DD）');
  }
  return ms;
}

function costSummary(records: RecordRow[]): StatisticsCostSummary {
  const summarize = (source?: MealRecordSourceType) => {
    const selected = source ? records.filter((row) => row.sourceType === source) : records;
    const prices = selected.flatMap((row) => (row.cost === null ? [] : [row.cost]));
    return {
      total: prices.length ? prices.reduce((sum, cost) => sum + cost, 0) : null,
      priced: prices.length,
      count: selected.length,
    };
  };
  const total = summarize();
  const takeout = summarize('TAKEOUT');
  const dineIn = summarize('DINE_IN');
  const homemade = summarize('HOMEMADE');
  return {
    totalCost: total.total,
    pricedRecordCount: total.priced,
    recordCount: total.count,
    takeoutCost: takeout.total,
    takeoutRecordCount: takeout.count,
    takeoutPricedCount: takeout.priced,
    takeoutPricedRecordCount: takeout.priced,
    dineInCost: dineIn.total,
    dineInRecordCount: dineIn.count,
    dineInPricedCount: dineIn.priced,
    dineInPricedRecordCount: dineIn.priced,
    homemadeCost: homemade.total,
    homemadeRecordCount: homemade.count,
    homemadePricedRecordCount: homemade.priced,
    customRecordCount: total.count - takeout.count - dineIn.count - homemade.count,
  };
}

function satietySummary(records: RecordRow[]) {
  const distribution = SATIETY.map(([satiety, category]) => ({
    satiety,
    category,
    count: records.filter((record) => record.satiety === satiety).length,
  }));
  const recordedCount = records.filter((record) => record.satiety !== null).length;
  const lowCount = distribution[0]!.count + distribution[1]!.count;
  const comfortableCount = distribution[2]!.count + distribution[3]!.count;
  const overCount = distribution[4]!.count;
  const percent = (count: number) =>
    recordedCount ? Number(((100 * count) / recordedCount).toFixed(1)) : null;
  return {
    distribution,
    recordedCount,
    lowCount,
    comfortableCount,
    overCount,
    lowPercent: percent(lowCount),
    comfortablePercent: percent(comfortableCount),
    overPercent: percent(overCount),
  };
}

function counts(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries(counts);
}

async function statistics(
  database: DatabaseClient,
  query: URLSearchParams,
  now: Date,
): Promise<StatisticsDto> {
  const start = query.get('start') ?? localDate(now, -((now.getDay() + 6) % 7));
  const end = query.get('end') ?? localDate(now);
  const first = parseDate(start);
  const last = parseDate(end);
  const days = (last - first) / DAY_MS + 1;
  if (days < 1 || days > 3660) throw validationError('统计起止日期顺序无效或区间超过 3660 天');

  const dinerId = query.get('dinerId');
  const scope = `r."deletedAt" IS NULL AND r."status" = 'CONFIRMED' AND r."recordDate" BETWEEN ? AND ?
    ${dinerId ? 'AND EXISTS (SELECT 1 FROM "MealRecordDiner" d WHERE d."mealRecordId" = r."id" AND d."dinerId" = ?)' : ''}`;
  const params: SqlValue[] = dinerId ? [start, end, dinerId] : [start, end];
  const timestampRange = [
    new Date(`${start}T00:00:00`).toISOString(),
    new Date(`${end}T23:59:59.999`).toISOString(),
  ];
  const top = async (table: 'Recipe' | 'Store', column: 'recipeId' | 'storeId') => {
    const rows = await database.query<{ id: string; name: string; count: number }>(
      `SELECT t."id", t."name", COUNT(*) AS count FROM "MealRecord" r
       JOIN "MealRecordItem" i ON i."mealRecordId" = r."id"
       JOIN "${table}" t ON t."id" = i."${column}"
       WHERE ${scope} GROUP BY t."id", t."name"`,
      params,
    );
    return rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 10);
  };
  const [records, topRecipes, topStores, consumption, shopping] = await Promise.all([
    database.query<RecordRow>(`SELECT r.* FROM "MealRecord" r WHERE ${scope}`, params),
    top('Recipe', 'recipeId'),
    top('Store', 'storeId'),
    database.query<StatisticsDto['ingredientConsumption'][number] & { changeQuantity: number }>(
      `SELECT "ingredientId", "ingredientNameSnapshot" AS name, "unit", "changeQuantity"
       FROM "InventoryLog" WHERE "changeType" = 'COOK_DEDUCT' AND julianday("createdAt") BETWEEN julianday(?) AND julianday(?)`,
      timestampRange,
    ),
    database.query<{ count: number; completed: number | null }>(
      `SELECT COUNT(*) AS count, SUM(CASE WHEN i."completed" = 1 THEN 1 ELSE 0 END) AS completed
       FROM "ShoppingListItem" i JOIN "ShoppingList" s ON s."id" = i."shoppingListId"
       WHERE s."deletedAt" IS NULL AND julianday(i."createdAt") BETWEEN julianday(?) AND julianday(?)`,
      timestampRange,
    ),
  ]);
  const byDate = counts(records.map((row) => row.recordDate));
  const calorieTotals = new Map<string, { calories: number; recordedCaloriesCount: number }>();
  for (const row of records) {
    if (row.calories === null) continue;
    const value = calorieTotals.get(row.recordDate) ?? { calories: 0, recordedCaloriesCount: 0 };
    value.calories += row.calories;
    value.recordedCaloriesCount++;
    calorieTotals.set(row.recordDate, value);
  }
  const consumedByIngredient = new Map<string, StatisticsDto['ingredientConsumption'][number]>();
  for (const log of consumption) {
    const key = JSON.stringify([log.ingredientId ?? log.name, log.unit]);
    const value = consumedByIngredient.get(key) ?? {
      ingredientId: log.ingredientId,
      name: log.name,
      unit: log.unit,
      quantity: 0,
    };
    value.quantity += Math.abs(log.changeQuantity);
    consumedByIngredient.set(key, value);
  }
  const ratings = records.flatMap((record) => (record.rating === null ? [] : [record.rating]));
  const [shoppingTotals] = shopping;
  return {
    period: { start, end },
    totalRecords: records.length,
    totalMeals: records.length,
    recordedDays: Object.keys(byDate).length,
    sourceBreakdown: counts(records.map((record) => record.sourceType)),
    mealTypeDistribution: counts(records.map((record) => record.mealType)),
    newTryCount: records.filter((record) => sqlBoolean(record.isNewTry)).length,
    favoriteCount: records.filter((record) => sqlBoolean(record.favorite)).length,
    averageRating: ratings.length
      ? Number((ratings.reduce((total, rating) => total + rating, 0) / ratings.length).toFixed(2))
      : null,
    topRecipes,
    topStores,
    trend: Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count })),
    ingredientConsumption: [...consumedByIngredient.values()],
    shoppingCompletionRate: shoppingTotals?.count
      ? (shoppingTotals.completed ?? 0) / shoppingTotals.count
      : null,
    calorieTrend: Array.from({ length: days }, (_, i) => {
      const date = new Date(first + i * DAY_MS).toISOString().slice(0, 10);
      return { date, ...(calorieTotals.get(date) ?? { calories: null, recordedCaloriesCount: 0 }) };
    }),
    costSummary: costSummary(records),
    satietySummary: satietySummary(records),
  };
}

export function registerStatistics(
  router: LocalApiRouter,
  getDatabase: () => Promise<DatabaseClient>,
) {
  const now = router.options.now ?? (() => new Date());
  router.register('GET', '/api/v1/statistics', async ({ query }) =>
    statistics(await getDatabase(), query, now()),
  );
}
