import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../src/db/database.js';
import { createLocalApiRouter, type LocalApiRouter } from '../src/local-api/index.js';
import { registerDiners } from '../src/modules/diners/index.js';
import { tokens, forbidden, forbiddenWordsOf } from '../src/modules/diner-rules.js';
import { registerTools } from '../src/modules/tools/index.js';
import { createLocalApiFetch } from '../src/local-api/router.js';
import { loadGoogle2Adapter } from './local-api-adapter-harness.js';
import { createNodeSqliteDriver } from './helpers/node-sqlite-driver.js';

const ORIGIN = 'http://localhost';
const NOW = new Date('2026-11-21T08:00:00.000Z');

interface Harness {
  readonly db: DatabaseHandle;
  readonly router: LocalApiRouter;
}

async function createHarness(): Promise<Harness> {
  const db = await openDatabase({
    driver: createNodeSqliteDriver({ path: ':memory:' }),
    now: () => NOW,
  });
  const router = createLocalApiRouter({
    readGateState: () => ({ pendingWipe: false, pinRequired: false }),
    now: () => NOW,
  });
  const getDatabase = async () => db;
  registerDiners(router, getDatabase);
  registerTools(router, getDatabase);
  return { db, router };
}

interface JsonResult<T = Record<string, unknown>> {
  readonly status: number;
  readonly body: {
    success: boolean;
    data: T | null;
    error: { code: string; message: string } | null;
  };
}

async function call<T = Record<string, unknown>>(
  router: LocalApiRouter,
  method: string,
  path: string,
  body?: unknown,
): Promise<JsonResult<T>> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const response = await router.handle(new Request(`${ORIGIN}${path}`, init));
  return { status: response.status, body: await response.json() };
}

async function outbox(db: DatabaseHandle) {
  return db.query<{
    entity: string;
    entityId: string;
    kind: string;
    baseVersion: number | null;
    payloadJson: string | null;
  }>(
    'SELECT "entity", "entityId", "kind", "baseVersion", "payloadJson" FROM "sync_outbox" ORDER BY rowid',
  );
}

describe('diner-rules 纯函数', () => {
  it('按顿号/中英文逗号/分号/空白拆分并小写，忽略空项', () => {
    expect(tokens(' 花生、牛奶, 鸡蛋，虾 ；香菜 ')).toEqual(['花生', '牛奶', '鸡蛋', '虾', '香菜']);
    expect(tokens(null)).toEqual([]);
    expect(tokens('  ')).toEqual([]);
  });

  it('forbidden 做大小写无关的子串匹配', () => {
    expect(forbidden('Peanut Butter Cookies', ['peanut'])).toBe(true);
    expect(forbidden('清炒西兰花', ['花生'])).toBe(false);
  });

  it('forbiddenWordsOf 合并忌口/过敏/不喜欢三列', () => {
    expect(
      forbiddenWordsOf([
        { tabooText: '香菜', allergyText: '花生、虾', dislikesText: '苦瓜' },
        { tabooText: null, allergyText: '牛奶' },
      ]),
    ).toEqual(['花生', '虾', '香菜', '苦瓜', '牛奶']);
  });
});

describe('Diner 本地接口', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  it('POST 创建：默认 active=true，DTO 布尔显式转换，返回 201 并写发件箱', async () => {
    const created = await call<Record<string, unknown>>(harness.router, 'POST', '/api/v1/diners', {
      name: '  小满 ',
      tabooText: '香菜',
      unknownField: 'ignored',
    });
    expect(created.status).toBe(201);
    const diner = created.body.data as Record<string, unknown>;
    expect(diner.name).toBe('小满');
    expect(diner.active).toBe(true);
    expect(typeof diner.active).toBe('boolean');
    expect(diner.version).toBe(1);
    expect(diner.createdAt).toBe(NOW.toISOString());
    expect(diner.unknownField).toBeUndefined();

    const ops = await outbox(harness.db);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      entity: 'Diner',
      entityId: diner.id,
      kind: 'upsert',
      baseVersion: null,
    });
    expect(JSON.parse(ops[0]!.payloadJson as string)).toMatchObject({ name: '小满', active: true });
  });

  it('POST 拒绝空姓名与非布尔 active', async () => {
    const blank = await call(harness.router, 'POST', '/api/v1/diners', { name: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error?.code).toBe('VALIDATION_ERROR');

    const badActive = await call(harness.router, 'POST', '/api/v1/diners', {
      name: '小满',
      active: 'true',
    });
    expect(badActive.status).toBe(400);
    expect(await outbox(harness.db)).toHaveLength(0);
  });

  it('GET 支持 active 过滤、搜索与分页，返回上游分页信封', async () => {
    await call(harness.router, 'POST', '/api/v1/diners', { name: '阿碧', active: true });
    await call(harness.router, 'POST', '/api/v1/diners', { name: '阿黄', active: false });
    await call(harness.router, 'POST', '/api/v1/diners', {
      name: '小南',
      active: true,
      tabooText: '花生',
    });

    const activePage = await call<{
      items: Record<string, unknown>[];
      total: number;
      totalPages: number;
    }>(harness.router, 'GET', '/api/v1/diners?active=true&page=1&pageSize=2');
    expect(activePage.status).toBe(200);
    expect(activePage.body.data?.items.map((item) => item.name)).toEqual(['小南', '阿碧']);
    expect(activePage.body.data?.total).toBe(2);
    expect(activePage.body.data?.totalPages).toBe(1);

    const secondPage = await call<{ items: Record<string, unknown>[]; page: number }>(
      harness.router,
      'GET',
      '/api/v1/diners?active=true&page=2&pageSize=1',
    );
    expect(secondPage.body.data?.page).toBe(2);
    expect(secondPage.body.data?.items.map((item) => item.name)).toEqual(['阿碧']);

    const searched = await call<{ items: Record<string, unknown>[] }>(
      harness.router,
      'GET',
      `/api/v1/diners?search=${encodeURIComponent('花')}`,
    );
    expect(searched.body.data?.items.map((item) => item.name)).toEqual(['小南']);

    const desc = await call<{ items: Record<string, unknown>[] }>(
      harness.router,
      'GET',
      '/api/v1/diners?sortOrder=desc',
    );
    expect(desc.body.data?.items.map((item) => item.name)).toEqual(['阿黄', '阿碧', '小南']);
  });

  it('GET 拒绝非法 active / sortOrder 查询值', async () => {
    for (const path of ['/api/v1/diners?active=1', '/api/v1/diners?sortOrder=up']) {
      const result = await call(harness.router, 'GET', path);
      expect(result.status).toBe(400);
      expect(result.body.error?.code).toBe('VALIDATION_ERROR');
    }
  });

  it('PUT 整体覆盖忌口三列，显式 null 清空，版本自增并写发件箱', async () => {
    const created = await call<Record<string, unknown>>(harness.router, 'POST', '/api/v1/diners', {
      name: '小满',
      tabooText: '香菜',
      allergyText: '花生',
      dislikesText: '苦瓜',
      portionNote: '一碗',
    });
    const id = created.body.data!.id as string;

    const updated = await call<Record<string, unknown>>(
      harness.router,
      'PUT',
      `/api/v1/diners/${id}`,
      {
        version: 1,
        tabooText: '葱',
        allergyText: null,
        dislikesText: '  辣椒  ',
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({
      name: '小满',
      tabooText: '葱',
      allergyText: null,
      dislikesText: '辣椒',
      portionNote: '一碗',
      active: true,
      version: 2,
    });

    const ops = await outbox(harness.db);
    // 主代理发件箱会把同一实体的连续 pending 写合并成一条，这里只断言最终意图。
    expect(ops.at(-1)).toMatchObject({ entity: 'Diner', entityId: id, kind: 'upsert' });
    expect(JSON.parse(ops.at(-1)!.payloadJson as string)).toMatchObject({
      tabooText: '葱',
      allergyText: null,
      dislikesText: '辣椒',
    });
  });

  it('PUT 可停用（active=false）且 DTO 仍为布尔 false', async () => {
    const created = await call<Record<string, unknown>>(harness.router, 'POST', '/api/v1/diners', {
      name: '小满',
    });
    const id = created.body.data!.id as string;
    const updated = await call<Record<string, unknown>>(
      harness.router,
      'PUT',
      `/api/v1/diners/${id}`,
      {
        version: 1,
        active: false,
      },
    );
    expect(updated.body.data?.active).toBe(false);
    const listed = await call<{ items: Record<string, unknown>[]; total: number }>(
      harness.router,
      'GET',
      '/api/v1/diners?active=true',
    );
    expect(listed.body.data?.total).toBe(0);
  });

  it('PUT 版本冲突返回 409 VERSION_CONFLICT 且不追加发件箱', async () => {
    const created = await call<Record<string, unknown>>(harness.router, 'POST', '/api/v1/diners', {
      name: '小满',
    });
    const id = created.body.data!.id as string;
    await call(harness.router, 'PUT', `/api/v1/diners/${id}`, { version: 1, notes: '第一次' });
    const before = await outbox(harness.db);

    const conflict = await call(harness.router, 'PUT', `/api/v1/diners/${id}`, {
      version: 1,
      notes: '过期写入',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error?.code).toBe('VERSION_CONFLICT');
    expect(await outbox(harness.db)).toHaveLength(before.length);
  });

  it('PUT 缺 version 或目标不存在时返回 400 / 404', async () => {
    const created = await call<Record<string, unknown>>(harness.router, 'POST', '/api/v1/diners', {
      name: '小满',
    });
    const id = created.body.data!.id as string;
    expect((await call(harness.router, 'PUT', `/api/v1/diners/${id}`, { notes: 'x' })).status).toBe(
      400,
    );
    const missing = await call(harness.router, 'PUT', '/api/v1/diners/not-there', {
      version: 1,
      notes: 'x',
    });
    expect(missing.status).toBe(404);
  });

  it('未注册剔除端点：GET/DELETE /diners/:id 不提供业务实现', async () => {
    const created = await call<Record<string, unknown>>(harness.router, 'POST', '/api/v1/diners', {
      name: '小满',
    });
    const id = created.body.data!.id as string;
    const detail = await call(harness.router, 'GET', `/api/v1/diners/${id}`);
    expect(detail.status).toBe(404);
    expect(detail.body.error?.code).toBe('NOT_FOUND');
    const removed = await call(harness.router, 'DELETE', `/api/v1/diners/${id}`);
    expect(removed.status).toBe(404);
  });
});

describe('KitchenTool 本地接口', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  it('POST 创建返回 201，quantity 默认 1，icon 原样保存并写发件箱', async () => {
    const created = await call<Record<string, unknown>>(harness.router, 'POST', '/api/v1/tools', {
      name: '  电饭锅 ',
      icon: '🍚',
      status: 'AVAILABLE',
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      name: '电饭锅',
      imagePath: null,
      icon: '🍚',
      category: null,
      quantity: 1,
      status: 'AVAILABLE',
      notes: null,
      version: 1,
    });
    const ops = await outbox(harness.db);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ entity: 'KitchenTool', kind: 'upsert', baseVersion: null });
  });

  it('POST 严格字段：未知字段与 version 一律 400', async () => {
    const unknown = await call(harness.router, 'POST', '/api/v1/tools', {
      name: '电饭锅',
      color: 'red',
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error?.message).toContain('color');

    const withVersion = await call(harness.router, 'POST', '/api/v1/tools', {
      name: '电饭锅',
      version: 1,
    });
    expect(withVersion.status).toBe(400);

    const badQuantity = await call(harness.router, 'POST', '/api/v1/tools', {
      name: '电饭锅',
      quantity: 1.5,
    });
    expect(badQuantity.status).toBe(400);
    expect(await outbox(harness.db)).toHaveLength(0);
  });

  it('POST 拒绝超长 icon（>20）与空名称', async () => {
    expect(
      (
        await call(harness.router, 'POST', '/api/v1/tools', {
          name: '电饭锅',
          icon: '🍚'.repeat(21),
        })
      ).status,
    ).toBe(400);
    expect((await call(harness.router, 'POST', '/api/v1/tools', { name: ' ' })).status).toBe(400);
  });

  it('GET 列表排除软删、支持 search，按 updatedAt 倒序', async () => {
    await call(harness.router, 'POST', '/api/v1/tools', { name: '电饭锅' });
    await call(harness.router, 'POST', '/api/v1/tools', { name: '菜刀' });
    const all = await call<Record<string, unknown>[]>(harness.router, 'GET', '/api/v1/tools');
    expect(all.status).toBe(200);
    expect(all.body.data?.map((tool) => tool.name).sort()).toEqual(['电饭锅', '菜刀']);

    const searched = await call<Record<string, unknown>[]>(
      harness.router,
      'GET',
      `/api/v1/tools?search=${encodeURIComponent('刀')}`,
    );
    expect(searched.body.data?.map((tool) => tool.name)).toEqual(['菜刀']);
  });

  it('PUT 覆盖字段、version+1；省略 icon 保留旧值，显式 null 清空', async () => {
    const created = await call<Record<string, unknown>>(harness.router, 'POST', '/api/v1/tools', {
      name: '电饭锅',
      icon: '🍚',
      quantity: 2,
      notes: '旧备注',
    });
    const id = created.body.data!.id as string;

    const updated = await call<Record<string, unknown>>(
      harness.router,
      'PUT',
      `/api/v1/tools/${id}`,
      {
        version: 1,
        name: '电饭锅',
        category: '厨电',
      },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({
      icon: '🍚',
      category: '厨电',
      quantity: 1,
      notes: null,
      version: 2,
    });

    const cleared = await call<Record<string, unknown>>(
      harness.router,
      'PUT',
      `/api/v1/tools/${id}`,
      {
        version: 2,
        name: '电饭锅',
        icon: null,
      },
    );
    expect(cleared.body.data?.icon).toBeNull();

    const ops = await outbox(harness.db);
    expect(ops.at(-1)).toMatchObject({ entity: 'KitchenTool', entityId: id, kind: 'upsert' });
    expect(JSON.parse(ops.at(-1)!.payloadJson as string)).toMatchObject({
      icon: null,
      quantity: 1,
    });
  });

  it('PUT 缺 name（上游 required）与未知字段返回 400，版本冲突返回 409', async () => {
    const created = await call<Record<string, unknown>>(harness.router, 'POST', '/api/v1/tools', {
      name: '电饭锅',
    });
    const id = created.body.data!.id as string;

    const missingName = await call(harness.router, 'PUT', `/api/v1/tools/${id}`, { version: 1 });
    expect(missingName.status).toBe(400);

    const unknown = await call(harness.router, 'PUT', `/api/v1/tools/${id}`, {
      version: 1,
      name: '电饭锅',
      imageUrl: 'x',
    });
    expect(unknown.status).toBe(400);

    await call(harness.router, 'PUT', `/api/v1/tools/${id}`, { version: 1, name: '电饭锅' });
    const conflict = await call(harness.router, 'PUT', `/api/v1/tools/${id}`, {
      version: 1,
      name: '过期货',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error?.code).toBe('VERSION_CONFLICT');
  });

  it('DELETE 需要 query version：软删后列表不可见，重复删除 404，版本不符 409', async () => {
    const created = await call<Record<string, unknown>>(harness.router, 'POST', '/api/v1/tools', {
      name: '电饭锅',
    });
    const id = created.body.data!.id as string;

    expect((await call(harness.router, 'DELETE', `/api/v1/tools/${id}`)).status).toBe(400);
    expect((await call(harness.router, 'DELETE', `/api/v1/tools/${id}?version=0`)).status).toBe(
      400,
    );

    const wrong = await call(harness.router, 'DELETE', `/api/v1/tools/${id}?version=9`);
    expect(wrong.status).toBe(409);

    const removed = await call<{ id: string; deleted: boolean }>(
      harness.router,
      'DELETE',
      `/api/v1/tools/${id}?version=1`,
    );
    expect(removed.status).toBe(200);
    expect(removed.body.data).toEqual({ id, deleted: true });

    const listed = await call<Record<string, unknown>[]>(harness.router, 'GET', '/api/v1/tools');
    expect(listed.body.data).toEqual([]);

    expect((await call(harness.router, 'DELETE', `/api/v1/tools/${id}?version=2`)).status).toBe(
      404,
    );

    const ops = await outbox(harness.db);
    expect(ops.at(-1)).toMatchObject({
      entity: 'KitchenTool',
      entityId: id,
      kind: 'delete',
      baseVersion: 1,
    });
    expect(JSON.parse(ops.at(-1)!.payloadJson as string)).toMatchObject({
      id,
      version: 1,
      deletedAt: NOW.toISOString(),
    });
  });

  it('DELETE 保留行内 deletedAt（软删而非物理删除）', async () => {
    const created = await call<Record<string, unknown>>(harness.router, 'POST', '/api/v1/tools', {
      name: '电饭锅',
    });
    const id = created.body.data!.id as string;
    await call(harness.router, 'DELETE', `/api/v1/tools/${id}?version=1`);
    const rows = await harness.db.query<{ deletedAt: string | null; version: number }>(
      'SELECT "deletedAt", "version" FROM "KitchenTool" WHERE "id" = ?',
      [id],
    );
    expect(rows[0]?.deletedAt).toBe(NOW.toISOString());
    expect(rows[0]?.version).toBe(2);
  });

  it('上游已剔除的 GET /tools/:id 不提供业务实现', async () => {
    const created = await call<Record<string, unknown>>(harness.router, 'POST', '/api/v1/tools', {
      name: '电饭锅',
    });
    const id = created.body.data!.id as string;
    const detail = await call(harness.router, 'GET', `/api/v1/tools/${id}`);
    expect(detail.status).toBe(404);
  });
});

describe('真实 google2-adapter 调用本地路由', () => {
  it('replaceToolService 的 save/delete 与忌口三列保存', async () => {
    const db = await openDatabase({
      driver: createNodeSqliteDriver({ path: ':memory:' }),
      now: () => NOW,
    });
    const router = createLocalApiRouter({
      readGateState: () => ({ pendingWipe: false, pinRequired: false }),
      now: () => NOW,
    });
    const getDatabase = async () => db;
    registerDiners(router, getDatabase);
    registerTools(router, getDatabase);
    try {
      const localFetch = createLocalApiFetch({ router, origin: ORIGIN });
      const { api, window } = loadGoogle2Adapter({ fetch: localFetch, origin: ORIGIN });
      const domain = (
        window as unknown as {
          DafanDomainAdapter: {
            replaceToolService(service: { data: unknown[] }): () => Promise<unknown>;
          };
        }
      ).DafanDomainAdapter;

      const service: { data: Array<{ id: string; version: number }> } = { data: [] };
      const reload = domain.replaceToolService(service);
      const tools = service as unknown as {
        save(tool: Record<string, unknown>): Promise<{ id: string; version: number }>;
        delete(id: string): Promise<void>;
      };
      const created = await tools.save({ name: '炒锅', icon: '🍳' });
      const edited = await tools.save({ id: created.id, name: '大炒锅' });
      expect(edited.version).toBe(2);
      await reload();
      // 适配器 toolBody 始终回传 icon: tool.icon ?? null，编辑时未带 icon 即清空（与上游一致）。
      await expect(api.get('/tools')).resolves.toMatchObject([
        { id: created.id, name: '大炒锅', icon: null },
      ]);
      await tools.delete(created.id);
      await expect(api.get('/tools')).resolves.toEqual([]);

      const diner = await api.post<{ id: string; version: number; active: boolean }>('/diners', {
        name: '小满',
        active: true,
      });
      expect(diner.active).toBe(true);
      await expect(
        api.put(`/diners/${diner.id}`, {
          version: diner.version,
          tabooText: '香菜',
          allergyText: '花生',
          dislikesText: '苦瓜',
        }),
      ).resolves.toMatchObject({
        version: 2,
        tabooText: '香菜',
        allergyText: '花生',
        dislikesText: '苦瓜',
        active: true,
      });
      await expect(api.get('/diners?active=true&page=1&pageSize=100')).resolves.toMatchObject({
        total: 1,
        items: [{ id: diner.id, active: true }],
      });
    } finally {
      await db.close();
    }
  });
});
