import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SqlValue } from '../src/db/types.js';
import { openDatabase, type DatabaseHandle } from '../src/db/database.js';
import { SYNC_OUTBOX_TABLE } from '../src/db/schema.js';
import {
  createLocalApiFetch,
  createLocalApiRouter,
  type LocalApiRouter,
} from '../src/local-api/index.js';
import { registerInventory } from '../src/modules/inventory/index.js';
import { loadGoogle2Adapter } from './local-api-adapter-harness.js';
import { createNodeSqliteDriver } from './helpers/node-sqlite-driver.js';

/**
 * T-003 厨房库荐独占测试。
 *
 * 上游基准：`app/server/src/modules/inventory/{routes,service}.ts`
 * （da-fan-xiao-guan@e778d3bd3354123032e570e03ad85c6b19bd9ea4）。
 * 日期一律取设备本地时间：NOW 的本地日期为 2026-11-21。
 */
const ORIGIN = 'http://localhost';
const NOW = new Date(2026, 10, 21, 13, 30);
const TODAY = '2026-11-21';
const IN_24H = '2026-11-22';
const IN_3D = '2026-11-24';
const TS = NOW.toISOString();

interface RecommendationItem {
  recipe: { id: string; name: string; imagePath: string | null; cookingTimeMinutes: number | null };
  existingIngredients: Array<{
    ingredientId: string;
    name: string;
    required: number | null;
    available: number;
    unit: string | null;
  }>;
  missingIngredients: Array<{
    ingredientId: string | null;
    name: string;
    quantity: number | null;
    unit: string | null;
    reason: string;
  }>;
  missingTools: string[];
  completion: number;
  inventoryCheckable: boolean;
  completionLabel: string;
  wasteScore: number;
  consumesRequested: boolean;
  reason: string;
}

interface RecommendationResult {
  mode: string;
  candidateCount: number;
  items: RecommendationItem[];
}

interface JsonResult<T> {
  readonly status: number;
  readonly body: {
    success: boolean;
    data: T | null;
    error: { code: string; message: string } | null;
  };
}

let database: DatabaseHandle;
let router: LocalApiRouter;

async function seed(statements: Array<[string, SqlValue[]]>): Promise<void> {
  await database.withWriteTransaction(async (tx) => {
    for (const [sql, values] of statements) await tx.run(sql, values);
  });
}

function ingredientSql(row: {
  id: string;
  name: string;
  quantity?: number;
  unit?: string;
  purchaseDate?: string | null;
  expiryDate?: string | null;
  location?: string | null;
  maxStock?: number | null;
  opened?: number;
  deletedAt?: string | null;
}): [string, SqlValue[]] {
  return [
    `INSERT INTO "Ingredient"
       ("id","name","quantity","unit","purchaseDate","expiryDate","location","minStock","maxStock","opened","version","deletedAt","updatedAt")
     VALUES (?,?,?,?,?,?,?,NULL,?,?,1,?,?)`,
    [
      row.id,
      row.name,
      row.quantity ?? 0,
      row.unit ?? 'GRAM',
      row.purchaseDate ?? null,
      row.expiryDate ?? null,
      row.location ?? null,
      row.maxStock ?? null,
      row.opened ?? 0,
      row.deletedAt ?? null,
      TS,
    ],
  ];
}

function batchSql(row: {
  id: string;
  ingredientId: string;
  quantity: number;
  unit?: string;
  expiryDate?: string | null;
  consumePriority?: number;
  opened?: number;
  deletedAt?: string | null;
}): [string, SqlValue[]] {
  return [
    `INSERT INTO "InventoryBatch"
       ("id","ingredientId","quantity","unit","purchaseDate","expiryDate","location","opened","consumePriority","version","deletedAt","updatedAt")
     VALUES (?,?,?,?,NULL,?,NULL,?,?,1,?,?)`,
    [
      row.id,
      row.ingredientId,
      row.quantity,
      row.unit ?? 'GRAM',
      row.expiryDate ?? null,
      row.opened ?? 0,
      row.consumePriority ?? 0,
      row.deletedAt ?? null,
      TS,
    ],
  ];
}

function recipeSql(row: {
  id: string;
  name: string;
  ingredientsText?: string | null;
  notes?: string | null;
  cookingTimeMinutes?: number | null;
  enabledForRecommendation?: number;
  deletedAt?: string | null;
}): [string, SqlValue[]] {
  return [
    `INSERT INTO "Recipe"
       ("id","name","imagePath","ingredientsText","cookingTimeMinutes","notes","favorite","enabledForRecommendation","version","deletedAt","updatedAt")
     VALUES (?,?,NULL,?,?,?,0,?,1,?,?)`,
    [
      row.id,
      row.name,
      row.ingredientsText ?? null,
      row.cookingTimeMinutes ?? null,
      row.notes ?? null,
      row.enabledForRecommendation ?? 1,
      row.deletedAt ?? null,
      TS,
    ],
  ];
}

let ingredientLineSeq = 0;

function recipeIngredientSql(row: {
  recipeId: string;
  ingredientId: string | null;
  name: string;
  quantity?: number | null;
  unit?: string | null;
  optional?: number;
}): [string, SqlValue[]] {
  ingredientLineSeq += 1;
  return [
    `INSERT INTO "RecipeIngredient"
       ("id","recipeId","ingredientId","ingredientNameSnapshot","quantity","unit","amountText","optional","isPrimary","sortOrder","updatedAt")
     VALUES (?,?,?,?,?,?,NULL,?,0,?,?)`,
    [
      `ri-${ingredientLineSeq}`,
      row.recipeId,
      row.ingredientId,
      row.name,
      row.quantity ?? null,
      row.unit ?? null,
      row.optional ?? 0,
      ingredientLineSeq,
      TS,
    ],
  ];
}

function toolSql(row: {
  id: string;
  name: string;
  quantity?: number;
  status?: string | null;
  deletedAt?: string | null;
}): [string, SqlValue[]] {
  return [
    `INSERT INTO "KitchenTool"
       ("id","name","quantity","status","version","deletedAt","updatedAt")
     VALUES (?,?,?,?,1,?,?)`,
    [row.id, row.name, row.quantity ?? 1, row.status ?? 'AVAILABLE', row.deletedAt ?? null, TS],
  ];
}

let recipeToolSeq = 0;

function recipeToolSql(row: {
  recipeId: string;
  toolId: string | null;
  name: string;
  required?: number;
}): [string, SqlValue[]] {
  recipeToolSeq += 1;
  return [
    `INSERT INTO "RecipeTool"
       ("id","recipeId","toolId","toolNameSnapshot","required","updatedAt")
     VALUES (?,?,?,?,?,?)`,
    [`rt-${recipeToolSeq}`, row.recipeId, row.toolId, row.name, row.required ?? 1, TS],
  ];
}

function dinerSql(row: {
  id: string;
  name: string;
  active?: number;
  allergyText?: string | null;
  tabooText?: string | null;
  dislikesText?: string | null;
}): [string, SqlValue[]] {
  return [
    `INSERT INTO "Diner"
       ("id","name","active","likesText","dislikesText","tabooText","allergyText","version","updatedAt")
     VALUES (?,?,?,NULL,?,?,?,1,?)`,
    [
      row.id,
      row.name,
      row.active ?? 1,
      row.dislikesText ?? null,
      row.tabooText ?? null,
      row.allergyText ?? null,
      TS,
    ],
  ];
}

async function recommend(body: unknown): Promise<JsonResult<RecommendationResult>> {
  const response = await router.handle(
    new Request(`${ORIGIN}/api/v1/kitchen/recommend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() };
}

async function recommendOk(body: unknown): Promise<RecommendationResult> {
  const result = await recommend(body);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body.data as RecommendationResult;
}

beforeEach(async () => {
  ingredientLineSeq = 0;
  recipeToolSeq = 0;
  database = await openDatabase({
    driver: createNodeSqliteDriver({ path: ':memory:' }),
    now: () => NOW,
  });
  router = createLocalApiRouter({
    readGateState: () => ({ pendingWipe: false, pinRequired: false }),
    now: () => NOW,
  });
  registerInventory(router, async () => database);
});

describe('POST /api/v1/kitchen/recommend 契约', () => {
  it('按 completion、wasteScore 降序排列并返回上游字段结构', async () => {
    await seed([
      ingredientSql({ id: 'q', name: '普通米', quantity: 100, unit: 'GRAM' }),
      batchSql({ id: 'bq', ingredientId: 'q', quantity: 100 }),
      ingredientSql({ id: 'p', name: '优先肉', quantity: 100, unit: 'GRAM' }),
      batchSql({
        id: 'bp',
        ingredientId: 'p',
        quantity: 100,
        consumePriority: 1,
        expiryDate: IN_3D,
      }),
      recipeSql({ id: 'r-cheap', name: '普通饭', cookingTimeMinutes: 12 }),
      recipeIngredientSql({
        recipeId: 'r-cheap',
        ingredientId: 'q',
        name: '普通米',
        quantity: 50,
        unit: 'GRAM',
      }),
      recipeSql({ id: 'r-waste', name: '优先饭' }),
      recipeIngredientSql({
        recipeId: 'r-waste',
        ingredientId: 'p',
        name: '优先肉',
        quantity: 50,
        unit: 'GRAM',
      }),
      recipeSql({ id: 'r-short', name: '不够饭' }),
      recipeIngredientSql({
        recipeId: 'r-short',
        ingredientId: 'q',
        name: '普通米',
        quantity: 500,
        unit: 'GRAM',
      }),
    ]);

    const result = await recommendOk({ mode: 'ALLOW_PURCHASE' });

    expect(result.mode).toBe('ALLOW_PURCHASE');
    expect(result.candidateCount).toBe(3);
    expect(result.items.map((item) => item.recipe.name)).toEqual(['优先饭', '普通饭', '不够饭']);
    expect(result.items[0]).toEqual({
      recipe: { id: 'r-waste', name: '优先饭', imagePath: null, cookingTimeMinutes: null },
      existingIngredients: [
        { ingredientId: 'p', name: '优先肉', required: 50, available: 100, unit: 'GRAM' },
      ],
      missingIngredients: [],
      missingTools: [],
      completion: 100,
      inventoryCheckable: true,
      completionLabel: '100% 可直接做',
      wasteScore: 101,
      consumesRequested: true,
      reason: '现有库存可完成，并可优先消耗临期或已开封食材',
    });
    expect(result.items[1]).toMatchObject({
      completion: 100,
      wasteScore: 0,
      completionLabel: '100% 可直接做',
      reason: '现有库存可直接完成',
    });
    expect(result.items[2]).toMatchObject({
      completion: 0,
      inventoryCheckable: true,
      completionLabel: '缺少 1–2 项',
      reason: '还缺少 1 项食材',
      missingIngredients: [
        { ingredientId: 'q', name: '普通米', quantity: 400, unit: 'GRAM', reason: '库存不足' },
      ],
    });
  });

  it('过期批次按设备本地日期过滤，当天到期仍可用', async () => {
    await seed([
      ingredientSql({ id: 'stale', name: '昨日米', quantity: 100 }),
      batchSql({ id: 'b-stale', ingredientId: 'stale', quantity: 100, expiryDate: '2026-11-20' }),
      ingredientSql({ id: 'today', name: '今日米', quantity: 100 }),
      batchSql({ id: 'b-today', ingredientId: 'today', quantity: 100, expiryDate: TODAY }),
      recipeSql({ id: 'r-stale', name: '过期饭' }),
      recipeIngredientSql({
        recipeId: 'r-stale',
        ingredientId: 'stale',
        name: '昨日米',
        quantity: 50,
        unit: 'GRAM',
      }),
      recipeSql({ id: 'r-today', name: '当天饭' }),
      recipeIngredientSql({
        recipeId: 'r-today',
        ingredientId: 'today',
        name: '今日米',
        quantity: 50,
        unit: 'GRAM',
      }),
    ]);

    const all = await recommendOk({ mode: 'ALLOW_PURCHASE' });
    expect(all.items.map((item) => [item.recipe.name, item.completion])).toEqual([
      ['当天饭', 100],
      ['过期饭', 0],
    ]);
    expect(all.items[1].missingIngredients).toEqual([
      {
        ingredientId: 'stale',
        name: '昨日米',
        quantity: 50,
        unit: 'GRAM',
        reason: '库存单位不可换算',
      },
    ]);

    const only = await recommendOk({ mode: 'ONLY_INVENTORY' });
    expect(only.candidateCount).toBe(1);
    expect(only.items.map((item) => item.recipe.name)).toEqual(['当天饭']);
  });

  it('无活批次的历史存量派生等效批次，但存在正数量批次（含过期）的食材不自愈', async () => {
    await seed([
      // 从未建过批次：可自愈。
      ingredientSql({ id: 'implicit', name: '历史盐', quantity: 100 }),
      // 只有过期批次：不得把过期库存再次派生。
      ingredientSql({ id: 'expired-batch', name: '过期糖', quantity: 100 }),
      batchSql({
        id: 'b-expired',
        ingredientId: 'expired-batch',
        quantity: 100,
        expiryDate: '2026-11-01',
      }),
      // 食材汇总自身过期：不自愈。
      ingredientSql({ id: 'expired-row', name: '陈醋', quantity: 100, expiryDate: '2026-11-01' }),
      // 零数量批次不算正库存：仍可自愈。
      ingredientSql({ id: 'zero-batch', name: '零批米', quantity: 100 }),
      batchSql({ id: 'b-zero', ingredientId: 'zero-batch', quantity: 0 }),
      recipeSql({ id: 'r-implicit', name: '自愈饭' }),
      recipeIngredientSql({
        recipeId: 'r-implicit',
        ingredientId: 'implicit',
        name: '历史盐',
        quantity: 50,
        unit: 'GRAM',
      }),
      recipeSql({ id: 'r-expired-batch', name: '过期批饭' }),
      recipeIngredientSql({
        recipeId: 'r-expired-batch',
        ingredientId: 'expired-batch',
        name: '过期糖',
        quantity: 50,
        unit: 'GRAM',
      }),
      recipeSql({ id: 'r-expired-row', name: '过期行饭' }),
      recipeIngredientSql({
        recipeId: 'r-expired-row',
        ingredientId: 'expired-row',
        name: '陈醋',
        quantity: 50,
        unit: 'GRAM',
      }),
      recipeSql({ id: 'r-zero', name: '零批饭' }),
      recipeIngredientSql({
        recipeId: 'r-zero',
        ingredientId: 'zero-batch',
        name: '零批米',
        quantity: 50,
        unit: 'GRAM',
      }),
    ]);

    const result = await recommendOk({ mode: 'ALLOW_PURCHASE' });
    const byName = new Map(result.items.map((item) => [item.recipe.name, item]));
    expect(byName.get('自愈饭')?.completion).toBe(100);
    expect(byName.get('零批饭')?.completion).toBe(100);
    expect(byName.get('过期批饭')?.completion).toBe(0);
    expect(byName.get('过期行饭')?.completion).toBe(0);
    expect(byName.get('过期批饭')?.missingIngredients[0].quantity).toBe(50);
  });

  it('忌口只取 active 食用者并覆盖菜名、配料文本与快照', async () => {
    await seed([
      ingredientSql({ id: 'rice', name: '大米', quantity: 100 }),
      batchSql({ id: 'b-rice', ingredientId: 'rice', quantity: 100 }),
      dinerSql({ id: 'diner-on', name: '甲', allergyText: '花生' }),
      dinerSql({ id: 'diner-off', name: '乙', active: 0, tabooText: '花生' }),
      recipeSql({ id: 'r-name', name: '花生饭' }),
      recipeIngredientSql({
        recipeId: 'r-name',
        ingredientId: 'rice',
        name: '大米',
        quantity: 50,
        unit: 'GRAM',
      }),
      recipeSql({ id: 'r-snapshot', name: '炒菜', ingredientsText: '花生米一把' }),
      recipeIngredientSql({
        recipeId: 'r-snapshot',
        ingredientId: 'rice',
        name: '大米',
        quantity: 50,
        unit: 'GRAM',
      }),
      recipeSql({ id: 'r-safe', name: '白饭' }),
      recipeIngredientSql({
        recipeId: 'r-safe',
        ingredientId: 'rice',
        name: '大米',
        quantity: 50,
        unit: 'GRAM',
      }),
    ]);

    const blocked = await recommendOk({ mode: 'ALLOW_PURCHASE', dinerIds: ['diner-on'] });
    expect(blocked.items.map((item) => item.recipe.name)).toEqual(['白饭']);

    const inactive = await recommendOk({ mode: 'ALLOW_PURCHASE', dinerIds: ['diner-off'] });
    expect(inactive.items.map((item) => item.recipe.name)).toHaveLength(3);

    const anonymous = await recommendOk({ mode: 'ALLOW_PURCHASE' });
    expect(anonymous.items).toHaveLength(3);
  });

  it('必需厨具缺失、损坏、删除或数量为零时拦截，非必需不拦截', async () => {
    await seed([
      ingredientSql({ id: 'rice', name: '大米', quantity: 100 }),
      batchSql({ id: 'b-rice', ingredientId: 'rice', quantity: 100 }),
      toolSql({ id: 'tool-zero', name: '空锅', quantity: 0 }),
      toolSql({ id: 'tool-broken', name: '坏锅', status: 'broken' }),
      toolSql({ id: 'tool-deleted', name: '旧锅', deletedAt: TS }),
      toolSql({ id: 'tool-ok', name: '好锅' }),
      ...([
        ['r-zero', '数量零锅', 'tool-zero', 1],
        ['r-broken', '损坏锅', 'tool-broken', 1],
        ['r-missing', '未关联锅', null, 1],
        ['r-deleted', '已删锅', 'tool-deleted', 1],
        ['r-optional', '应急锅', 'tool-zero', 0],
        ['r-ok', '好锅菜', 'tool-ok', 1],
      ].map(([recipeId, name]) =>
        recipeSql({ id: recipeId as string, name: name as string }),
      ) as Array<[string, SqlValue[]]>),
      recipeIngredientSql({
        recipeId: 'r-zero',
        ingredientId: 'rice',
        name: '大米',
        quantity: 50,
        unit: 'GRAM',
      }),
      recipeIngredientSql({
        recipeId: 'r-broken',
        ingredientId: 'rice',
        name: '大米',
        quantity: 50,
        unit: 'GRAM',
      }),
      recipeIngredientSql({
        recipeId: 'r-missing',
        ingredientId: 'rice',
        name: '大米',
        quantity: 50,
        unit: 'GRAM',
      }),
      recipeIngredientSql({
        recipeId: 'r-deleted',
        ingredientId: 'rice',
        name: '大米',
        quantity: 50,
        unit: 'GRAM',
      }),
      recipeIngredientSql({
        recipeId: 'r-optional',
        ingredientId: 'rice',
        name: '大米',
        quantity: 50,
        unit: 'GRAM',
      }),
      recipeIngredientSql({
        recipeId: 'r-ok',
        ingredientId: 'rice',
        name: '大米',
        quantity: 50,
        unit: 'GRAM',
      }),
      recipeToolSql({ recipeId: 'r-zero', toolId: 'tool-zero', name: '空锅' }),
      recipeToolSql({ recipeId: 'r-broken', toolId: 'tool-broken', name: '坏锅' }),
      recipeToolSql({ recipeId: 'r-missing', toolId: null, name: '未关联锅' }),
      recipeToolSql({ recipeId: 'r-deleted', toolId: 'tool-deleted', name: '旧锅' }),
      recipeToolSql({ recipeId: 'r-optional', toolId: 'tool-zero', name: '空锅', required: 0 }),
      recipeToolSql({ recipeId: 'r-ok', toolId: 'tool-ok', name: '好锅' }),
    ]);

    const result = await recommendOk({ mode: 'ALLOW_PURCHASE' });
    expect(result.items.map((item) => item.recipe.name).sort()).toEqual(
      ['好锅菜', '应急锅'].sort(),
    );
  });

  it('没有结构化配料的菜谱按 0% 兜底且不带缺项，ONLY_INVENTORY 不返回', async () => {
    await seed([
      ingredientSql({ id: 'rice', name: '大米', quantity: 100 }),
      batchSql({ id: 'b-rice', ingredientId: 'rice', quantity: 100 }),
      recipeSql({ id: 'r-free', name: '随意煮' }),
      recipeIngredientSql({
        recipeId: 'r-free',
        ingredientId: null,
        name: '盐',
        quantity: null,
        unit: null,
      }),
      recipeSql({ id: 'r-ok', name: '白饭' }),
      recipeIngredientSql({
        recipeId: 'r-ok',
        ingredientId: 'rice',
        name: '大米',
        quantity: 50,
        unit: 'GRAM',
      }),
    ]);

    const all = await recommendOk({ mode: 'ALLOW_PURCHASE' });
    const free = all.items.find((item) => item.recipe.name === '随意煮');
    expect(free).toMatchObject({
      completion: 0,
      inventoryCheckable: false,
      completionLabel: '未录入配料，无法核对库存',
      reason: '菜谱没有可核对的结构化配料，无法判断库存是否齐备',
      existingIngredients: [],
      missingIngredients: [
        { ingredientId: null, name: '盐', quantity: null, unit: null, reason: '未关联库存食材' },
      ],
    });

    const only = await recommendOk({ mode: 'ONLY_INVENTORY' });
    expect(only.items.map((item) => item.recipe.name)).toEqual(['白饭']);
  });

  it('MUST_CONSUME 按指定食材或临期浪费评分筛选并优先排序', async () => {
    await seed([
      ingredientSql({ id: 'w', name: '临期肉', quantity: 100 }),
      batchSql({ id: 'b-w', ingredientId: 'w', quantity: 100, consumePriority: 1 }),
      ingredientSql({ id: 'n', name: '普通菜', quantity: 100 }),
      batchSql({ id: 'b-n', ingredientId: 'n', quantity: 100 }),
      ingredientSql({ id: 's', name: '明日奶', quantity: 100 }),
      batchSql({ id: 'b-s', ingredientId: 's', quantity: 100, expiryDate: IN_24H }),
      recipeSql({ id: 'r-w', name: '清肉' }),
      recipeIngredientSql({
        recipeId: 'r-w',
        ingredientId: 'w',
        name: '临期肉',
        quantity: 50,
        unit: 'GRAM',
      }),
      recipeIngredientSql({
        recipeId: 'r-w',
        ingredientId: 'n',
        name: '普通菜',
        quantity: 50,
        unit: 'GRAM',
      }),
      recipeSql({ id: 'r-soon', name: '清临' }),
      recipeIngredientSql({
        recipeId: 'r-soon',
        ingredientId: 's',
        name: '明日奶',
        quantity: 50,
        unit: 'GRAM',
      }),
      recipeSql({ id: 'r-n', name: '清菜' }),
      recipeIngredientSql({
        recipeId: 'r-n',
        ingredientId: 'n',
        name: '普通菜',
        quantity: 50,
        unit: 'GRAM',
      }),
      recipeSql({ id: 'r-plain', name: '白饭' }),
    ]);

    const byWaste = await recommendOk({ mode: 'MUST_CONSUME' });
    expect(byWaste.items.map((item) => [item.recipe.name, item.wasteScore])).toEqual([
      ['清肉', 101],
      ['清临', 51],
    ]);

    const requested = await recommendOk({
      mode: 'MUST_CONSUME',
      ingredientIds: ['n'],
    });
    expect(requested.items.map((item) => item.recipe.name)).toEqual(['清肉', '清菜']);
    expect(requested.items.map((item) => item.consumesRequested)).toEqual([true, true]);
    expect(requested.items[0].wasteScore).toBeGreaterThan(requested.items[1].wasteScore);
    expect(requested.items.every((item) => item.recipe.name !== '白饭')).toBe(true);
  });

  it('limit 截断并保留 candidateCount 全量，非法入参返回 400', async () => {
    await seed([
      ingredientSql({ id: 'rice', name: '大米', quantity: 100 }),
      batchSql({ id: 'b-rice', ingredientId: 'rice', quantity: 100 }),
      ...['甲', '乙', '丙'].flatMap((suffix, index) => [
        recipeSql({ id: `r-${index}`, name: `饭${suffix}` }),
        recipeIngredientSql({
          recipeId: `r-${index}`,
          ingredientId: 'rice',
          name: '大米',
          quantity: 50,
          unit: 'GRAM',
        }),
      ]),
    ]);

    const limited = await recommendOk({ mode: 'ALLOW_PURCHASE', limit: 2 });
    expect(limited.candidateCount).toBe(3);
    expect(limited.items).toHaveLength(2);

    for (const body of [
      {},
      { mode: 'INVALID' },
      { mode: 'ONLY_INVENTORY', limit: 0 },
      { mode: 'ONLY_INVENTORY', limit: 1.5 },
      { mode: 'ONLY_INVENTORY', limit: '3' },
      { mode: 'ONLY_INVENTORY', dinerIds: 'x' },
      { mode: 'ONLY_INVENTORY', ingredientIds: [1] },
    ]) {
      const result = await recommend(body);
      expect(result.status, JSON.stringify(body)).toBe(400);
      expect(result.body.error?.code).toBe('VALIDATION_ERROR');
    }

    const empty = await recommend({ mode: 'ALLOW_PURCHASE', limit: 100 });
    expect(empty.status).toBe(200);
  });

  it('只走 SELECT：不开启写事务、不写发件箱、数据不变', async () => {
    await seed([
      ingredientSql({ id: 'rice', name: '大米', quantity: 100 }),
      batchSql({ id: 'b-rice', ingredientId: 'rice', quantity: 100 }),
      recipeSql({ id: 'r-ok', name: '白饭' }),
      recipeIngredientSql({
        recipeId: 'r-ok',
        ingredientId: 'rice',
        name: '大米',
        quantity: 50,
        unit: 'GRAM',
      }),
    ]);
    const tables = [
      'Ingredient',
      'InventoryBatch',
      'InventoryLog',
      'Recipe',
      'RecipeIngredient',
      SYNC_OUTBOX_TABLE,
    ];
    const snapshot = () =>
      Promise.all(tables.map((table) => database.query(`SELECT * FROM "${table}" ORDER BY rowid`)));
    const before = await snapshot();
    const write = vi.spyOn(database, 'withWriteTransaction');

    await recommendOk({ mode: 'ALLOW_PURCHASE' });
    await recommendOk({ mode: 'ONLY_INVENTORY' });
    await recommendOk({ mode: 'MUST_CONSUME' });

    expect(write).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    await expect(
      database.query(`SELECT COUNT(*) AS "total" FROM "${SYNC_OUTBOX_TABLE}"`),
    ).resolves.toEqual([{ total: 0 }]);
  });

  it('真实适配器穿透本地路由：成功契约与 400 映射一致', async () => {
    await seed([
      ingredientSql({ id: 'rice', name: '大米', quantity: 100 }),
      batchSql({ id: 'b-rice', ingredientId: 'rice', quantity: 100 }),
      recipeSql({ id: 'r-ok', name: '白饭' }),
      recipeIngredientSql({
        recipeId: 'r-ok',
        ingredientId: 'rice',
        name: '大米',
        quantity: 50,
        unit: 'GRAM',
      }),
    ]);
    const fetch = createLocalApiFetch({
      router,
      origin: ORIGIN,
      nativeFetch: () => {
        throw new Error('请求离开本地路由');
      },
    });
    const harness = loadGoogle2Adapter({
      fetch: async (input, init) => fetch(input, init),
    });
    expect(harness.window.DafanApiClient).toBeDefined();

    const data = await harness.api.post<RecommendationResult>('/kitchen/recommend', {
      mode: 'ONLY_INVENTORY',
    });
    expect(data.candidateCount).toBe(1);
    expect(data.items[0].recipe.name).toBe('白饭');
    expect(data.items[0].recipe.cookingTimeMinutes).toBeNull();

    await expect(harness.api.post('/kitchen/recommend', { mode: 'INVALID' })).rejects.toMatchObject(
      { status: 400, code: 'VALIDATION_ERROR' },
    );
  });
});
