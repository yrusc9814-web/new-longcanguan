/**
 * AC1 端云收敛联调（新文件，避免与旧联调文件相互维护）。
 *
 * 覆盖端侧 T-007b 责任范围：菜谱聚合多次编辑、双端离线同名 Tag、
 * 拉取跳过后的推送冲突回滚、发件箱清零与表内容一致。
 * 需要云端契约实现的子项（购物单 baseItems 三方合并、拒绝响应携带权威行）
 * 在 `sync-conflict-convergence.test.ts` 的本地单测里覆盖，待云端分支合入后再补联调。
 */
import { SHOPPING_DEFAULT_LIST_ID, SYNC_SNAPSHOT_TABLES } from '@dafan/shared/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startWorkerd, type WorkerdHarness } from '../../cloud-worker/test/run-workerd';
import {
  BOOTSTRAP_SECRET,
  invite,
  ORIGIN,
  revoke,
} from '../../cloud-worker/test/household-support';
import { openDatabase, type DatabaseHandle } from '../src/db/database';
import { registerDomainRoutes } from '../src/local-api/domains';
import { createLocalApiRouter } from '../src/local-api/router';
import { createMemoryAppSecurity } from '../src/native/app-security';
import { createMemoryUploadsFiles } from '../src/native/upload-files';
import { createSyncEngine } from '../src/sync/engine';
import type { SocketLike } from '../src/sync/ws';
import { createNodeSqliteDriver } from './helpers/node-sqlite-driver';

let runtime: WorkerdHarness;
const devices: Awaited<ReturnType<typeof makeDevice>>[] = [];
type Device = Awaited<ReturnType<typeof makeDevice>>;

async function makeDevice(name: string): Promise<{
  database: DatabaseHandle;
  engine: ReturnType<typeof createSyncEngine>;
  events: { name: string; detail: unknown }[];
  requests: { path: string; status: number }[];
  failures: string[];
  revocations: string[];
  local<T>(path: string, method?: string, body?: unknown): Promise<T>;
  token(): Promise<string>;
  bindMember(ownerToken: string): Promise<unknown>;
}> {
  const database = await openDatabase({ driver: createNodeSqliteDriver({ path: ':memory:' }) });
  const security = createMemoryAppSecurity();
  const files = createMemoryUploadsFiles();
  const events: { name: string; detail: unknown }[] = [];
  const requests: { path: string; status: number }[] = [];
  const failures: string[] = [];
  const revocations: string[] = [];
  const { port } = new URL((await runtime.mf.ready).href);
  const fetchCloud = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const response = await runtime.dispatchFetch(input, init);
    requests.push({ path: url.pathname, status: response.status });
    if (response.status >= 400) {
      failures.push(`${url.pathname} ${response.status} ${await response.clone().text()}`);
    }
    return response;
  };
  const engine = createSyncEngine({
    getDatabase: async () => database,
    security,
    files,
    fetch: fetchCloud,
    events: (type, detail) => events.push({ name: type, detail }),
    onRevoked: ({ memberId }) => {
      revocations.push(memberId);
    },
    deviceId: () => name,
    snapshotPageSize: 2,
    socketFactory(cloudUrl) {
      const url = new URL(cloudUrl);
      const actual = new WebSocket(`ws://127.0.0.1:${port}${url.pathname}${url.search}`);
      const socket: SocketLike = {
        get readyState() {
          return actual.readyState;
        },
        onmessage: null,
        onclose: null,
        onerror: null,
        send: (data) => actual.send(data),
        close: (code, reason) => actual.close(code, reason),
      };
      actual.addEventListener('message', (event) => socket.onmessage?.(event));
      actual.addEventListener('close', (event) => socket.onclose?.(event));
      actual.addEventListener('error', (event) => socket.onerror?.(event));
      return socket;
    },
  });
  const router = createLocalApiRouter({
    readGateState: () => ({ pinRequired: false, pendingWipe: false }),
  });
  registerDomainRoutes(router, async () => database, undefined, engine);
  async function local<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await router.handle(
      new Request(`https://localhost/api/v1${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      }),
    );
    const result = await response.json();
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result.data as T;
  }
  async function token() {
    const { memberToken } = await security.getMemberToken();
    if (!memberToken) throw new Error('device is unbound');
    return memberToken;
  }
  await local('/settings');
  await local('/shopping-lists?status=ACTIVE');
  return {
    database,
    engine,
    events,
    requests,
    failures,
    revocations,
    local,
    token,
    async bindMember(ownerToken: string) {
      const { inviteCode } = await invite(runtime, ownerToken);
      return engine.join(
        { inviteCode, nickname: name },
        {
          origin: ORIGIN,
          confirmOverwriteLocal: true,
        },
      );
    },
  };
}

async function addDevice(name: string): Promise<Device> {
  const device = await makeDevice(name);
  devices.push(device);
  return device;
}

async function rows(database: DatabaseHandle, table: string) {
  return database.query<Record<string, unknown>>(`SELECT * FROM "${table}" ORDER BY "id"`);
}

async function noOutbox(database: DatabaseHandle) {
  expect(await database.query('SELECT opId FROM sync_outbox')).toEqual([]);
}

async function expectAligned(left: DatabaseHandle, right: DatabaseHandle) {
  for (const table of SYNC_SNAPSHOT_TABLES) {
    expect(await rows(left, table), table).toEqual(await rows(right, table));
  }
}

let owner: Device;

beforeAll(async () => {
  runtime = await startWorkerd(
    new URL('../../cloud-worker/test/workerd-entry.ts', import.meta.url),
    { bindings: { OWNER_BOOTSTRAP_SECRET: BOOTSTRAP_SECRET } },
  );
  owner = await addDevice('owner');
  await owner.engine.initOwner(
    { bootstrapSecret: BOOTSTRAP_SECRET, nickname: '馆主' },
    { origin: ORIGIN },
  );
}, 60_000);

afterAll(async () => {
  for (const { database, engine } of devices) {
    engine.stop();
    await database.close();
  }
  await runtime?.dispose();
});

describe('AC1 端侧收敛联调', () => {
  it('菜谱聚合（步骤/标签/餐次/角色）多次编辑往返推送零唯一约束报错且表内容一致', async () => {
    const member = await addDevice('recipe-member');
    await member.bindMember(await owner.token());

    const created = await owner.local<{ id: string }>('/recipes', 'POST', {
      name: '红烧肉',
      steps: [{ content: '切块' }, { content: '小火慢炖' }],
      tags: ['家常', '下饭'],
      mealTypes: ['LUNCH', 'DINNER'],
      mealRoles: ['MAIN'],
    });
    await owner.engine.syncOnce();
    await member.engine.pullNow();
    expect(
      (await rows(member.database, 'RecipeTag')).filter((row) => row.recipeId === created.id),
    ).toHaveLength(2);
    expect(
      (await rows(member.database, 'RecipeStep')).filter((row) => row.recipeId === created.id),
    ).toHaveLength(2);

    for (const [index, name] of ['红烧肉 v2', '红烧肉 v3'].entries()) {
      const detail = await owner.local<{ version: number }>(`/recipes/${created.id}`);
      await owner.local(`/recipes/${created.id}`, 'PUT', {
        name,
        version: detail.version,
        steps: [
          { content: `切块 ${index}` },
          { content: '小火慢炖' },
          { content: `收汁 ${index}` },
        ],
        tags: ['家常', '下饭', '宴客'],
        mealTypes: ['LUNCH', 'DINNER'],
        mealRoles: ['MAIN', 'SIDE'],
      });
      await owner.engine.syncOnce();
      await member.engine.pullNow();
      expect(owner.failures, JSON.stringify(owner.requests)).toEqual([]);
      await expectAligned(owner.database, member.database);
    }
    expect(
      (await rows(member.database, 'RecipeStep')).filter((row) => row.recipeId === created.id),
    ).toHaveLength(3);
    expect(
      (await rows(member.database, 'RecipeTag')).filter((row) => row.recipeId === created.id),
    ).toHaveLength(3);
    expect(
      (await rows(member.database, 'RecipeMealRole')).filter((row) => row.recipeId === created.id),
    ).toHaveLength(2);
    await noOutbox(owner.database);
    await noOutbox(member.database);
  }, 60_000);

  it('双端离线建同名 Tag：双端 RecipeTag 指向同一 Tag 且零唯一约束报错', async () => {
    const member = await addDevice('tag-member');
    await member.bindMember(await owner.token());

    owner.engine.stop();
    member.engine.stop();
    const ownerRecipe = await owner.local<{ id: string }>('/recipes', 'POST', {
      name: '馆主菜',
      tags: ['撞名标签'],
    });
    const memberRecipe = await member.local<{ id: string }>('/recipes', 'POST', {
      name: '成员菜',
      tags: ['撞名标签'],
    });

    await owner.engine.syncOnce();
    await member.engine.syncOnce();
    await owner.engine.pullNow();
    await member.engine.pullNow();

    expect(
      [...owner.requests, ...member.requests].filter(
        ({ path, status }) => path === '/api/sync/push' && status >= 400,
      ),
    ).toEqual([]);
    await expectAligned(owner.database, member.database);
    const tagIds = (await rows(member.database, 'Tag'))
      .filter((row) => row.name === '撞名标签')
      .map((row) => row.id);
    expect(tagIds).toHaveLength(1);
    const relations = (await rows(member.database, 'RecipeTag')).filter((row) =>
      [ownerRecipe.id, memberRecipe.id].includes(String(row.recipeId)),
    );
    expect(relations).toHaveLength(2);
    expect(new Set(relations.map((row) => row.tagId))).toEqual(new Set(tagIds));
    await noOutbox(owner.database);
    await noOutbox(member.database);
  }, 60_000);

  it('成员连续离线两次修改购物单后推送：无发件箱残留、双端一致、不误删馆主新增', async () => {
    const member = await addDevice('conflict-member');
    await member.bindMember(await owner.token());
    const shopping = `/shopping-lists/${SHOPPING_DEFAULT_LIST_ID}`;

    owner.engine.stop();
    member.engine.stop();
    const { version } = await owner.local<{ version: number }>(shopping);
    await owner.local(`${shopping}/items`, 'POST', { version, ingredientName: '馆主买肉' });
    await member.local(`${shopping}/items`, 'POST', { version, ingredientName: '成员买菜' });
    const second = await member.local<{ version: number }>(shopping);
    await member.local(`${shopping}/items`, 'POST', {
      version: second.version,
      ingredientName: '成员买蛋',
    });

    const first = await owner.local<{
      version: number;
      items: { id: string; ingredientName: string }[];
    }>(shopping);
    const ownerItem = first.items.find((item) => item.ingredientName === '馆主买肉')!;
    await owner.local(`/shopping-list-items/${ownerItem.id}`, 'PUT', {
      version: first.version,
      completed: true,
    });
    await owner.engine.syncOnce();
    // 馆主的两次改动已经上云；成员先跳过整个待推聚合，再连推两次本地操作。
    await member.engine.pullNow();
    await member.engine.syncOnce();
    expect(member.requests.filter(({ path }) => path === '/api/sync/push').length).toBeGreaterThan(
      0,
    );
    await owner.engine.pullNow();
    await owner.engine.syncOnce();
    await member.engine.pullNow();

    await noOutbox(owner.database);
    await noOutbox(member.database);
    await expectAligned(owner.database, member.database);
    const names = (await rows(member.database, 'ShoppingListItem')).map(
      (row) => row.ingredientNameSnapshot,
    );
    expect(names).toContain('馆主买肉');
    expect(new Set(names).size).toBe(names.length);
  }, 60_000);

  it('馆主撤权后成员设备停机，不再推送', async () => {
    const member = await addDevice('revoke-member');
    await member.bindMember(await owner.token());
    const binding = (await member.local<{ memberId: string }>('/settings')) ?? null;
    const memberId = binding?.memberId ?? (await member.engine.status()).memberId;
    expect(memberId).toBeTruthy();
    expect((await revoke(runtime, await owner.token(), memberId!)).status).toBe(204);
    await member.engine.syncOnce();
    expect(member.revocations).toContain(memberId);
    expect(member.engine.active).toBe(false);
  }, 60_000);
});
