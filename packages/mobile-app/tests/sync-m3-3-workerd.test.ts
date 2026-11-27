/**
 * M3-3 最终收口联调（真实 workerd + 双端独立 SQLite）：
 *
 * a. 对端新建 Recipe/Tag/KitchenTool/Ingredient/Diner 后，本端未 pull 直接推送冲突
 *    排餐/旧版菜谱触发 409：单次 syncOnce 零外键报错、发件箱清零、27 表逐列一致。
 * b. 同聚合根两步链 [Op1, Op2] 在 Op1 被拒整链丢弃时，Op2 触及的既有 MealRecord /
 *    Ingredient 副根完整恢复为云端权威状态。
 * c. 一端在线删除 + SHOPPING_CHECKIN 入库移除后，另一端离线连续 3 步修改：已删/
 *    已入库条目零复活，新增项全保留。
 * d. 增量拉取新 UploadAsset 遇瞬时 503：单轮不紧循环耗光重试，网络恢复后下一次同步
 *    落盘主图与缩略图并通过 SHA-256 校验。
 */
import { createHash } from 'node:crypto';

import { SHOPPING_DEFAULT_LIST_ID, SYNC_SNAPSHOT_TABLES } from '@dafan/shared/sync';
import { afterEach, describe, expect, it } from 'vitest';

import { startWorkerd, type WorkerdHarness } from '../../cloud-worker/test/run-workerd';
import { BOOTSTRAP_SECRET, invite, ORIGIN } from '../../cloud-worker/test/household-support';
import { openDatabase, type DatabaseHandle } from '../src/db/database';
import { registerDomainRoutes } from '../src/local-api/domains';
import { createLocalApiRouter } from '../src/local-api/router';
import { createMemoryAppSecurity } from '../src/native/app-security';
import { createMemoryUploadsFiles } from '../src/native/upload-files';
import { createSyncEngine } from '../src/sync/engine';
import type { SocketLike } from '../src/sync/ws';
import { createNodeSqliteDriver, createTempDatabasePath } from './helpers/node-sqlite-driver';

interface PushRecord {
  readonly operations: readonly string[];
  readonly status: number;
  readonly body: Record<string, unknown> | null;
}

type Device = Awaited<ReturnType<typeof createDevice>>;

let harness: { runtime: WorkerdHarness; devices: Device[] } | null = null;

afterEach(async () => {
  if (!harness) return;
  const current = harness;
  harness = null;
  for (const device of current.devices) device.engine.stop();
  for (const device of current.devices) {
    for (const socket of device.sockets) {
      if (socket.readyState === WebSocket.CLOSED) continue;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 5_000);
        socket.addEventListener(
          'close',
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
        try {
          socket.close(1000);
        } catch {
          // 已关闭的连接重复 close 无副作用。
        }
      });
    }
  }
  for (const device of current.devices) {
    await device.database.close();
    device.cleanup();
  }
  await current.runtime.dispose();
});

async function createCloud(): Promise<WorkerdHarness> {
  return startWorkerd(new URL('../../cloud-worker/test/workerd-entry.ts', import.meta.url), {
    bindings: { OWNER_BOOTSTRAP_SECRET: BOOTSTRAP_SECRET },
  });
}

async function createDevice(runtime: WorkerdHarness, name: string) {
  const target = createTempDatabasePath(`m3-3-${name}`);
  const database = await openDatabase({
    driver: createNodeSqliteDriver({ path: target.path }),
  });
  const security = createMemoryAppSecurity();
  const files = createMemoryUploadsFiles();
  const events: { name: string; detail: unknown }[] = [];
  const pushes: PushRecord[] = [];
  const sockets: WebSocket[] = [];
  const imageRequests: { path: string; status: number }[] = [];
  const imageFailures = { remaining: 0 };
  const { port } = new URL((await runtime.mf.ready).href);
  const engine = createSyncEngine({
    getDatabase: async () => database,
    security,
    files,
    events: (type, detail) => events.push({ name: type, detail }),
    deviceId: () => name,
    snapshotPageSize: 2,
    fetch: async (input, init) => {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      if (url.pathname.startsWith('/api/sync/images') && method === 'GET') {
        const record = { path: url.pathname + url.search, status: 0 };
        imageRequests.push(record);
        if (imageFailures.remaining > 0) {
          imageFailures.remaining -= 1;
          record.status = 503;
          return new Response('unavailable', { status: 503 });
        }
        const response = await runtime.dispatchFetch(input, init);
        record.status = response.status;
        return response;
      }
      const response = await runtime.dispatchFetch(input, init);
      if (url.pathname === '/api/sync/push') {
        const sent = JSON.parse(String(init?.body ?? '{}')) as { operations?: { id: string }[] };
        let body: Record<string, unknown> | null = null;
        try {
          body = (await response.clone().json()) as Record<string, unknown>;
        } catch {
          body = null;
        }
        pushes.push({
          operations: (sent.operations ?? []).map((operation) => operation.id),
          status: response.status,
          body,
        });
      }
      return response;
    },
    socketFactory(cloudUrl) {
      const url = new URL(cloudUrl);
      const actual = new WebSocket(`ws://127.0.0.1:${port}${url.pathname}${url.search}`);
      sockets.push(actual);
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

  async function token(): Promise<string> {
    const { memberToken } = await security.getMemberToken();
    if (!memberToken) throw new Error('device is unbound');
    return memberToken;
  }

  await local('/settings');
  await local('/shopping-lists?status=ACTIVE');
  return {
    name,
    database,
    engine,
    files,
    events,
    pushes,
    sockets,
    imageRequests,
    imageFailures,
    local,
    token,
    cleanup: target.cleanup,
  };
}

const shopping = `/shopping-lists/${SHOPPING_DEFAULT_LIST_ID}`;

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

function rejectedCodes(device: Device): string[] {
  return device.pushes.flatMap(({ body }) =>
    ((body?.rejected as { code: string }[] | undefined) ?? []).map(({ code }) => code),
  );
}

function authoritativeKeys(device: Device): string[] {
  return device.pushes.flatMap(({ body }) =>
    (
      (body?.rejected as
        { authoritative?: { entity: string; entityId: string }[] }[] | undefined) ?? []
    ).flatMap((rejection) =>
      (rejection.authoritative ?? []).map((unit) => `${unit.entity}:${unit.entityId}`),
    ),
  );
}

async function setupPair() {
  const runtime = await createCloud();
  const created: Device[] = [];
  const push = <T extends Device>(device: T): T => {
    created.push(device);
    return device;
  };
  harness = { runtime, devices: created };
  const owner = push(await createDevice(runtime, 'owner'));
  const member = push(await createDevice(runtime, 'member'));
  await owner.engine.initOwner(
    { bootstrapSecret: BOOTSTRAP_SECRET, nickname: '馆主' },
    { origin: ORIGIN },
  );
  const { inviteCode } = await invite(runtime, await owner.token());
  await member.engine.join({ inviteCode, nickname: '成员' }, { origin: ORIGIN });
  owner.engine.stop();
  member.engine.stop();
  return { runtime, owner, member };
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

describe('M3-3 收口联调', () => {
  it('未 pull 直接推送冲突排餐/旧版菜谱：权威外键闭包齐全，零外键死锁', async () => {
    const { owner, member } = await setupPair();

    // 馆主先建好菜谱（标签/工具）、食客，并排进同槽位计划。
    const ingredient = await owner.local<{ id: string; name: string }>('/ingredients', 'POST', {
      name: '收口五花肉',
      unit: 'GRAM',
      batches: [{ quantity: 1_000, unit: 'GRAM' }],
    });
    const recipe = await owner.local<{ id: string }>('/recipes', 'POST', {
      name: '收口红烧肉',
      tags: ['家常'],
      toolIds: [{ name: '炒锅' }],
    });
    const diner = await owner.local<{ id: string }>('/diners', 'POST', { name: '收口食客' });
    await owner.local('/plans', 'POST', {
      planDate: '2027-01-05',
      mealType: 'LUNCH',
      dinerCount: 1,
      title: '馆主排餐',
      items: [{ itemType: 'RECIPE', recipeId: recipe.id, mealRole: 'MAIN' }],
      dinerIds: [diner.id],
    });
    await owner.engine.syncOnce();
    await noOutbox(owner.database);

    // 成员尚未 pull 馆主的新菜谱/食客，就先在同一槽位新建自己的排餐 → 撞槽 409。
    await member.local('/plans', 'POST', {
      planDate: '2027-01-05',
      mealType: 'LUNCH',
      dinerCount: 1,
      title: '成员排餐',
      items: [{ itemType: 'CUSTOM', customName: '面条' }],
    });
    // 同批还有一个与冲突无关、仍有未确认操作的聚合：收敛不得覆盖它。
    const pendingDiner = await member.local<{ id: string }>('/diners', 'POST', {
      name: '成员未确认食客',
    });
    await member.engine.syncOnce();

    expect(rejectedCodes(member)).toEqual(['PLAN_SLOT_CONFLICT']);
    expect((await member.engine.status()).phase).toBe('ok');
    await noOutbox(member.database);
    expect(
      (await rows(member.database, 'Diner')).find((row) => row.id === pendingDiner.id),
    ).toMatchObject({ name: '成员未确认食客' });
    expect(
      (await rows(member.database, 'MealPlanItem')).map((row) => String(row.recipeId ?? '')),
    ).toContain(recipe.id);
    expect(
      (await rows(member.database, 'MealPlanDiner')).map((row) => String(row.dinerId ?? '')),
    ).toContain(diner.id);

    // 成员 pull 后再改旧版菜谱：馆主已把菜谱推进到 v2，并新增标签/工具/食材关联。
    await member.engine.pullNow();
    const pressure = await owner.local<{ id: string; name: string }>('/tools', 'POST', {
      name: '高压锅',
    });
    await owner.local(`/recipes/${recipe.id}`, 'PUT', {
      name: '收口红烧肉 v2',
      version: 1,
      tags: ['家常', '硬菜'],
      toolIds: [{ toolId: pressure.id, name: pressure.name }],
      ingredients: [
        { ingredientId: ingredient.id, name: ingredient.name, quantity: 200, unit: 'GRAM' },
      ],
    });
    await owner.engine.syncOnce();
    await noOutbox(owner.database);

    await member.local(`/recipes/${recipe.id}`, 'PUT', {
      name: '成员旧版红烧肉',
      version: 1,
    });
    await member.engine.syncOnce();

    expect(rejectedCodes(member)).toEqual(['PLAN_SLOT_CONFLICT', 'VERSION_CONFLICT']);
    expect((await member.engine.status()).phase).toBe('ok');
    await noOutbox(member.database);

    const tags = await rows(member.database, 'Tag');
    expect(tags.map((row) => String(row.name))).toEqual(expect.arrayContaining(['家常', '硬菜']));
    const tools = await rows(member.database, 'KitchenTool');
    expect(tools.map((row) => String(row.name))).toEqual(expect.arrayContaining(['高压锅']));
    expect(
      (await rows(member.database, 'RecipeIngredient')).filter((row) => row.recipeId === recipe.id),
    ).toHaveLength(1);
    expect(
      (await rows(member.database, 'Recipe')).find((row) => row.id === recipe.id),
    ).toMatchObject({ name: '收口红烧肉 v2', version: 2 });

    await member.engine.pullNow();
    await owner.engine.pullNow();
    await member.engine.pullNow();
    await noOutbox(owner.database);
    await noOutbox(member.database);
    await expectAligned(owner.database, member.database);
  }, 90_000);

  it('同根两步链 Op1 被拒：Op2 复活的 MealRecord 与入库 Ingredient 副根完整回滚', async () => {
    const { owner, member } = await setupPair();

    const plan = await owner.local<{ id: string }>('/plans', 'POST', {
      planDate: '2027-02-10',
      mealType: 'DINNER',
      dinerCount: 1,
      title: '收口链排餐',
      items: [{ itemType: 'CUSTOM', customName: '米饭' }],
    });
    await owner.engine.syncOnce();
    await member.engine.pullNow();
    await owner.local(`/plans/${plan.id}/complete`, 'POST', { version: 1 });
    await owner.engine.syncOnce();
    await member.engine.pullNow();
    await owner.local(`/plans/${plan.id}/uncomplete`, 'POST', { version: 2 });
    await owner.engine.syncOnce();
    await member.engine.pullNow();

    const record = (await rows(member.database, 'MealRecord')).find(
      (row) => row.sourceMealPlanId === plan.id,
    )!;
    expect(record.deletedAt).toBeTruthy();
    member.pushes.length = 0;

    // 成员离线：先改排餐（Op1），再完成（Op2 复活既有草稿记录）。
    await member.local(`/plans/${plan.id}`, 'PUT', {
      version: 3,
      title: '成员离线排餐',
    });
    await member.local(`/plans/${plan.id}/complete`, 'POST', { version: 4 });
    expect(
      (await rows(member.database, 'MealRecord')).find((row) => row.id === record.id)?.deletedAt,
    ).toBeNull();

    // 馆主抢先推进到 v4 上云；成员推送 Op1 冲突，Op2 随链丢弃。
    await owner.local(`/plans/${plan.id}`, 'PUT', {
      version: 3,
      title: '馆主权威排餐',
    });
    await owner.engine.syncOnce();
    await member.engine.syncOnce();

    expect(rejectedCodes(member)).toEqual(['VERSION_CONFLICT']);
    // 服务端必须把链上 Op2 触及的既有记录一起交回，端侧才能恢复软删状态。
    expect(authoritativeKeys(member)).toContain(`MealRecord:${record.id}`);
    expect((await member.engine.status()).phase).toBe('ok');
    await noOutbox(member.database);
    const restoredRecord = (await rows(member.database, 'MealRecord')).find(
      (row) => row.id === record.id,
    )!;
    expect(restoredRecord).toMatchObject({ deletedAt: expect.any(String), version: 2 });
    expect(
      (await rows(member.database, 'MealPlan')).find((row) => row.id === plan.id),
    ).toMatchObject({ status: 'PLANNED', version: 4, title: '馆主权威排餐' });

    // 连续 SHOPPING_CHECKIN：Op1 因既有食材版本落后被拒，Op2 入库的既有食材必须一并回滚。
    const first = await owner.local<{ id: string; name: string }>('/ingredients', 'POST', {
      name: '收口面粉',
      unit: 'GRAM',
      batches: [{ quantity: 1_000, unit: 'GRAM' }],
    });
    const second = await owner.local<{ id: string; name: string }>('/ingredients', 'POST', {
      name: '收口白糖',
      unit: 'GRAM',
      batches: [{ quantity: 500, unit: 'GRAM' }],
    });
    await owner.engine.syncOnce();
    await member.engine.pullNow();
    await owner.local(`/ingredients/${first.id}/consume`, 'POST', {
      mode: 'QUANTITY',
      quantity: 400,
      unit: 'GRAM',
      ingredientVersion: 1,
    });
    await owner.engine.syncOnce();
    await noOutbox(owner.database);
    member.pushes.length = 0;

    let list: { version: number; items?: { id: string; ingredientName: string }[] } =
      await member.local<{ version: number }>(shopping);
    await member.local(`${shopping}/items`, 'POST', {
      version: list.version,
      ingredientId: first.id,
      ingredientName: first.name,
      quantity: 100,
      unit: 'GRAM',
    });
    list = await member.local<{ version: number; items: { id: string; ingredientName: string }[] }>(
      shopping,
    );
    const itemOne = list.items!.find((item) => item.ingredientName === first.name)!;
    await member.local(`${shopping}/items`, 'POST', {
      version: list.version,
      ingredientId: second.id,
      ingredientName: second.name,
      quantity: 100,
      unit: 'GRAM',
    });
    list = await member.local<{ version: number; items: { id: string; ingredientName: string }[] }>(
      shopping,
    );
    const itemTwo = list.items!.find((item) => item.ingredientName === second.name)!;
    await member.local(`${shopping}/check-in`, 'POST', {
      version: list.version,
      operationId: 'm3-3-chain-checkin-1',
      itemIds: [itemOne.id],
    });
    list = await member.local<{ version: number }>(shopping);
    await member.local(`${shopping}/check-in`, 'POST', {
      version: list.version,
      operationId: 'm3-3-chain-checkin-2',
      itemIds: [itemTwo.id],
    });

    await member.engine.syncOnce();

    expect(rejectedCodes(member)).toEqual(['VERSION_CONFLICT']);
    expect(authoritativeKeys(member)).toEqual(
      expect.arrayContaining([`Ingredient:${first.id}`, `Ingredient:${second.id}`]),
    );
    expect((await member.engine.status()).phase).toBe('ok');
    await noOutbox(member.database);
    expect(
      (await rows(member.database, 'Ingredient')).filter((row) => row.id === first.id),
    ).toEqual((await rows(owner.database, 'Ingredient')).filter((row) => row.id === first.id));
    expect(
      (await rows(member.database, 'Ingredient')).filter((row) => row.id === second.id),
    ).toEqual((await rows(owner.database, 'Ingredient')).filter((row) => row.id === second.id));
    expect(
      (await rows(member.database, 'ShoppingListItem')).map((row) => String(row.id)).sort(),
    ).toEqual([itemOne.id, itemTwo.id].sort());
    expect(await rows(member.database, 'InventoryBatch')).toEqual(
      await rows(owner.database, 'InventoryBatch'),
    );

    await member.engine.pullNow();
    await owner.engine.pullNow();
    await member.engine.pullNow();
    await expectAligned(owner.database, member.database);
  }, 120_000);

  it('在线删除 + 入库移除后，另一端离线 3 步修改：已删/已入库条目零复活', async () => {
    const { owner, member } = await setupPair();

    const add = async (name: string) => {
      const list = await owner.local<{ version: number }>(shopping);
      await owner.local(`${shopping}/items`, 'POST', {
        version: list.version,
        ingredientName: name,
        quantity: 2,
        unit: 'PIECE',
      });
      const updated = await owner.local<{ items: { id: string; ingredientName: string }[] }>(
        shopping,
      );
      return updated.items.find((item) => item.ingredientName === name)!;
    };
    const gone = await add('收口已删');
    const checkedIn = await add('收口已入库');
    const kept = await add('收口保留');
    await owner.engine.syncOnce();
    await noOutbox(owner.database);
    await member.engine.pullNow();
    expect(await rows(member.database, 'ShoppingListItem')).toHaveLength(3);

    // 馆主在线删除 gone，并把 checkedIn 入库移除；成员此刻不 pull。
    const beforeDelete = await owner.local<{ version: number }>(shopping);
    await owner.local(`/shopping-list-items/${gone.id}?version=${beforeDelete.version}`, 'DELETE');
    const beforeCheckin = await owner.local<{ version: number }>(shopping);
    await owner.local(`${shopping}/check-in`, 'POST', {
      version: beforeCheckin.version,
      operationId: 'm3-3-online-checkin',
      itemIds: [checkedIn.id],
    });
    await owner.engine.syncOnce();
    await noOutbox(owner.database);
    expect((await rows(owner.database, 'ShoppingListItem')).map((row) => String(row.id))).toEqual([
      kept.id,
    ]);

    // 成员基于陈旧本地状态连续 3 步（新增 A、改 kept、新增 B）+ 第 4 步再改 A。
    let list: { version: number; items?: { id: string; ingredientName: string }[] } =
      await member.local<{ version: number }>(shopping);
    await member.local(`${shopping}/items`, 'POST', {
      version: list.version,
      ingredientName: '成员新增 A',
    });
    list = await member.local<{ version: number; items: { id: string; ingredientName: string }[] }>(
      shopping,
    );
    const addedA = list.items!.find((item) => item.ingredientName === '成员新增 A')!;
    await member.local(`/shopping-list-items/${kept.id}`, 'PUT', {
      version: list.version,
      quantity: 7,
      unit: 'PIECE',
    });
    // 删项：新增临时条目后在同一条离线链里删掉，验证删除意图不会被墓碑误伤。
    list = await member.local<{ version: number }>(shopping);
    await member.local(`${shopping}/items`, 'POST', {
      version: list.version,
      ingredientName: '成员临时项',
    });
    list = await member.local<{ version: number; items: { id: string; ingredientName: string }[] }>(
      shopping,
    );
    const temporary = list.items!.find((item) => item.ingredientName === '成员临时项')!;
    await member.local(`/shopping-list-items/${temporary.id}?version=${list.version}`, 'DELETE');
    list = await member.local<{ version: number }>(shopping);
    await member.local(`${shopping}/items`, 'POST', {
      version: list.version,
      ingredientName: '成员新增 B',
    });
    list = await member.local<{ version: number; items: { id: string; ingredientName: string }[] }>(
      shopping,
    );
    const addedB = list.items!.find((item) => item.ingredientName === '成员新增 B')!;
    await member.local(`/shopping-list-items/${addedA.id}`, 'PUT', {
      version: list.version,
      quantity: 9,
      unit: 'PIECE',
    });
    expect(await member.database.query('SELECT opId FROM sync_outbox ORDER BY rowid')).toHaveLength(
      6,
    );

    await member.engine.syncOnce();

    expect((await member.engine.status()).phase).toBe('ok');
    await noOutbox(member.database);
    const memberItems = await rows(member.database, 'ShoppingListItem');
    expect(memberItems.map((row) => String(row.id)).sort()).toEqual(
      [kept.id, addedA.id, addedB.id].sort(),
    );
    expect(memberItems.find((row) => row.id === gone.id)).toBeUndefined();
    expect(memberItems.find((row) => row.id === checkedIn.id)).toBeUndefined();
    expect(memberItems.find((row) => row.id === temporary.id)).toBeUndefined();
    expect(memberItems.find((row) => row.id === kept.id)).toMatchObject({ quantity: 7 });
    expect(memberItems.find((row) => row.id === addedA.id)).toMatchObject({ quantity: 9 });

    await owner.engine.pullNow();
    await member.engine.pullNow();
    await noOutbox(owner.database);
    await expectAligned(owner.database, member.database);
  }, 90_000);

  it('增量图片遇瞬时 503：单轮不紧循环丢弃，恢复后补齐主图与缩略图', async () => {
    const { owner, member } = await setupPair();

    const main = new TextEncoder().encode('RIFF\0WEBP\0m3-3-main-image');
    const thumb = new TextEncoder().encode('RIFF\0WEBP\0m3-3-thumb-image');
    const asset = {
      sha256: sha256(main),
      storagePath: 'm3-3-main.webp',
      thumbnailPath: 'm3-3-thumb.webp',
    };
    await owner.files.writeFile({ path: asset.storagePath, data: main });
    await owner.files.writeFile({ path: asset.thumbnailPath, data: thumb });
    const stamp = new Date().toISOString();
    await owner.database.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO "UploadAsset"
           ("id","filename","storagePath","thumbnailPath","mimeType","sizeBytes","sha256","createdAt","updatedAt")
         VALUES (?, ?, ?, ?, 'image/webp', ?, ?, ?, ?)`,
        [
          'm3-3-photo',
          asset.storagePath,
          asset.storagePath,
          asset.thumbnailPath,
          main.byteLength,
          asset.sha256,
          stamp,
          stamp,
        ],
      );
      await tx.enqueue({
        opId: 'm3-3-photo-upload',
        entity: 'UploadAsset',
        entityId: 'm3-3-photo',
        kind: 'upsert',
        baseVersion: null,
        payload: {
          id: 'm3-3-photo',
          filename: asset.storagePath,
          storagePath: asset.storagePath,
          thumbnailPath: asset.thumbnailPath,
          mimeType: 'image/webp',
          sizeBytes: main.byteLength,
          sha256: asset.sha256,
          width: null,
          height: null,
          recipeId: null,
          storeId: null,
          mealRecordId: null,
          deletedAt: null,
          createdAt: stamp,
          updatedAt: stamp,
        },
      });
    });
    await owner.engine.syncOnce();
    await noOutbox(owner.database);

    member.imageFailures.remaining = 2;
    await member.engine.syncOnce();
    // 主图 + 缩略图各只尝试一次：不得零延迟紧循环刷满重试上限。
    expect(member.imageRequests).toHaveLength(2);
    expect(member.imageRequests.every(({ status }) => status === 503)).toBe(true);
    expect((await member.engine.status()).phase).toBe('ok');
    expect((await member.files.statFile({ path: asset.storagePath })).exists).toBe(false);

    // 网络恢复：退避定时器或下一次同步补齐。
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await member.engine.syncOnce();

    const downloadedMain = await member.files.readFile({ path: asset.storagePath });
    expect(downloadedMain.data).not.toBeNull();
    expect(downloadedMain.data).toEqual(main);
    expect(sha256(downloadedMain.data!)).toBe(asset.sha256);
    expect((await member.files.readFile({ path: asset.thumbnailPath })).data).toEqual(thumb);
    expect(member.imageRequests.filter(({ status }) => status === 200)).toHaveLength(2);
    expect(member.imageRequests.length).toBeLessThanOrEqual(4);
    await noOutbox(member.database);
    await expectAligned(owner.database, member.database);
  }, 90_000);
});
