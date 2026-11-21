import { createHash } from 'node:crypto';
import { RETAINED_ENDPOINTS, RETIRED_ENDPOINTS } from '@dafan/shared/contracts';
import type { DinerDto, IngredientDto, RecipeDto, StoreDto } from '@dafan/shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../src/db/database';
import { registerDomainRoutes } from '../src/local-api/domains';
import { createLocalApiFetch, createLocalApiRouter } from '../src/local-api/router';
import { createNodeSqliteDriver } from './helpers/node-sqlite-driver';
import { loadGoogle2Adapter, type AdapterApiClient } from './local-api-adapter-harness';

const now = () => new Date(2026, 10, 21, 0, 30);
const special = `意面 "' <菜> & 酱`;

type AdapterItem = { id: string; version: number; favorite?: boolean; stock?: number };
interface AdapterService {
  data: AdapterItem[];
  getByIdRemote(id: string): Promise<AdapterItem>;
  save(item: Record<string, unknown>): Promise<AdapterItem>;
  delete(id: string): Promise<void>;
  toggleFavorite(id: string): Promise<AdapterItem>;
  consume(id: string, amount: 'all' | { quantity: number; unit: string }): Promise<AdapterItem>;
}

interface DomainAdapter {
  replaceStoreService(service: { data: AdapterItem[] }): () => Promise<AdapterItem[]>;
  replaceRecipeService(service: { data: AdapterItem[] }): () => Promise<AdapterItem[]>;
  replacePantryService(service: { data: AdapterItem[] }): () => Promise<AdapterItem[]>;
  replaceToolService(service: { data: AdapterItem[] }): () => Promise<AdapterItem[]>;
}

let database: DatabaseHandle;
let router: ReturnType<typeof createLocalApiRouter>;
let api: AdapterApiClient;
let adapter: DomainAdapter;
let requests: Array<{ method: string; path: string; body: unknown }>;

beforeEach(async () => {
  database = await openDatabase({ driver: createNodeSqliteDriver({ path: ':memory:' }), now });
  router = createLocalApiRouter({
    now,
    readGateState: () => ({ pendingWipe: false, pinRequired: false }),
  });
  registerDomainRoutes(router, async () => database);
  const fetch = createLocalApiFetch({
    router,
    origin: 'http://localhost',
    nativeFetch: vi.fn(() => {
      throw new Error('请求离开本地路由');
    }),
  });
  requests = [];
  const harness = loadGoogle2Adapter({
    fetch: async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      requests.push({
        method: init?.method ?? 'GET',
        path: url.pathname + url.search,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return fetch(input, init);
    },
  });
  api = harness.api;
  adapter = harness.window.DafanDomainAdapter as DomainAdapter;
});

afterEach(async () => database.close());

function adapterService(replace: (data: { data: AdapterItem[] }) => unknown): AdapterService {
  const service = { data: [] };
  replace(service);
  return service as unknown as AdapterService;
}

async function snapshot(...tables: string[]) {
  return Promise.all(
    tables.map((table) => database.query(`SELECT * FROM "${table}" ORDER BY rowid`)),
  );
}

async function failInsert(table: string) {
  await database.withWriteTransaction((tx) =>
    tx.exec(
      `CREATE TRIGGER "test_failure" BEFORE INSERT ON "${table}" BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
    ),
  );
}

it('从生产入口注册 61 条保留路由并且无未实现占位，退役端点未注册', async () => {
  expect(RETAINED_ENDPOINTS).toHaveLength(61);
  for (const { method, path } of RETAINED_ENDPOINTS) {
    expect(router.has(method, path), `${method} ${path}`).toBe(true);
    const response = await router.handle(
      new Request(`http://localhost${path.replace(':id', 'absent')}`, { method }),
    );
    expect(response.status, `${method} ${path}`).not.toBe(501);
  }
  for (const { method, path } of RETIRED_ENDPOINTS)
    expect(router.has(method, path), `${method} ${path}`).toBe(false);
});

it('真实适配器服务完成菜谱、店铺、食材、厨具 CRUD，使用各自版本载荷', async () => {
  const tools = adapterService(adapter.replaceToolService);
  const tool = await tools.save({ name: '炒锅', icon: '🍳' });
  const editedTool = await tools.save({ id: tool.id, name: special });
  expect(editedTool.version).toBe(2);
  expect(await api.get('/tools')).toMatchObject([{ id: tool.id, name: special }]);

  const stores = adapterService(adapter.replaceStoreService);
  const store = await stores.save({
    name: special,
    supportsDineIn: true,
    supportsTakeout: false,
    mealTypes: ['DINNER'],
    menuItems: [{ name: special, isSignature: true }],
  });
  const storeDto = await api.get<StoreDto>(`/stores/${store.id}`);
  expect(storeDto).toMatchObject({
    name: special,
    supportsDineIn: true,
    supportsTakeout: false,
    favorite: false,
    menuItems: [{ name: special, isSignature: true }],
  });
  expect(
    await api.get(
      '/stores?search=%E6%84%8F%E9%9D%A2&mode=DINE_IN&mealTypes=DINNER&page=1&pageSize=1',
    ),
  ).toMatchObject({ total: 1, items: [{ id: store.id }] });
  await stores.save({
    id: store.id,
    name: special,
    mealTypes: ['LUNCH'],
    menuItems: [{ name: '新菜', isSignature: false }],
  });
  const favoredStore = await stores.toggleFavorite(store.id);
  expect(favoredStore.favorite).toBe(true);
  expect(await api.get(`/stores/${store.id}`)).toMatchObject({
    mealTypes: ['LUNCH'],
    menuItems: [{ name: '新菜', isSignature: false }],
  });

  const pantry = adapterService(adapter.replacePantryService);
  const ingredient = await pantry.save({
    name: special,
    unitKey: 'KILOGRAM',
    stock: 2,
    opened: false,
    consumePriority: true,
  });
  expect(await api.get(`/ingredients/${ingredient.id}`)).toMatchObject({
    opened: false,
    batches: [{ opened: false, consumePriority: true }],
  });

  const recipes = adapterService(adapter.replaceRecipeService);
  await database.withWriteTransaction((tx) =>
    tx.run(
      'INSERT INTO "Tag" ("id", "name", "type", "deletedAt", "updatedAt") VALUES (?, ?, ?, ?, ?)',
      ['existing-tag', special, 'GENERAL', now().toISOString(), now().toISOString()],
    ),
  );
  const recipeInput = {
    name: special,
    notes: special,
    tags: [special],
    mealTypes: ['DINNER'],
    mealRoles: ['MAIN'],
    ingredients: [
      {
        name: special,
        ingredientId: ingredient.id,
        quantity: 100,
        unit: 'GRAM',
        optional: false,
        isPrimary: true,
      },
    ],
    steps: [{ content: special, title: special }],
    toolIds: [{ toolId: tool.id, name: special, required: false }],
  };
  const recipe = await recipes.save(recipeInput);
  const dto = await api.get<RecipeDto>(`/recipes/${recipe.id}`);
  expect(dto).toMatchObject({
    name: special,
    notes: special,
    favorite: false,
    enabledForRecommendation: true,
    tags: [{ tag: { name: special } }],
    ingredients: [
      {
        ingredientNameSnapshot: special,
        ingredientId: ingredient.id,
        optional: false,
        isPrimary: true,
      },
    ],
    steps: [{ content: special, title: special }],
    tools: [{ toolId: tool.id, required: false }],
  });
  await expect(database.query('SELECT "id", "deletedAt" FROM "Tag"')).resolves.toEqual([
    { id: 'existing-tag', deletedAt: null },
  ]);
  await recipes.save({
    ...recipeInput,
    id: recipe.id,
    version: recipe.version,
    ingredients: [{ ...recipeInput.ingredients[0], name: '改名' }],
  });
  expect(await api.get(`/recipes/${recipe.id}`)).toMatchObject({
    ingredients: [{ ingredientNameSnapshot: '改名', ingredientId: null }],
  });
  const favoredRecipe = await recipes.toggleFavorite(recipe.id);
  expect(favoredRecipe.favorite).toBe(true);

  const diner = await api.post<DinerDto>('/diners', { name: special, active: true });
  expect(diner.active).toBe(true);
  expect(
    await api.put(`/diners/${diner.id}`, {
      version: diner.version,
      active: false,
      allergyText: '花生',
      tabooText: '虾',
      dislikesText: '香菜',
      notes: special,
    }),
  ).toMatchObject({
    active: false,
    version: 2,
    allergyText: '花生',
    tabooText: '虾',
    dislikesText: '香菜',
    notes: special,
  });
  expect(await api.get('/diners?active=false&page=1&pageSize=1')).toMatchObject({
    total: 1,
    items: [{ id: diner.id, active: false }],
  });
  await expect(api.put(`/tools/${tool.id}`, { version: 2, favorite: true })).rejects.toMatchObject({
    status: 400,
  });

  await stores.delete(store.id);
  await recipes.delete(recipe.id);
  await pantry.delete(ingredient.id);
  await tools.delete(tool.id);
  expect(requests.filter(({ method }) => method === 'DELETE')).toEqual([
    {
      method: 'DELETE',
      path: `/api/v1/stores/${store.id}`,
      body: { version: favoredStore.version },
    },
    {
      method: 'DELETE',
      path: `/api/v1/recipes/${recipe.id}?version=${favoredRecipe.version}`,
      body: undefined,
    },
    {
      method: 'DELETE',
      path: `/api/v1/ingredients/${ingredient.id}?version=${ingredient.version}`,
      body: undefined,
    },
    {
      method: 'DELETE',
      path: `/api/v1/tools/${tool.id}?version=${editedTool.version}`,
      body: undefined,
    },
  ]);
  await expect(api.get(`/stores/${store.id}`)).rejects.toMatchObject({ status: 404 });
  await expect(api.get(`/recipes/${recipe.id}`)).rejects.toMatchObject({ status: 404 });
  await expect(api.get(`/ingredients/${ingredient.id}`)).rejects.toMatchObject({ status: 404 });
  await expect(api.get('/tools')).resolves.toEqual([]);
});

it('真实适配器重平衡批次、连续跨单位扣减、超扣回滚，并按序保留命令和哈希', async () => {
  const pantry = adapterService(adapter.replacePantryService);
  const item = await pantry.save({ name: '大米', unitKey: 'KILOGRAM', stock: 2 });
  const balanced = await pantry.save({
    name: '大米',
    id: item.id,
    version: item.version,
    unitKey: 'KILOGRAM',
    stock: 1,
    storageLocation: '橱柜',
  });
  expect(await api.get(`/ingredients/${item.id}`)).toMatchObject({
    quantity: 1,
    batches: [{ quantity: 1, location: '橱柜' }],
  });
  const first = await pantry.consume(item.id, { quantity: 200, unit: 'GRAM' });
  const second = await pantry.consume(item.id, { quantity: 250, unit: 'GRAM' });
  expect([first.stock, second.stock]).toEqual([0.8, 0.55]);
  expect(requests.filter(({ path }) => path.endsWith('/consume')).map(({ body }) => body)).toEqual([
    { mode: 'QUANTITY', ingredientVersion: balanced.version, quantity: 200, unit: 'GRAM' },
    { mode: 'QUANTITY', ingredientVersion: first.version, quantity: 250, unit: 'GRAM' },
  ]);
  const tables = ['Ingredient', 'InventoryBatch', 'InventoryLog', 'sync_outbox'];
  const before = await snapshot(...tables);
  await expect(pantry.consume(item.id, { quantity: 551, unit: 'GRAM' })).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    api.post(`/ingredients/${item.id}/consume`, {
      mode: 'QUANTITY',
      ingredientVersion: second.version,
      quantity: 1,
      unit: 'LITER',
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(await snapshot(...tables)).toEqual(before);
  const rows = await database.query<{
    commandType: string;
    baseVersion: number;
    payloadJson: string;
    payloadHash: string;
  }>(
    'SELECT "commandType", "baseVersion", "payloadJson", "payloadHash" FROM "sync_outbox" WHERE "kind" = ? ORDER BY rowid',
    ['command'],
  );
  expect(rows.map(({ commandType, baseVersion }) => [commandType, baseVersion])).toEqual([
    ['INGREDIENT_UPDATE_SYNC_BATCHES', item.version],
    ['INGREDIENT_CONSUME', balanced.version],
    ['INGREDIENT_CONSUME', first.version],
  ]);
  for (const row of rows)
    expect(row.payloadHash).toEqual(createHash('sha256').update(row.payloadJson).digest('hex'));
  const drained = await pantry.consume(item.id, 'all');
  expect(drained.stock).toBe(0);
  await expect(database.query('PRAGMA foreign_key_check')).resolves.toEqual([]);
});

it('显式替换批次时按基础单位汇总，并退役原批次以保留日志外键', async () => {
  const ingredient = await api.post<IngredientDto>('/ingredients', {
    name: '面粉',
    unit: 'KILOGRAM',
    batches: [{ quantity: 1, unit: 'KILOGRAM' }],
  });
  const replaced = await api.put<IngredientDto>(`/ingredients/${ingredient.id}`, {
    name: ingredient.name,
    unit: ingredient.unit,
    version: ingredient.version,
    batches: [
      { quantity: 250, unit: 'GRAM', opened: true },
      { quantity: 2, unit: 'KILOGRAM' },
    ],
  });
  expect(replaced.quantity).toBe(2.25);
  expect(replaced.opened).toBe(true);
  expect(replaced.batches.map(({ quantity, unit }) => [quantity, unit])).toEqual(
    expect.arrayContaining([
      [250, 'GRAM'],
      [2, 'KILOGRAM'],
    ]),
  );
  expect(replaced.batches).toHaveLength(2);
  await expect(
    database.query('SELECT "deletedAt" FROM "InventoryBatch" WHERE "id" = ?', [
      ingredient.batches[0].id,
    ]),
  ).resolves.toEqual([{ deletedAt: now().toISOString() }]);
  await expect(database.query('PRAGMA foreign_key_check')).resolves.toEqual([]);
});

it('厨房推荐排除过期库存、忌口和缺厨具，保留零写库与 0% 兜底', async () => {
  const expired = await api.post<IngredientDto>('/ingredients', {
    name: '过期米',
    unit: 'GRAM',
    batches: [{ quantity: 100, unit: 'GRAM', expiryDate: '2026-11-20' }],
  });
  const available = await api.post<IngredientDto>('/ingredients', {
    name: '今日米',
    unit: 'GRAM',
    batches: [{ quantity: 100, unit: 'GRAM', expiryDate: '2026-11-21' }],
  });
  const diner = await api.post<DinerDto>('/diners', {
    name: '甲',
    active: true,
    allergyText: '花生',
  });
  const pantryLine = (ingredient: IngredientDto) => ({
    name: ingredient.name,
    ingredientId: ingredient.id,
    quantity: 50,
    unit: 'GRAM',
  });
  await api.post('/recipes', { name: '过期饭', ingredients: [pantryLine(expired)] });
  await api.post('/recipes', { name: '当天饭', ingredients: [pantryLine(available)] });
  await api.post('/recipes', { name: '花生饭', ingredients: [pantryLine(available)] });
  await api.post('/recipes', {
    name: '缺锅饭',
    ingredients: [pantryLine(available)],
    toolIds: [{ name: '锅', required: true }],
  });
  await api.post('/recipes', { name: '随意煮', ingredients: [{ name: '盐', amountText: '少许' }] });
  const tables = ['Ingredient', 'InventoryBatch', 'InventoryLog', 'Recipe', 'sync_outbox'];
  const before = await snapshot(...tables);
  const write = vi.spyOn(database, 'withWriteTransaction');
  const data = await api.post<{
    items: Array<{ recipe: { name: string }; completion: number; inventoryCheckable: boolean }>;
  }>('/kitchen/recommend', { mode: 'ALLOW_PURCHASE', dinerIds: [diner.id] });
  expect(data.items).toHaveLength(3);
  expect(data.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        recipe: expect.objectContaining({ name: '当天饭' }),
        completion: 100,
        inventoryCheckable: true,
      }),
      expect.objectContaining({
        recipe: expect.objectContaining({ name: '过期饭' }),
        completion: 0,
        inventoryCheckable: true,
      }),
      expect.objectContaining({
        recipe: expect.objectContaining({ name: '随意煮' }),
        completion: 0,
        inventoryCheckable: false,
      }),
    ]),
  );
  await expect(
    api.post('/kitchen/recommend', { mode: 'ONLY_INVENTORY', dinerIds: [diner.id] }),
  ).resolves.toMatchObject({ candidateCount: 1, items: [{ recipe: { name: '当天饭' } }] });
  expect(write).not.toHaveBeenCalled();
  expect(await snapshot(...tables)).toEqual(before);
});

describe('聚合写事务', () => {
  it('菜谱替换步骤失败后恢复主表、食材、步骤、标签、餐次角色及发件箱', async () => {
    const recipe = await api.post<RecipeDto>('/recipes', {
      name: '原菜谱',
      ingredients: [{ name: '米' }],
      steps: [{ content: '原步骤' }],
      tags: ['原标签'],
      mealTypes: ['DINNER'],
      mealRoles: ['MAIN'],
    });
    const tables = [
      'Recipe',
      'RecipeIngredient',
      'RecipeStep',
      'RecipeMealType',
      'RecipeMealRole',
      'RecipeTool',
      'RecipeTag',
      'Tag',
      'sync_outbox',
    ];
    const before = await snapshot(...tables);
    await failInsert('RecipeStep');
    await expect(
      api.put(`/recipes/${recipe.id}`, {
        name: '新菜谱',
        version: recipe.version,
        ingredients: [{ name: '面' }],
        steps: [{ content: '新步骤' }],
        tags: ['新标签'],
        mealTypes: ['LUNCH'],
        mealRoles: [],
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(await snapshot(...tables)).toEqual(before);
    await expect(database.query('PRAGMA foreign_key_check')).resolves.toEqual([]);
  });

  it('店铺替换菜单失败后恢复主表、菜单、餐次及发件箱', async () => {
    const store = await api.post<StoreDto>('/stores', {
      name: '原店铺',
      mealTypes: ['DINNER'],
      menuItems: [{ name: '原菜' }],
    });
    const tables = ['Store', 'StoreMealType', 'StoreMenuItem', 'sync_outbox'];
    const before = await snapshot(...tables);
    await failInsert('StoreMenuItem');
    await expect(
      api.put(`/stores/${store.id}`, {
        name: '新店铺',
        version: store.version,
        mealTypes: ['LUNCH'],
        menuItems: [{ name: '新菜' }],
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(await snapshot(...tables)).toEqual(before);
    await expect(database.query('PRAGMA foreign_key_check')).resolves.toEqual([]);
  });

  it('批次插入失败和扣库命令入队失败均恢复食材、批次、库存日志与发件箱', async () => {
    const ingredient = await api.post<IngredientDto>('/ingredients', {
      name: '米',
      unit: 'KILOGRAM',
      batches: [{ quantity: 1, unit: 'KILOGRAM' }],
    });
    const tables = ['Ingredient', 'InventoryBatch', 'InventoryLog', 'sync_outbox'];
    const before = await snapshot(...tables);
    await failInsert('InventoryBatch');
    await expect(
      api.put(`/ingredients/${ingredient.id}`, {
        name: '新米',
        unit: 'KILOGRAM',
        version: ingredient.version,
        batches: [{ quantity: 9, unit: 'KILOGRAM' }],
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(await snapshot(...tables)).toEqual(before);
    await database.withWriteTransaction((tx) => tx.exec('DROP TRIGGER "test_failure"'));
    await failInsert('sync_outbox');
    await expect(
      api.post(`/ingredients/${ingredient.id}/consume`, {
        mode: 'QUANTITY',
        ingredientVersion: ingredient.version,
        quantity: 200,
        unit: 'GRAM',
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(await snapshot(...tables)).toEqual(before);
    await expect(database.query('PRAGMA foreign_key_check')).resolves.toEqual([]);
  });
});
