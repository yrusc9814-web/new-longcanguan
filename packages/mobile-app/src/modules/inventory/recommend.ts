/**
 * 厨房库荐（与上游 `app/server/src/modules/inventory/service.ts` 的
 * `recommendFromInventory` 同源，读路径改为 SQLite SELECT）。
 *
 * 契约与上游一致：`{ mode, candidateCount, items }`，items 按
 * completion/wasteScore 排序，最多 100 条，默认 20 条。
 *
 * 与 Prisma 的差异（结论不变）：
 * - 过期判断用设备本地日期（`router.options.now`），避免 UTC 跨日偏差；
 * - 全部走 `database.query`，不做自愈落库、不写发件箱；
 * - `include: { tools: { include: { tool: true } } }` 用 LEFT JOIN 展开。
 */
import type { QuantityUnit } from '@dafan/shared/types';

import type { DatabaseClient } from '../../db/database.js';
import { localDate, readObject, sqlBoolean, validationError } from '../common.js';
import { forbidden, forbiddenWordsOf } from '../diner-rules.js';
import { withImplicitBatch, type AggregatableBatch } from '../ingredients/batches.js';
import { convertQuantity } from '../units.js';

export type InventoryRecommendationMode = 'ONLY_INVENTORY' | 'ALLOW_PURCHASE' | 'MUST_CONSUME';

const MODES: readonly InventoryRecommendationMode[] = [
  'ONLY_INVENTORY',
  'ALLOW_PURCHASE',
  'MUST_CONSUME',
];

export interface InventoryRecommendationInput {
  readonly mode: InventoryRecommendationMode;
  readonly dinerIds?: readonly string[];
  readonly ingredientIds?: readonly string[];
  readonly limit?: number;
}

export interface RecommendedIngredient {
  readonly ingredientId: string;
  readonly name: string;
  readonly required: number | null;
  readonly available: number;
  readonly unit: QuantityUnit | null;
}

export interface MissingIngredient {
  readonly ingredientId: string | null;
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: QuantityUnit | null;
  readonly reason: string;
}

export interface InventoryRecommendationItem {
  readonly recipe: {
    readonly id: string;
    readonly name: string;
    readonly imagePath: string | null;
    readonly cookingTimeMinutes: number | null;
  };
  readonly existingIngredients: RecommendedIngredient[];
  readonly missingIngredients: MissingIngredient[];
  readonly missingTools: string[];
  readonly completion: number;
  readonly inventoryCheckable: boolean;
  readonly completionLabel: string;
  readonly wasteScore: number;
  readonly consumesRequested: boolean;
  readonly reason: string;
}

export interface InventoryRecommendationResult {
  readonly mode: InventoryRecommendationMode;
  readonly candidateCount: number;
  readonly items: InventoryRecommendationItem[];
}

interface RecipeRow {
  readonly id: string;
  readonly name: string;
  readonly imagePath: string | null;
  readonly ingredientsText: string | null;
  readonly notes: string | null;
  readonly cookingTimeMinutes: number | null;
}

interface RecipeIngredientRow {
  readonly recipeId: string;
  readonly ingredientId: string | null;
  readonly ingredientNameSnapshot: string;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly optional: number | boolean;
}

interface RecipeToolRow {
  readonly recipeId: string;
  readonly toolNameSnapshot: string;
  readonly required: number | boolean;
  readonly tool_id: string | null;
  readonly tool_deletedAt: string | null;
  readonly tool_quantity: number | null;
  readonly tool_status: string | null;
}

/** 活批次 + 关联食材的汇总字段（仅用于临期/超量评分）。 */
interface StockRow extends AggregatableBatch {
  readonly maxStock: number | null;
  readonly totalQuantity: number;
}

interface IngredientStockRow {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly unit: string;
  readonly purchaseDate: string | null;
  readonly expiryDate: string | null;
  readonly location: string | null;
  readonly maxStock: number | null;
  readonly opened: number | boolean;
}

interface DinerRestrictionRow {
  readonly allergyText: string | null;
  readonly tabooText: string | null;
  readonly dislikesText: string | null;
}

function placeholderList(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function readMode(value: unknown): InventoryRecommendationMode {
  if (typeof value === 'string' && (MODES as readonly string[]).includes(value)) {
    return value as InventoryRecommendationMode;
  }
  throw validationError('库存推荐模式无效');
}

function readStringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw validationError(`${field} 必须是字符串数组`);
  }
  return [...(value as string[])];
}

function readLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw validationError('limit 必须是大于等于 1 的整数');
  }
  return value;
}

/** 与上游 Fastify body schema 一致：mode 必填且限枚举，其余字段可选。 */
export function parseRecommendationInput(
  body: Record<string, unknown>,
): InventoryRecommendationInput {
  const mode = readMode(body.mode);
  const dinerIds = readStringList(body.dinerIds, 'dinerIds');
  const ingredientIds = readStringList(body.ingredientIds, 'ingredientIds');
  const limit = readLimit(body.limit);
  return {
    mode,
    ...(dinerIds ? { dinerIds } : {}),
    ...(ingredientIds ? { ingredientIds } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

export async function readRecommendationInput(
  request: Request,
): Promise<InventoryRecommendationInput> {
  return parseRecommendationInput(await readObject(request));
}

/** 上游 `availableQuantity`：只累计单位可换算的批次。 */
function availableQuantity(
  batches: readonly { quantity: number; unit: QuantityUnit }[],
  requiredUnit: QuantityUnit | null,
): { quantity: number; convertible: boolean } {
  if (!requiredUnit) return { quantity: 0, convertible: false };
  let convertible = false;
  const quantity = batches.reduce((total, batch) => {
    const value = convertQuantity(batch.quantity, batch.unit, requiredUnit);
    if (value == null) return total;
    convertible = true;
    return total + value;
  }, 0);
  return { quantity, convertible };
}

async function loadRecipeRows(database: DatabaseClient): Promise<RecipeRow[]> {
  return database.query<RecipeRow>(
    `SELECT "id", "name", "imagePath", "ingredientsText", "notes", "cookingTimeMinutes"
     FROM "Recipe" WHERE "deletedAt" IS NULL AND "enabledForRecommendation" = 1
     ORDER BY rowid ASC`,
  );
}

async function loadRecipeIngredients(
  database: DatabaseClient,
): Promise<Map<string, RecipeIngredientRow[]>> {
  const grouped = new Map<string, RecipeIngredientRow[]>();
  const rows = await database.query<RecipeIngredientRow>(
    `SELECT ri."recipeId", ri."ingredientId", ri."ingredientNameSnapshot", ri."quantity", ri."unit", ri."optional"
     FROM "RecipeIngredient" ri JOIN "Recipe" r ON r."id" = ri."recipeId"
     WHERE r."deletedAt" IS NULL AND r."enabledForRecommendation" = 1
     ORDER BY ri."sortOrder" ASC, ri.rowid ASC`,
  );
  for (const row of rows) {
    const group = grouped.get(row.recipeId) ?? [];
    group.push(row);
    grouped.set(row.recipeId, group);
  }
  return grouped;
}

async function loadRecipeTools(database: DatabaseClient): Promise<Map<string, RecipeToolRow[]>> {
  const grouped = new Map<string, RecipeToolRow[]>();
  const rows = await database.query<RecipeToolRow>(
    `SELECT rt."recipeId", rt."toolNameSnapshot", rt."required",
            kt."id" AS "tool_id", kt."deletedAt" AS "tool_deletedAt",
            kt."quantity" AS "tool_quantity", kt."status" AS "tool_status"
     FROM "RecipeTool" rt JOIN "Recipe" r ON r."id" = rt."recipeId"
     LEFT JOIN "KitchenTool" kt ON kt."id" = rt."toolId"
     WHERE r."deletedAt" IS NULL AND r."enabledForRecommendation" = 1
     ORDER BY rt.rowid ASC`,
  );
  for (const row of rows) {
    const group = grouped.get(row.recipeId) ?? [];
    group.push(row);
    grouped.set(row.recipeId, group);
  }
  return grouped;
}

/**
 * 存量自愈：`quantity > 0` 却没有活批次的旧食材，按食材汇总派生等效批次参与齐备度计算。
 * 只计算不落库，避免推荐这种读操作产生写副作用。
 */
async function loadStock(
  database: DatabaseClient,
  today: string,
): Promise<{
  batches: StockRow[];
  byIngredient: Map<string, StockRow[]>;
}> {
  const batchRows = await database.query<
    Omit<StockRow, 'maxStock' | 'totalQuantity'> & {
      maxStock: number | null;
      totalQuantity: number;
    }
  >(
    `SELECT b."ingredientId", b."quantity", b."unit", b."expiryDate", b."consumePriority", b."opened",
            i."maxStock" AS "maxStock", i."quantity" AS "totalQuantity"
     FROM "InventoryBatch" b JOIN "Ingredient" i ON i."id" = b."ingredientId"
     WHERE b."deletedAt" IS NULL AND b."quantity" > 0 AND i."deletedAt" IS NULL
       AND (b."expiryDate" IS NULL OR b."expiryDate" >= ?)
     ORDER BY b.rowid ASC`,
    [today],
  );
  const stockRows: StockRow[] = batchRows.map((row) => ({
    ingredientId: row.ingredientId,
    quantity: row.quantity,
    unit: row.unit as QuantityUnit,
    expiryDate: row.expiryDate,
    consumePriority: sqlBoolean(row.consumePriority),
    opened: sqlBoolean(row.opened),
    maxStock: row.maxStock,
    totalQuantity: row.totalQuantity,
  }));

  const storedIngredients = await database.query<IngredientStockRow>(
    `SELECT "id", "name", "quantity", "unit", "purchaseDate", "expiryDate", "location", "maxStock", "opened"
     FROM "Ingredient" WHERE "deletedAt" IS NULL ORDER BY rowid ASC`,
  );
  // 只要有该食材的任何正数量批次行（哪怕已过期），就说明它不是「从未建过批次」的历史存量：
  // 绝不能把过期/不合格批次再派生一份等效库存来“自愈”，否则会把已过期食材误判为齐备。
  const stocked = await database.query<{ ingredientId: string }>(
    `SELECT DISTINCT "ingredientId" FROM "InventoryBatch"
     WHERE "deletedAt" IS NULL AND "quantity" > 0`,
  );
  const stockedIngredientIds = new Set(stocked.map((row) => row.ingredientId));

  const byIngredient = new Map<string, StockRow[]>();
  for (const batch of stockRows) {
    const group = byIngredient.get(batch.ingredientId) ?? [];
    group.push(batch);
    byIngredient.set(batch.ingredientId, group);
  }

  for (const ingredient of storedIngredients) {
    const existing = byIngredient.get(ingredient.id) ?? [];
    if (existing.some((batch) => batch.quantity > 0)) continue;
    if (!(ingredient.quantity > 0)) continue;
    if (stockedIngredientIds.has(ingredient.id)) continue;
    // 过期存量不算可用：与活批次过滤口径一致。
    if (ingredient.expiryDate && ingredient.expiryDate < today) continue;
    const implicit = withImplicitBatch(
      {
        ingredientId: ingredient.id,
        name: ingredient.name,
        quantity: ingredient.quantity,
        unit: ingredient.unit as QuantityUnit,
        purchaseDate: ingredient.purchaseDate,
        expiryDate: ingredient.expiryDate,
        location: ingredient.location,
        opened: sqlBoolean(ingredient.opened),
      },
      [] as StockRow[],
    )[0] as AggregatableBatch | undefined;
    if (!implicit) continue;
    const row: StockRow = {
      ingredientId: implicit.ingredientId,
      quantity: implicit.quantity,
      unit: implicit.unit,
      expiryDate: implicit.expiryDate,
      consumePriority: implicit.consumePriority,
      opened: implicit.opened,
      maxStock: ingredient.maxStock,
      totalQuantity: ingredient.quantity,
    };
    byIngredient.set(ingredient.id, [row]);
    stockRows.push(row);
  }

  return { batches: stockRows, byIngredient };
}

async function loadForbiddenWords(
  database: DatabaseClient,
  dinerIds: readonly string[] | undefined,
): Promise<string[]> {
  if (!dinerIds?.length) return [];
  const diners = await database.query<DinerRestrictionRow>(
    `SELECT "allergyText", "tabooText", "dislikesText" FROM "Diner"
     WHERE "active" = 1 AND "id" IN (${placeholderList(dinerIds.length)})
     ORDER BY rowid ASC`,
    [...dinerIds],
  );
  return forbiddenWordsOf(diners);
}

function normalizeLimit(limit: number | undefined): number {
  return Math.min(100, Math.max(1, limit ?? 20));
}

export async function recommendFromInventory(
  database: DatabaseClient,
  input: InventoryRecommendationInput,
  now: () => Date,
): Promise<InventoryRecommendationResult> {
  const clock = now();
  const today = localDate(clock);
  const in24Hours = localDate(clock, 1);
  const in3Days = localDate(clock, 3);

  const [recipes, ingredientsByRecipe, toolsByRecipe] = await Promise.all([
    loadRecipeRows(database),
    loadRecipeIngredients(database),
    loadRecipeTools(database),
  ]);
  const { batches, byIngredient } = await loadStock(database, today);

  const forbiddenWords = await loadForbiddenWords(database, input.dinerIds);
  const blockedRecipeIds = new Set<string>();
  if (forbiddenWords.length) {
    for (const recipe of recipes) {
      const haystack = [
        recipe.name,
        recipe.ingredientsText,
        recipe.notes,
        ...(ingredientsByRecipe.get(recipe.id) ?? []).map((item) => item.ingredientNameSnapshot),
      ]
        .filter(Boolean)
        .join(' ');
      if (forbidden(haystack, forbiddenWords)) blockedRecipeIds.add(recipe.id);
    }
  }

  const requested = new Set(input.ingredientIds ?? []);
  const wasteIds = new Set(
    batches
      .filter(
        (batch) =>
          batch.consumePriority ||
          batch.opened ||
          Boolean(batch.expiryDate && batch.expiryDate >= today && batch.expiryDate <= in3Days) ||
          Boolean(batch.maxStock != null && batch.totalQuantity > batch.maxStock),
      )
      .map((batch) => batch.ingredientId),
  );

  const candidates = recipes
    .map((recipe): InventoryRecommendationItem => {
      const items = ingredientsByRecipe.get(recipe.id) ?? [];
      const existing: RecommendedIngredient[] = [];
      const missing: MissingIngredient[] = [];
      let requiredCount = 0;
      let satisfiedCount = 0;
      let wasteScore = 0;
      // 只有「数量 + 单位」都录入的配料才可核对库存；「盐少许」这类自由用量不计入齐备度。
      let structuredCount = 0;
      for (const item of items) {
        if (sqlBoolean(item.optional)) continue;
        requiredCount += 1;
        const stock = item.ingredientId ? (byIngredient.get(item.ingredientId) ?? []) : [];
        const unit = (item.unit ?? null) as QuantityUnit | null;
        if (item.quantity != null && unit != null) structuredCount += 1;
        if (!item.ingredientId || item.quantity == null || unit == null) {
          missing.push({
            ingredientId: item.ingredientId,
            name: item.ingredientNameSnapshot,
            quantity: item.quantity,
            unit,
            reason: !item.ingredientId ? '未关联库存食材' : '缺少可计算的数量或单位',
          });
          continue;
        }
        const available = availableQuantity(stock, unit);
        if (!available.convertible || available.quantity < item.quantity) {
          missing.push({
            ingredientId: item.ingredientId,
            name: item.ingredientNameSnapshot,
            quantity: Math.max(0, item.quantity - available.quantity),
            unit,
            reason: available.convertible ? '库存不足' : '库存单位不可换算',
          });
        } else {
          satisfiedCount += 1;
          existing.push({
            ingredientId: item.ingredientId,
            name: item.ingredientNameSnapshot,
            required: item.quantity,
            available: available.quantity,
            unit,
          });
        }
        if (item.ingredientId && wasteIds.has(item.ingredientId)) {
          wasteScore += 1;
          for (const batch of stock) {
            if (batch.consumePriority) wasteScore += 100;
            else if (batch.expiryDate && batch.expiryDate <= in24Hours && batch.expiryDate >= today)
              wasteScore += 50;
            else if (batch.expiryDate && batch.expiryDate <= in3Days && batch.expiryDate >= today)
              wasteScore += 25;
            if (batch.opened) wasteScore += 10;
          }
        }
      }

      const missingTools = (toolsByRecipe.get(recipe.id) ?? [])
        .filter(
          (link) =>
            sqlBoolean(link.required) &&
            (!link.tool_id ||
              link.tool_deletedAt !== null ||
              (link.tool_quantity ?? 0) <= 0 ||
              ['BROKEN', 'MISSING', 'UNAVAILABLE'].includes(
                (link.tool_status ?? '').toUpperCase(),
              )),
        )
        .map((link) => link.toolNameSnapshot);

      // 没有结构化配料的菜谱无法核对库存：按 0% 呈现，绝不混入「100% 可直接做」。
      const inventoryCheckable = structuredCount > 0;
      const completion = !inventoryCheckable
        ? 0
        : requiredCount === 0
          ? 100
          : Math.round((satisfiedCount / requiredCount) * 100);
      const consumesRequested =
        requested.size === 0 ||
        items.some((item) => item.ingredientId !== null && requested.has(item.ingredientId));

      return {
        recipe: {
          id: recipe.id,
          name: recipe.name,
          imagePath: recipe.imagePath,
          cookingTimeMinutes: recipe.cookingTimeMinutes,
        },
        existingIngredients: existing,
        missingIngredients: missing,
        missingTools,
        completion,
        inventoryCheckable,
        completionLabel: !inventoryCheckable
          ? '未录入配料，无法核对库存'
          : completion === 100
            ? '100% 可直接做'
            : missing.length <= 2
              ? '缺少 1–2 项'
              : '缺少多项',
        wasteScore,
        consumesRequested,
        reason: !inventoryCheckable
          ? '菜谱没有可核对的结构化配料，无法判断库存是否齐备'
          : completion === 100
            ? wasteScore > 0
              ? '现有库存可完成，并可优先消耗临期或已开封食材'
              : '现有库存可直接完成'
            : `还缺少 ${missing.length} 项食材`,
      };
    })
    .filter((candidate) => !blockedRecipeIds.has(candidate.recipe.id))
    .filter((candidate) => candidate.missingTools.length === 0)
    .filter(
      (candidate) =>
        input.mode !== 'ONLY_INVENTORY' ||
        (candidate.inventoryCheckable && candidate.missingIngredients.length === 0),
    )
    .filter(
      (candidate) =>
        input.mode !== 'MUST_CONSUME' ||
        (requested.size > 0 ? candidate.consumesRequested : candidate.wasteScore > 0),
    )
    .sort((a, b) =>
      input.mode === 'MUST_CONSUME'
        ? b.wasteScore - a.wasteScore || b.completion - a.completion
        : b.completion - a.completion || b.wasteScore - a.wasteScore,
    );

  return {
    mode: input.mode,
    candidateCount: candidates.length,
    items: candidates.slice(0, normalizeLimit(input.limit)),
  };
}
