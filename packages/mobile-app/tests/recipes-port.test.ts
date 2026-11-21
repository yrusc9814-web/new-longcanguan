import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../src/db/database';
import { SYNC_OUTBOX_TABLE } from '../src/db/schema';
import {
  createLocalApiFetch,
  createLocalApiRouter,
  type LocalApiRouter,
} from '../src/local-api/index.js';
import { registerRecipes } from '../src/modules/recipes/index.js';
import { ADAPTER_PIN_KEY, loadGoogle2Adapter } from './local-api-adapter-harness';
import { createNodeSqliteDriver } from './helpers/node-sqlite-driver';

const ORIGIN = 'http://localhost';
const TOKEN = '{{SECRET_6x2f0gkz}}';
const NOW = '2026-11-21T08:00:00.000Z';

interface Harness {
  readonly adapter: ReturnType<typeof loadGoogle2Adapter>;
  readonly database: DatabaseHandle;
  readonly router: LocalApiRouter;
}

async function createHarness(): Promise<Harness> {
  const database = await openDatabase({ driver: createNodeSqliteDriver({ path: ':memory:' }) });
  const router = createLocalApiRouter({
    readGateState: () => ({ pendingWipe: false, pinRequired: true }),
    isPinTokenValid: (token) => token === TOKEN,
    now: () => new Date(NOW),
  });
  registerRecipes(router, async () => database);
  const localFetch = createLocalApiFetch({ router, origin: ORIGIN });
  const adapter = loadGoogle2Adapter({ fetch: localFetch, origin: ORIGIN });
  adapter.storage.set(ADAPTER_PIN_KEY, TOKEN);
  return { adapter, database, router };
}

async function outbox(database: DatabaseHandle) {
  return database.query<{
    entity: string;
    entityId: string;
    kind: string;
    baseVersion: number | null;
    payloadJson: string | null;
  }>(
    `SELECT "entity","entityId","kind","baseVersion","payloadJson" FROM "${SYNC_OUTBOX_TABLE}" ORDER BY rowid`,
  );
}

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

describe('POST/GET /api/v1/recipes', () => {
  it('创建结构化菜谱并返回聚合 DTO，发件箱 baseVersion=null 且 payload 可重放', async () => {
    const { adapter, database } = harness;
    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "Ingredient" ("id","name","quantity","unit","version","createdAt","updatedAt")
         VALUES ('ing-1','番茄',1000,'GRAM',1,?,?)`,
        [NOW, NOW],
      );
    });

    const created = await adapter.api.post<Record<string, unknown>>('/recipes', {
      name: '  番茄炒蛋  ',
      category: '家常菜',
      cookingTimeMinutes: 15,
      spicyLevel: 1,
      calories: 320,
      favorite: true,
      tags: ['快手菜', '快手菜', ' 家常 '],
      mealTypes: ['LUNCH', 'DINNER'],
      mealRoles: ['MAIN'],
      ingredients: [
        { ingredientId: 'ing-1', name: '番茄', quantity: 200, unit: 'GRAM', isPrimary: true },
        { name: '鸡蛋', amountText: '3个', optional: true },
      ],
      steps: [
        { content: '切番茄', title: '备料', timerMinutes: 0 },
        { content: '炒熟', timerMinutes: 5 },
      ],
      toolIds: [{ name: '炒锅', required: true }],
    });

    expect(created).toMatchObject({
      name: '番茄炒蛋',
      category: '家常菜',
      favorite: true,
      enabledForRecommendation: true,
      version: 1,
      deletedAt: null,
    });
    expect(created.ingredients).toHaveLength(2);
    expect(created.ingredients).toEqual([
      expect.objectContaining({
        ingredientId: 'ing-1',
        ingredientNameSnapshot: '番茄',
        sortOrder: 0,
        isPrimary: true,
      }),
      expect.objectContaining({
        ingredientId: null,
        ingredientNameSnapshot: '鸡蛋',
        amountText: '3个',
        optional: true,
      }),
    ]);
    expect(created.steps).toEqual([
      expect.objectContaining({ stepNo: 1, content: '切番茄', title: '备料', timerMinutes: 0 }),
      expect.objectContaining({ stepNo: 2, content: '炒熟', timerMinutes: 5 }),
    ]);
    expect((created.tags as Array<{ tag: { name: string } }>).map((t) => t.tag.name)).toEqual([
      '快手菜',
      '家常',
    ]);
    expect((created.mealTypes as Array<{ mealType: string }>).map((t) => t.mealType)).toEqual([
      'LUNCH',
      'DINNER',
    ]);
    expect((created.mealRoles as Array<{ mealRole: string }>).map((r) => r.mealRole)).toEqual([
      'MAIN',
    ]);
    expect(created.tools).toEqual([
      expect.objectContaining({ toolId: null, toolNameSnapshot: '炒锅', required: true }),
    ]);

    const rows = await outbox(database);
    expect(rows.map((row) => [row.entity, row.kind, row.baseVersion])).toEqual([
      ['Tag', 'upsert', null],
      ['Tag', 'upsert', null],
      ['Recipe', 'upsert', null],
    ]);
    const payload = JSON.parse(rows[2]!.payloadJson ?? 'null');
    expect(payload).toMatchObject({ id: created.id, name: '番茄炒蛋', version: 1 });
    expect(payload.ingredients).toHaveLength(2);
    expect(payload.tags).toHaveLength(2);

    const detail = await adapter.api.get<Record<string, unknown>>(
      `/recipes/${created.id as string}`,
    );
    expect(detail).toEqual(created);
  });

  it('保留特殊字符与换行，不做额外改写', async () => {
    const { adapter } = harness;
    const name = `番茄 "特制" & <炒蛋> 100% 'q'`;
    const content = `第一步：切块\n第二步：下锅（中火，2'30"）`;
    const created = await adapter.api.post<Record<string, unknown>>('/recipes', {
      name,
      notes: '含 emoji 🍅 与 \\ 反斜杠',
      ingredients: [{ name: '盐 & 糖', amountText: '适量 （约 1/2 勺）' }],
      steps: [{ content }],
    });
    expect(created.name).toBe(name);
    expect(created.notes).toBe('含 emoji 🍅 与 \\ 反斜杠');
    expect((created.steps as Array<{ content: string }>)[0]!.content).toBe(content);
    expect((created.ingredients as Array<{ amountText: string }>)[0]!.amountText).toBe(
      '适量 （约 1/2 勺）',
    );
  });

  it('拒绝空名称、非整数与类型错误字段，且不写入任何数据', async () => {
    const { adapter, database } = harness;
    const cases: unknown[] = [
      { name: '   ' },
      { name: 'x', cookingTimeMinutes: 1.5 },
      { name: 'x', spicyLevel: 6 },
      { name: 'x', calories: 49 },
      { name: 'x', favorite: 'true' },
      { name: 'x', category: 5 },
      { name: 'x', steps: [{ content: '  ' }] },
      { name: 'x', steps: [{ content: 'a', timerMinutes: 181 }] },
      { name: 'x', ingredients: [{ name: '番茄', quantity: -1 }] },
      { name: 'x', ingredients: [{ name: '番茄', unit: 'CUP' }] },
      { name: 'x', tags: ['ok', 5] },
      { name: 'x', mealTypes: ['MIDNIGHT'] },
    ];
    for (const body of cases) {
      await expect(adapter.api.post('/recipes', body)).rejects.toMatchObject({
        status: 400,
        code: 'VALIDATION_ERROR',
      });
    }
    expect(await database.query('SELECT "id" FROM "Recipe"')).toEqual([]);
  });

  it('拒绝关联不存在或已软删的库存食材', async () => {
    const { adapter, database } = harness;
    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "Ingredient" ("id","name","quantity","unit","version","deletedAt","createdAt","updatedAt")
         VALUES ('ing-dead','旧番茄',0,'GRAM',1,?,?,?)`,
        [NOW, NOW, NOW],
      );
    });
    await expect(
      adapter.api.post('/recipes', {
        name: '幽灵菜',
        ingredients: [{ ingredientId: 'ing-dead', name: '旧番茄', quantity: 1, unit: 'GRAM' }],
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('不存在或已删除') });

    await expect(
      adapter.api.post('/recipes', {
        name: '幽灵菜2',
        ingredients: [{ ingredientId: 'missing-id', name: '不存在', quantity: 1, unit: 'GRAM' }],
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('不存在或已删除') });
  });
});

describe('GET /api/v1/recipes 列表', () => {
  it('分页、过滤、搜索与稳定排序', async () => {
    const { adapter } = harness;
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await adapter.api.post<Record<string, unknown>>('/recipes', {
        name: `菜谱${index}`,
        notes: index === 1 ? '含检索词' : null,
        spicyLevel: index,
        mealTypes: [index === 2 ? 'DINNER' : 'LUNCH'],
        tags: [index === 2 ? '晚餐' : '午餐'],
      });
      ids.push(created.id as string);
      if (index === 1)
        await adapter.api.post(`/recipes/${created.id as string}/favorite`, {
          version: 1,
          favorite: true,
        });
    }

    const all = await adapter.api.get<Record<string, unknown>>('/recipes?page=1&pageSize=2');
    expect(all).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
    expect(all.items).toHaveLength(2);

    const filtered = await adapter.api.get<Record<string, unknown>>('/recipes?mealType=DINNER');
    expect((filtered.items as Array<{ id: string }>).map((x) => x.id)).toEqual([ids[2]]);

    const searched = await adapter.api.get<Record<string, unknown>>('/recipes?search=检索词');
    expect((searched.items as Array<{ id: string }>).map((x) => x.id)).toEqual([ids[1]]);

    const tagged = await adapter.api.get<Record<string, unknown>>('/recipes?tag=午餐');
    expect((tagged.items as Array<{ id: string }>).map((x) => x.id)).toHaveLength(2);

    const favorites = await adapter.api.get<Record<string, unknown>>('/recipes?favorite=true');
    expect((favorites.items as Array<{ id: string }>).map((x) => x.id)).toEqual([ids[1]]);

    const spicy = await adapter.api.get<Record<string, unknown>>('/recipes?spicyLevel=0');
    expect((spicy.items as Array<{ id: string }>).map((x) => x.id)).toEqual([ids[0]]);

    const asc = await adapter.api.get<Record<string, unknown>>(
      '/recipes?sortBy=name&sortOrder=asc',
    );
    expect((asc.items as Array<{ name: string }>).map((x) => x.name)).toEqual([
      '菜谱0',
      '菜谱1',
      '菜谱2',
    ]);
  });

  it('非法查询参数返回 400', async () => {
    const { adapter } = harness;
    for (const query of [
      '?page=0',
      '?page=abc',
      '?spicyLevel=9',
      '?favorite=yes',
      '?mealType=MIDNIGHT',
      '?sortBy=unknown',
      '?sortOrder=sideways',
    ]) {
      await expect(adapter.api.get(`/recipes${query}`)).rejects.toMatchObject({
        status: 400,
        code: 'VALIDATION_ERROR',
      });
    }
  });
});

describe('PUT/DELETE/favorite', () => {
  async function seed(): Promise<Record<string, unknown>> {
    const { adapter, database } = harness;
    await database.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "Ingredient" ("id","name","quantity","unit","version","createdAt","updatedAt")
         VALUES ('ing-1','番茄',1000,'GRAM',1,?,?)`,
        [NOW, NOW],
      );
    });
    return adapter.api.post<Record<string, unknown>>('/recipes', {
      name: '番茄炒蛋',
      tags: ['旧标签'],
      ingredients: [{ ingredientId: 'ing-1', name: '番茄', quantity: 200, unit: 'GRAM' }],
      steps: [{ content: '切' }],
    });
  }

  it('PUT 原子替换关联、版本递增，新操作携带旧版本 baseVersion', async () => {
    const { adapter, database } = harness;
    const created = await seed();
    // 模拟创建已推送：清空 pending 发件箱行，后续写应独立入队并携带旧版本。
    await database.withWriteTransaction((tx) => tx.run(`DELETE FROM "${SYNC_OUTBOX_TABLE}"`));

    const updated = await adapter.api.put<Record<string, unknown>>(
      `/recipes/${created.id as string}`,
      {
        version: 1,
        name: '番茄炒蛋（改）',
        tags: ['新标签'],
        mealTypes: ['DINNER'],
        ingredients: [{ ingredientId: 'ing-1', name: '番茄', quantity: 250, unit: 'GRAM' }],
        steps: [{ content: '完成' }],
        toolIds: [{ name: '炒锅' }],
      },
    );

    expect(updated.version).toBe(2);
    expect((updated.tags as Array<{ tag: { name: string } }>).map((t) => t.tag.name)).toEqual([
      '新标签',
    ]);
    expect(updated.tools as Array<unknown>).toHaveLength(1);
    expect(updated.ingredients).toHaveLength(1);
    expect(updated.steps).toHaveLength(1);

    expect(await database.query('SELECT "id" FROM "RecipeTag"')).toHaveLength(1);
    expect(await database.query('SELECT "id" FROM "RecipeMealType"')).toHaveLength(1);
    expect(await database.query('SELECT "id" FROM "RecipeStep"')).toHaveLength(1);

    const rows = await outbox(database);
    const recipeRows = rows.filter((row) => row.entity === 'Recipe');
    expect(recipeRows.map((row) => [row.kind, row.baseVersion])).toEqual([['upsert', 1]]);
    expect(JSON.parse(recipeRows[0]!.payloadJson ?? 'null')).toMatchObject({
      id: created.id,
      version: 2,
      name: '番茄炒蛋（改）',
    });
  });

  it('PUT 版本不匹配返回 409 且不落库', async () => {
    const { adapter, database } = harness;
    const created = await seed();
    await expect(
      adapter.api.put(`/recipes/${created.id as string}`, { version: 9, name: '冲突' }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'VERSION_CONFLICT',
      details: { actualVersion: 1 },
    });
    const [row] = await database.query<{ name: string; version: number }>(
      'SELECT "name","version" FROM "Recipe"',
    );
    expect(row).toEqual({ name: '番茄炒蛋', version: 1 });
    expect(await database.query('SELECT "id" FROM "RecipeTag"')).toHaveLength(1);
  });

  it('PUT 缺少 version 返回 400', async () => {
    const { adapter } = harness;
    const created = await seed();
    await expect(
      adapter.api.put(`/recipes/${created.id as string}`, { name: 'x' }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  });

  it('配料名称变化时清掉沿用旧 ingredientId', async () => {
    const { adapter } = harness;
    const created = await seed();
    const updated = await adapter.api.put<Record<string, unknown>>(
      `/recipes/${created.id as string}`,
      {
        version: 1,
        name: '番茄炒蛋',
        ingredients: [
          { name: '鸡蛋', quantity: 2, unit: 'PIECE' },
          { ingredientId: 'ing-1', name: '小番茄', quantity: 200, unit: 'GRAM' },
        ],
        steps: [{ content: '切' }],
      },
    );
    expect(updated.ingredients).toEqual([
      expect.objectContaining({ ingredientNameSnapshot: '鸡蛋', ingredientId: null }),
      expect.objectContaining({ ingredientNameSnapshot: '小番茄', ingredientId: null }),
    ]);
  });

  it('PUT 省略 category 保持原值，显式 null 清空', async () => {
    const { adapter } = harness;
    const created = await seed();
    const withCategory = await adapter.api.put<Record<string, unknown>>(
      `/recipes/${created.id as string}`,
      {
        version: 1,
        name: '番茄炒蛋',
        category: '家常菜',
      },
    );
    expect(withCategory.category).toBe('家常菜');

    const kept = await adapter.api.put<Record<string, unknown>>(
      `/recipes/${created.id as string}`,
      {
        version: 2,
        name: '番茄炒蛋',
      },
    );
    expect(kept.category).toBe('家常菜');

    const cleared = await adapter.api.put<Record<string, unknown>>(
      `/recipes/${created.id as string}`,
      {
        version: 3,
        name: '番茄炒蛋',
        category: null,
      },
    );
    expect(cleared.category).toBeNull();
  });

  it('Tag 软删后同名复用原 id 并复活，同时进入发件箱', async () => {
    const { adapter, database } = harness;
    const created = await seed();
    const [tagRow] = await database.query<{ id: string }>(
      `SELECT "id" FROM "Tag" WHERE "name" = '旧标签'`,
    );
    expect(tagRow?.id).toBeTruthy();
    await database.withWriteTransaction(async (tx) => {
      await tx.run(`UPDATE "Tag" SET "deletedAt" = ? WHERE "id" = ?`, [NOW, tagRow!.id]);
      await tx.run(`DELETE FROM "RecipeTag" WHERE "recipeId" = ?`, [created.id as string]);
    });

    const updated = await adapter.api.put<Record<string, unknown>>(
      `/recipes/${created.id as string}`,
      {
        version: 1,
        name: '番茄炒蛋',
        tags: ['旧标签'],
        steps: [{ content: '切' }],
      },
    );
    const tags = updated.tags as Array<{
      tagId: string;
      tag: { id: string; deletedAt: string | null };
    }>;
    expect(tags).toHaveLength(1);
    expect(tags[0]!.tagId).toBe(tagRow!.id);
    expect(tags[0]!.tag.deletedAt).toBeNull();
    expect(await database.query('SELECT "id" FROM "Tag"')).toHaveLength(1);

    const rows = await outbox(database);
    expect(rows.filter((row) => row.entity === 'Tag')).toEqual([
      expect.objectContaining({
        entityId: tagRow!.id,
        kind: 'upsert',
        payloadJson: expect.stringContaining('"deletedAt":null'),
      }),
    ]);
  });

  it('DELETE 需要正整数 version，成功后软删并写 delete 发件箱', async () => {
    const { adapter, database } = harness;
    const created = await seed();
    await database.withWriteTransaction((tx) => tx.run(`DELETE FROM "${SYNC_OUTBOX_TABLE}"`));

    await expect(adapter.api.delete(`/recipes/${created.id as string}`)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      adapter.api.delete(`/recipes/${created.id as string}?version=0`),
    ).rejects.toMatchObject({
      status: 400,
    });

    const removed = await adapter.api.delete<Record<string, unknown>>(
      `/recipes/${created.id as string}?version=1`,
    );
    expect(removed).toEqual({ id: created.id, deleted: true });

    const [row] = await database.query<{ deletedAt: string | null; version: number }>(
      'SELECT "deletedAt","version" FROM "Recipe" WHERE "id" = ?',
      [created.id as string],
    );
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.version).toBe(2);

    await expect(adapter.api.get(`/recipes/${created.id as string}`)).rejects.toMatchObject({
      status: 404,
    });
    // 已软删再删除：上游按「菜谱不存在」返回 404。
    await expect(
      adapter.api.delete(`/recipes/${created.id as string}?version=1`),
    ).rejects.toMatchObject({ status: 404 });

    const rows = await outbox(database);
    expect(rows.filter((row) => row.entity === 'Recipe').at(-1)).toMatchObject({
      kind: 'delete',
      baseVersion: 1,
    });
  });

  it('离线创建后删除时，保留可顺序重放的 upsert 与 delete', async () => {
    const { adapter, database } = harness;
    const created = await seed();

    await adapter.api.delete(`/recipes/${created.id as string}?version=1`);
    const rows = await outbox(database);
    expect(rows.filter((row) => row.entity === 'Recipe')).toEqual([
      expect.objectContaining({ kind: 'upsert', baseVersion: null }),
      expect.objectContaining({ kind: 'delete', baseVersion: 1 }),
    ]);
  });

  it('并发写同一版本最多一个成功，另一个 409 且数据未被覆盖', async () => {
    const { adapter, database } = harness;
    const created = await seed();
    await database.withWriteTransaction((tx) => tx.run(`DELETE FROM "${SYNC_OUTBOX_TABLE}"`));
    const id = created.id as string;

    const results = await Promise.allSettled([
      adapter.api.put(`/recipes/${id}`, { version: 1, name: '并发 A' }),
      adapter.api.put(`/recipes/${id}`, { version: 1, name: '并发 B' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
      code: 'VERSION_CONFLICT',
    });
    const [row] = await database.query<{ name: string; version: number }>(
      'SELECT "name","version" FROM "Recipe" WHERE "id" = ?',
      [id],
    );
    expect(row?.version).toBe(2);
    // PUT 是全量替换：请求未携带 steps 时关联被清空，且只能来自唯一成功的那次写。
    expect(await database.query('SELECT "id" FROM "RecipeStep"')).toHaveLength(0);
    expect(['并发 A', '并发 B']).toContain(row?.name);
    expect(
      (await outbox(database))
        .filter((entry) => entry.entity === 'Recipe')
        .map((entry) => entry.baseVersion),
    ).toEqual([1]);
  });

  it('favorite 原子条件写，旧版本返回 409', async () => {
    const { adapter, database } = harness;
    const created = await seed();
    await database.withWriteTransaction((tx) => tx.run(`DELETE FROM "${SYNC_OUTBOX_TABLE}"`));

    const favorited = await adapter.api.post<Record<string, unknown>>(
      `/recipes/${created.id as string}/favorite`,
      { version: 1, favorite: true },
    );
    expect(favorited).toMatchObject({ id: created.id, favorite: true, version: 2 });

    const rows = await outbox(database);
    expect(
      rows.filter((row) => row.entity === 'Recipe').map((row) => [row.kind, row.baseVersion]),
    ).toEqual([['upsert', 1]]);
    expect(JSON.parse(rows.at(-1)!.payloadJson ?? 'null')).toMatchObject({
      id: created.id,
      version: 2,
      favorite: true,
    });

    await expect(
      adapter.api.post(`/recipes/${created.id as string}/favorite`, {
        version: 1,
        favorite: false,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });

    await expect(
      adapter.api.post(`/recipes/${created.id as string}/favorite`, { version: 2, favorite: 'no' }),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });
});
