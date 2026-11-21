import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type DatabaseHandle } from '../src/db/database.js';
import { SYNC_OUTBOX_TABLE } from '../src/db/schema.js';
import { createLocalApiRouter, type LocalApiRouter } from '../src/local-api/index.js';
import { registerRecipes } from '../src/modules/recipes/index.js';
import { registerStores } from '../src/modules/stores/index.js';
import { registerTools } from '../src/modules/tools/index.js';
import { registerIngredients } from '../src/modules/ingredients/index.js';
import { createNodeSqliteDriver } from './helpers/node-sqlite-driver.js';

const ORIGIN = 'http://localhost';
const NOW = new Date('2026-11-21T08:00:00.000Z');
const DELETED_AT = NOW.toISOString();

interface JsonResult<T = Record<string, unknown>> {
  readonly status: number;
  readonly body: {
    success: boolean;
    data: T | null;
    error: { code: string; message: string; details?: Record<string, unknown> } | null;
  };
}

interface OutboxRow {
  readonly opId: string;
  readonly entity: string;
  readonly entityId: string;
  readonly kind: 'upsert' | 'delete' | 'command';
  readonly commandType: string | null;
  readonly baseVersion: number | null;
  readonly payloadJson: string | null;
}

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
  registerRecipes(router, getDatabase);
  registerStores(router, getDatabase);
  registerTools(router, getDatabase);
  registerIngredients(router, getDatabase);
  return { db, router };
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
  return { status: response.status, body: (await response.json()) as JsonResult<T>['body'] };
}

async function outbox(db: DatabaseHandle): Promise<OutboxRow[]> {
  return db.query<OutboxRow>(
    `SELECT "opId","entity","entityId","kind","commandType","baseVersion","payloadJson"
     FROM "${SYNC_OUTBOX_TABLE}" ORDER BY rowid`,
  );
}

/**
 * 服务端重放模拟：按发件箱 rowid 顺序逐条执行，每一步的 baseVersion 必须严格等于
 * 服务端当前版本；返回最终版本与删除证据，用来和本地行对照。
 */
function createServerReplay() {
  const versions = new Map<string, number>();
  const deletions = new Map<string, string>();
  const key = (entity: string, entityId: string) => `${entity}:${entityId}`;

  return {
    apply(row: OutboxRow): void {
      const scope = key(row.entity, row.entityId);
      const payload = row.payloadJson === null ? null : JSON.parse(row.payloadJson);
      const current = versions.get(scope) ?? 0;
      if (row.kind === 'delete') {
        expect(row.baseVersion, `${scope} delete baseVersion`).toBe(current);
        // 删除载荷只允许 deletedAt 一项。
        expect(payload).toEqual({ deletedAt: expect.any(String) });
        versions.set(scope, current + 1);
        deletions.set(scope, payload.deletedAt as string);
        return;
      }
      if (row.kind === 'command') {
        expect(row.baseVersion, `${scope} command baseVersion`).toBe(current);
        versions.set(scope, current + 1);
        return;
      }
      if (row.baseVersion === null) {
        expect(versions.has(scope), `${scope} 只能新建一次`).toBe(false);
        // 部分实体（Store/KitchenTool）的 upsert payload 不带 version，只校验本地行。
        if (payload.version !== undefined) expect(payload.version).toBe(1);
        versions.set(scope, 1);
        return;
      }
      expect(row.baseVersion, `${scope} upsert baseVersion`).toBe(current);
      if (payload.version !== undefined) expect(payload.version).toBe(current + 1);
      versions.set(scope, current + 1);
    },
    versionOf(entity: string, entityId: string): number {
      return versions.get(key(entity, entityId)) ?? 0;
    },
    deletedAtOf(entity: string, entityId: string): string | null {
      return deletions.get(key(entity, entityId)) ?? null;
    },
  };
}

async function localRow(
  db: DatabaseHandle,
  table: 'Recipe' | 'Store' | 'KitchenTool' | 'Ingredient',
  id: string,
): Promise<{ version: number; deletedAt: string | null }> {
  const [row] = await db.query<{ version: number; deletedAt: string | null }>(
    `SELECT "version","deletedAt" FROM "${table}" WHERE "id" = ?`,
    [id],
  );
  if (!row) throw new Error(`${table} ${id} 不存在`);
  return row;
}

describe('发件箱生命周期：严格 FIFO 与最小删除载荷', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  it('菜谱 新建→编辑→编辑→删除 逐条重放版本严格匹配', async () => {
    const { db, router } = harness;
    const created = await call<Record<string, unknown>>(router, 'POST', '/api/v1/recipes', {
      name: '番茄炒蛋',
      tags: ['快手菜'],
      steps: [{ content: '切番茄' }],
    });
    expect(created.status).toBe(201);
    const id = created.body.data!.id as string;

    const first = await call<Record<string, unknown>>(router, 'PUT', `/api/v1/recipes/${id}`, {
      version: 1,
      name: '番茄炒蛋（一改）',
    });
    expect(first.status).toBe(200);
    expect(first.body.data!.version).toBe(2);

    const second = await call<Record<string, unknown>>(router, 'PUT', `/api/v1/recipes/${id}`, {
      version: 2,
      name: '番茄炒蛋（二改）',
    });
    expect(second.status).toBe(200);
    expect(second.body.data!.version).toBe(3);

    const removed = await call(router, 'DELETE', `/api/v1/recipes/${id}?version=3`);
    expect(removed.status).toBe(200);

    const rows = (await outbox(db)).filter((row) => row.entity === 'Recipe');
    expect(rows.map((row) => [row.kind, row.baseVersion])).toEqual([
      ['upsert', null],
      ['upsert', 1],
      ['upsert', 2],
      ['delete', 3],
    ]);

    const replay = createServerReplay();
    for (const row of rows) replay.apply(row);
    const local = await localRow(db, 'Recipe', id);
    expect(local.version).toBe(4);
    expect(local.version).toBe(replay.versionOf('Recipe', id));
    expect(local.deletedAt).toBe(DELETED_AT);
    expect(local.deletedAt).toBe(replay.deletedAtOf('Recipe', id));
    expect(JSON.parse(rows.at(-1)!.payloadJson as string)).toEqual({ deletedAt: DELETED_AT });
  });

  it('食材 新建→顶层编辑→consume→删除 逐条重放版本严格匹配', async () => {
    const { db, router } = harness;
    const created = await call<Record<string, unknown>>(router, 'POST', '/api/v1/ingredients', {
      name: '番茄',
      unit: 'GRAM',
      batches: [{ quantity: 500, unit: 'GRAM' }],
    });
    expect(created.status).toBe(201);
    const id = created.body.data!.id as string;

    const edited = await call<Record<string, unknown>>(router, 'PUT', `/api/v1/ingredients/${id}`, {
      version: 1,
      name: '番茄',
      unit: 'GRAM',
      quantity: 400,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data!.version).toBe(2);

    const consumed = await call<Record<string, unknown>>(
      router,
      'POST',
      `/api/v1/ingredients/${id}/consume`,
      { mode: 'ALL', ingredientVersion: 2 },
    );
    expect(consumed.status).toBe(200);
    expect((consumed.body.data!.ingredient as { version: number }).version).toBe(3);

    const removed = await call(router, 'DELETE', `/api/v1/ingredients/${id}?version=3`);
    expect(removed.status).toBe(200);

    const rows = (await outbox(db)).filter((row) => row.entity === 'Ingredient');
    expect(rows.map((row) => [row.kind, row.commandType, row.baseVersion])).toEqual([
      ['upsert', null, null],
      ['command', 'INGREDIENT_UPDATE_SYNC_BATCHES', 1],
      ['command', 'INGREDIENT_CONSUME', 2],
      ['delete', null, 3],
    ]);

    const replay = createServerReplay();
    for (const row of rows) replay.apply(row);
    const local = await localRow(db, 'Ingredient', id);
    expect(local.version).toBe(4);
    expect(local.version).toBe(replay.versionOf('Ingredient', id));
    expect(local.deletedAt).toBe(DELETED_AT);
    expect(local.deletedAt).toBe(replay.deletedAtOf('Ingredient', id));
    expect(JSON.parse(rows.at(-1)!.payloadJson as string)).toEqual({ deletedAt: DELETED_AT });
  });

  it('补验店铺与厨房工具的删除载荷同样只有 deletedAt', async () => {
    const { db, router } = harness;
    const store = await call<Record<string, unknown>>(router, 'POST', '/api/v1/stores', {
      name: '面馆',
    });
    const storeId = store.body.data!.id as string;
    await call(router, 'PUT', `/api/v1/stores/${storeId}`, { version: 1, name: '新面馆' });
    expect((await call(router, 'DELETE', `/api/v1/stores/${storeId}?version=2`)).status).toBe(200);

    const tool = await call<Record<string, unknown>>(router, 'POST', '/api/v1/tools', {
      name: '炒锅',
    });
    const toolId = tool.body.data!.id as string;
    await call(router, 'PUT', `/api/v1/tools/${toolId}`, { version: 1, name: '不粘锅' });
    expect((await call(router, 'DELETE', `/api/v1/tools/${toolId}?version=2`)).status).toBe(200);

    const rows = await outbox(db);
    const replay = createServerReplay();
    for (const row of rows) replay.apply(row);

    for (const [entity, table, id] of [
      ['Store', 'Store', storeId],
      ['KitchenTool', 'KitchenTool', toolId],
    ] as const) {
      const deletes = rows.filter((row) => row.entity === entity && row.kind === 'delete');
      expect(deletes).toHaveLength(1);
      expect(JSON.parse(deletes[0]!.payloadJson as string)).toEqual({ deletedAt: DELETED_AT });
      const local = await localRow(db, table, id);
      expect(local.deletedAt).toBe(DELETED_AT);
      expect(local.deletedAt).toBe(replay.deletedAtOf(entity, id));
      expect(local.version).toBe(replay.versionOf(entity, id));
      expect(local.version).toBe(3);
    }
  });

  it('四种删除载荷统一为 {deletedAt}，且与本地软删时间同一字符串', async () => {
    const { db, router } = harness;
    const recipe = await call<Record<string, unknown>>(router, 'POST', '/api/v1/recipes', {
      name: '临时菜',
    });
    const store = await call<Record<string, unknown>>(router, 'POST', '/api/v1/stores', {
      name: '临时店',
    });
    const tool = await call<Record<string, unknown>>(router, 'POST', '/api/v1/tools', {
      name: '临时锅',
    });
    const ingredient = await call<Record<string, unknown>>(router, 'POST', '/api/v1/ingredients', {
      name: '临时盐',
      unit: 'GRAM',
      batches: [{ quantity: 10, unit: 'GRAM' }],
    });

    await call(router, 'DELETE', `/api/v1/recipes/${recipe.body.data!.id as string}?version=1`);
    await call(router, 'DELETE', `/api/v1/stores/${store.body.data!.id as string}?version=1`);
    await call(router, 'DELETE', `/api/v1/tools/${tool.body.data!.id as string}?version=1`);
    await call(
      router,
      'DELETE',
      `/api/v1/ingredients/${ingredient.body.data!.id as string}?version=1`,
    );

    const rows = await outbox(db);
    const deletes = rows.filter((row) => row.kind === 'delete');
    expect(deletes.map((row) => row.entity).sort()).toEqual([
      'Ingredient',
      'KitchenTool',
      'Recipe',
      'Store',
    ]);
    for (const row of deletes) {
      expect(JSON.parse(row.payloadJson as string)).toEqual({ deletedAt: DELETED_AT });
      const [local] = await db.query<{ deletedAt: string | null }>(
        `SELECT "deletedAt" FROM "${row.entity}" WHERE "id" = ?`,
        [row.entityId],
      );
      expect(local?.deletedAt).toBe(
        (JSON.parse(row.payloadJson as string) as { deletedAt: string }).deletedAt,
      );
    }
  });
});
