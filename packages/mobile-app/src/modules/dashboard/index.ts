import type { DashboardDto, DashboardMealSlot, DashboardRecipe } from '@dafan/shared/types';
import type { DatabaseClient } from '../../db/database.js';
import { LocalApiError } from '../../local-api/protocol.js';
import type { LocalApiRouter } from '../../local-api/router.js';
import { localDate } from '../common.js';
import { forbidden, forbiddenWordsOf, type DinerRestrictionTexts } from '../diner-rules.js';
import { readBranding } from '../settings/service.js';

const SLOTS: ReadonlyArray<Pick<DashboardMealSlot, 'mealType' | 'label'>> = [
  { mealType: 'BREAKFAST', label: '早餐' },
  { mealType: 'LUNCH', label: '午餐' },
  { mealType: 'DINNER', label: '晚餐' },
];
const GREETINGS = {
  morning: ['早上好', '今天也要好好吃饭呀～'],
  afternoon: ['下午好', '忙碌之中，也别忘了好好吃饭～'],
  evening: ['晚上好', '辛苦啦，给今天准备一顿温柔的晚餐吧～'],
} as const;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

async function recommendedRecipes(db: DatabaseClient): Promise<DashboardRecipe[]> {
  const [diners, rows, tags] = await Promise.all([
    db.query<DinerRestrictionTexts>(
      'SELECT "allergyText", "tabooText", "dislikesText" FROM "Diner" WHERE "active" = 1',
    ),
    db.query<
      Omit<DashboardRecipe, 'tags'> & { haystack: string }
    >(`SELECT r."id", r."name", r."imagePath", r."category", r."cookingTimeMinutes",
       r."name" || ' ' || COALESCE(r."ingredientsText", '') || ' ' || COALESCE(r."notes", '') || ' ' ||
         COALESCE((SELECT GROUP_CONCAT(i."ingredientNameSnapshot", ' ') FROM "RecipeIngredient" i WHERE i."recipeId" = r."id"), '') AS haystack,
       (SELECT ROUND(AVG(m."rating"), 1) FROM "MealRecordItem" ri JOIN "MealRecord" m ON m."id" = ri."mealRecordId"
         WHERE ri."recipeId" = r."id" AND m."status" = 'CONFIRMED' AND m."deletedAt" IS NULL) AS rating
       FROM "Recipe" r WHERE r."deletedAt" IS NULL AND r."enabledForRecommendation" = 1 ORDER BY r."createdAt", r.rowid`),
    db.query<{ recipeId: string; name: string }>(
      `SELECT rt."recipeId", t."name" FROM "RecipeTag" rt JOIN "Tag" t ON t."id" = rt."tagId" ORDER BY rt.rowid`,
    ),
  ]);
  const words = forbiddenWordsOf(diners);
  const tagsByRecipe = new Map<string, string[]>();
  for (const row of tags) {
    const group = tagsByRecipe.get(row.recipeId) ?? [];
    group.push(row.name);
    tagsByRecipe.set(row.recipeId, group);
  }
  return rows
    .filter((row) => !forbidden(row.haystack, words))
    .slice(0, 6)
    .map((row) => ({
      id: row.id,
      name: row.name,
      imagePath: row.imagePath,
      category: row.category,
      cookingTimeMinutes: row.cookingTimeMinutes,
      rating: row.rating,
      tags: tagsByRecipe.get(row.id) ?? [],
    }));
}

async function dashboard(db: DatabaseClient, now: Date): Promise<DashboardDto> {
  const currentDate = localDate(now);
  const monday = new Date(now);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const nextMonday = new Date(monday);
  nextMonday.setDate(nextMonday.getDate() + 7);
  const weekStart = localDate(monday);
  const weekEnd = localDate(monday, 6);
  const expiryLimit = localDate(now, 3);
  const [
    branding,
    account,
    recipes,
    today,
    week,
    history,
    plans,
    inventory,
    expiring,
    consumption,
  ] = await Promise.all([
    readBranding(db),
    db.query<{ userNickname: string | null }>(
      'SELECT "userNickname" FROM "device_local_config" WHERE "id" = 1',
    ),
    recommendedRecipes(db),
    db.query<{
      mealType: string;
      sourceType: string;
      recordTime: string | null;
      title: string | null;
      rating: number | null;
    }>(
      `SELECT m."mealType", m."sourceType", m."recordTime", m."rating",
        (SELECT COALESCE(i."customName", r."name", s."name") FROM "MealRecordItem" i
          LEFT JOIN "Recipe" r ON r."id" = i."recipeId" LEFT JOIN "Store" s ON s."id" = i."storeId"
          WHERE i."mealRecordId" = m."id" ORDER BY i."sortOrder", i.rowid LIMIT 1) AS title
       FROM "MealRecord" m WHERE m."recordDate" = ? AND m."status" = 'CONFIRMED' AND m."deletedAt" IS NULL
       ORDER BY m."createdAt", m.rowid`,
      [currentDate],
    ),
    db.query<{ recordDate: string; rating: number | null }>(
      `SELECT "recordDate", "rating" FROM "MealRecord" WHERE "recordDate" BETWEEN ? AND ? AND "status" = 'CONFIRMED' AND "deletedAt" IS NULL`,
      [weekStart, weekEnd],
    ),
    db.query<{ recordDate: string }>(
      `SELECT DISTINCT "recordDate" FROM "MealRecord" WHERE "recordDate" <= ? AND "status" = 'CONFIRMED' AND "deletedAt" IS NULL`,
      [currentDate],
    ),
    db.query<{ planDate: string }>(
      `SELECT DISTINCT "planDate" FROM "MealPlan" WHERE "planDate" BETWEEN ? AND ? AND "status" IN ('PLANNED', 'COMPLETED') AND "deletedAt" IS NULL`,
      [weekStart, weekEnd],
    ),
    db.query<Omit<DashboardDto['inventory'], 'expiringIngredients'>>(
      `SELECT COUNT(*) AS totalIngredients,
        COUNT(CASE WHEN "expiryDate" BETWEEN ? AND ? THEN 1 END) AS expiringSoon,
        COUNT(CASE WHEN "quantity" < "minStock" THEN 1 END) AS insufficient
       FROM "Ingredient" WHERE "deletedAt" IS NULL`,
      [currentDate, expiryLimit],
    ),
    db.query<DashboardDto['inventory']['expiringIngredients'][number]>(
      `SELECT "id", "name", "expiryDate", "quantity", "unit" FROM "Ingredient"
       WHERE "deletedAt" IS NULL AND "expiryDate" BETWEEN ? AND ? ORDER BY "expiryDate", rowid LIMIT 5`,
      [currentDate, expiryLimit],
    ),
    db.query<{ count: number }>(
      `SELECT COUNT(DISTINCT COALESCE("ingredientId", "ingredientNameSnapshot")) AS count FROM "InventoryLog"
       WHERE "changeType" = 'COOK_DEDUCT' AND julianday("createdAt") >= julianday(?) AND julianday("createdAt") < julianday(?)`,
      [monday.toISOString(), nextMonday.toISOString()],
    ),
  ]);
  const hour = now.getHours();
  const greetingPeriod = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const [greeting, greetingText] = GREETINGS[greetingPeriod];
  const userNickname = account[0]?.userNickname ?? null;
  const recordDates = new Set(week.map((row) => row.recordDate));
  const allDates = new Set(history.map((row) => row.recordDate));
  const planDates = new Set(plans.map((row) => row.planDate));
  const todayBySlot = new Map(today.map((row) => [row.mealType, row]));
  const ratings = week.flatMap((row) => (row.rating === null ? [] : [row.rating]));
  let streakDays = 0;
  const anchor = allDates.has(currentDate) ? 0 : -1;
  while (allDates.has(localDate(now, anchor - streakDays))) streakDays++;
  const totals = inventory[0]!;
  return {
    generatedAt: now.toISOString(),
    branding,
    userNickname,
    currentDate,
    greetingPeriod,
    greetingText,
    greetingTitle: userNickname ? `${greeting}，${userNickname}` : greeting,
    recommendedRecipes: recipes,
    todayRecords: SLOTS.map((slot) => {
      const row = todayBySlot.get(slot.mealType);
      return {
        ...slot,
        time: row?.recordTime ?? null,
        recorded: !!row,
        title: row?.title ?? null,
        summary: row ? (row.sourceType === 'HOMEMADE' ? '在家制作' : '外出用餐') : null,
        rating: row?.rating ?? null,
      };
    }),
    inventory: { ...totals, expiringIngredients: expiring },
    weeklyStats: {
      recordedDays: recordDates.size,
      streakDays,
      totalMeals: week.length,
      averageRating: ratings.length
        ? Number((ratings.reduce((sum, value) => sum + value, 0) / ratings.length).toFixed(1))
        : null,
      consumedIngredientCount: consumption[0]?.count ?? 0,
    },
    calendarDays: Array.from({ length: 7 }, (_, index) => {
      const day = new Date(monday);
      day.setDate(day.getDate() + index);
      const date = localDate(day);
      return {
        date,
        weekday: WEEKDAYS[day.getDay()]!,
        dayOfMonth: day.getDate(),
        isToday: date === currentDate,
        status: recordDates.has(date) ? 'recorded' : planDates.has(date) ? 'planned' : 'empty',
      };
    }),
    tip:
      totals.expiringSoon > 0
        ? '优先消耗即将到期的食材，让每一份新鲜都不被浪费。'
        : '记得记录今天吃过的每一餐，慢慢找到适合自己的节奏。',
  };
}

export function registerDashboard(
  router: LocalApiRouter,
  getDatabase: () => Promise<DatabaseClient>,
) {
  const now = router.options.now ?? (() => new Date());
  router.register('GET', '/api/v1/dashboard', async () => {
    try {
      return await dashboard(await getDatabase(), now());
    } catch {
      throw new LocalApiError(503, 'DATABASE_ERROR', '首页数据暂时不可用');
    }
  });
}
