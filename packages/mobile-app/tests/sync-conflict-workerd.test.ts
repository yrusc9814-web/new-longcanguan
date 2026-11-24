/**
 * AC1④ 端侧联调（真实 workerd + 每台设备独立本地 SQLite）：
 *
 * 1. 先 `pull` 跳过未确认聚合、再 `push` 的多批次部分扣减冲突：整条操作链副作用回滚、
 *    云端权威批次/日志完整落库、发件箱清零、零幽灵；
 * 2. 既有排餐改期撞槽：不得删除本地既有排餐，必须回滚到服务端原槽位；
 * 3. 同批混合冲突：前序冲突使同批无冲突操作被 DO 事务一并回滚（`unresolved > 0`）时，
 *    收敛后继续推空剩余发件箱并置 `ok`。
 *
 * 每个用例使用独立的 workerd 实例与独立 SQLite 文件库，避免服务端残留互相污染。
 */
import { SYNC_SNAPSHOT_TABLES } from '@dafan/shared/sync';
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

interface Harness {
  readonly runtime: WorkerdHarness;
  readonly devices: Device[];
}

type Device = Awaited<ReturnType<typeof createDevice>>;

let harness: Harness | null = null;

afterEach(async () => {
  if (!harness) return;
  const current = harness;
  harness = null;
  for (const device of current.devices) device.engine.stop();
  for (const device of current.devices) {
    for (const socket of device.sockets) {
      if (socket.readyState === WebSocket.CLOSED) continue;
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        const timeout = setTimeout(done, 3_000);
        socket.addEventListener(
          'close',
          () => {
            clearTimeout(timeout);
            done();
          },
          { once: true },
        );
        socket.close(1000);
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
  const target = createTempDatabasePath(`conflict-${name}`);
  const database = await openDatabase({
    driver: createNodeSqliteDriver({ path: target.path }),
  });
  const security = createMemoryAppSecurity();
  const files = createMemoryUploadsFiles();
  const events: { name: string; detail: unknown }[] = [];
  const pushes: PushRecord[] = [];
  const sockets: WebSocket[] = [];
  const { port } = new URL((await runtime.mf.ready).href);
  const engine = createSyncEngine({
    getDatabase: async () => database,
    security,
    files,
    events: (type, detail) => events.push({ name: type, detail }),
    deviceId: () => name,
    snapshotPageSize: 2,
    fetch: async (input, init) => {
      const response = await runtime.dispatchFetch(input, init);
      if (new URL(input).pathname === '/api/sync/push') {
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
  // 端侧首次进购物页会补建默认清单；首绑上传前必须先存在，否则云端没有可合并的清单。
  await local('/shopping-lists?status=ACTIVE');
  return {
    name,
    database,
    engine,
    events,
    pushes,
    sockets,
    local,
    token,
    cleanup: target.cleanup,
  };
}

const shopping = '/shopping-lists/shopping_list_active_default';

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

/** 建立「馆主 + 成员」两台设备并完成首次同步。 */
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
  return { runtime, owner, member };
}

describe('AC1④ 端云冲突收敛联调', () => {
  it('先 pull 跳过多批次部分扣减后 push：整链回滚、权威批次与日志完整、发件箱清零', async () => {
    const { owner, member } = await setupPair();

    const flour = await owner.local<{ id: string }>('/ingredients', 'POST', {
      name: '联调面粉',
      unit: 'GRAM',
      batches: [
        { quantity: 2_000, unit: 'GRAM' },
        { quantity: 3_000, unit: 'GRAM' },
      ],
    });
    await owner.engine.syncOnce();
    await member.engine.pullNow();
    expect(await rows(member.database, 'Ingredient')).toMatchObject([
      { id: flour.id, quantity: 5_000 },
    ]);
    const logsBefore = (await rows(owner.database, 'InventoryLog')).length;
    expect(logsBefore).toBeGreaterThan(0);

    // 馆主先在另一台设备消耗 4500g：服务端只剩 500g（批次 1 归零、批次 2 扣 2500g）。
    await owner.local(`/ingredients/${flour.id}/consume`, 'POST', {
      mode: 'QUANTITY',
      quantity: 4_500,
      unit: 'GRAM',
      ingredientVersion: 1,
    });
    await owner.engine.syncOnce();
    expect(await rows(owner.database, 'Ingredient')).toMatchObject([{ quantity: 500 }]);
    expect(await rows(owner.database, 'InventoryLog')).toHaveLength(logsBefore + 2);
    const serverBatches = (await rows(owner.database, 'InventoryBatch'))
      .map((row) => Number(row.quantity))
      .sort((a, b) => a - b);
    expect(serverBatches).toEqual([0, 500]);

    // 成员离线连续两次扣减（第一次跨两个批次，共 5000g）：版本链 1 → 2。
    await member.local(`/ingredients/${flour.id}/consume`, 'POST', {
      mode: 'QUANTITY',
      quantity: 2_500,
      unit: 'GRAM',
      ingredientVersion: 1,
    });
    await member.local(`/ingredients/${flour.id}/consume`, 'POST', {
      mode: 'QUANTITY',
      quantity: 2_500,
      unit: 'GRAM',
      ingredientVersion: 2,
    });
    expect(await rows(member.database, 'Ingredient')).toMatchObject([{ quantity: 0 }]);
    const memberLogsBefore = (await rows(member.database, 'InventoryLog')).length;
    expect(memberLogsBefore).toBeGreaterThan(logsBefore);

    // 先 pull：本地该聚合有未确认操作 → 父行与批次/日志同进退跳过，本地仍是自己的扣减结果。
    await member.engine.pullNow();
    expect(await rows(member.database, 'Ingredient')).toMatchObject([{ quantity: 0 }]);
    expect(await rows(member.database, 'InventoryLog')).toHaveLength(memberLogsBefore);
    expect(
      (await rows(member.database, 'InventoryBatch')).map((row) => Number(row.quantity)),
    ).toEqual([0, 0]);

    // 再 push：版本已落后被拒（版本校验先于库存校验），整条操作链必须回滚并恢复权威状态。
    await member.engine.syncOnce();

    expect(rejectedCodes(member)).toEqual(['VERSION_CONFLICT']);
    const rejection = (
      member.pushes.find(({ status }) => status === 409)?.body?.rejected as {
        authoritative?: { entity: string; entityId: string }[];
      }[]
    )[0];
    expect(
      rejection?.authoritative?.map(({ entity, entityId }) => `${entity}:${entityId}`),
    ).toEqual(expect.arrayContaining([`Ingredient:${flour.id}`]));
    await noOutbox(member.database);
    expect((await member.engine.status()).phase).toBe('ok');

    expect(await rows(member.database, 'Ingredient')).toMatchObject([
      { quantity: 500, version: 2 },
    ]);
    for (const table of ['Ingredient', 'InventoryBatch', 'InventoryLog'] as const) {
      expect(await rows(member.database, table), table).toEqual(await rows(owner.database, table));
    }
    // 零幽灵：被拒的两条扣减没有留下任何日志或批次，只剩服务端那批。
    expect(await rows(member.database, 'InventoryLog')).toHaveLength(logsBefore + 2);
    expect(
      (await rows(member.database, 'InventoryBatch'))
        .map((row) => Number(row.quantity))
        .sort((a, b) => a - b),
    ).toEqual([0, 500]);
    await expectAligned(owner.database, member.database);
  }, 60_000);

  it('先 pull 遇到本地未确认的既有排餐改期撞槽：父行与其子行必须同进退跳过', async () => {
    const { owner, member } = await setupPair();

    const moved = await owner.local<{ id: string }>('/plans', 'POST', {
      planDate: '2026-12-10',
      mealType: 'LUNCH',
      dinerCount: 2,
      title: '原排餐',
      items: [{ itemType: 'CUSTOM', customName: '米饭' }],
    });
    await owner.engine.syncOnce();
    await member.engine.pullNow();

    // 成员离线把已同步的排餐改期到 12-12。
    await member.local(`/plans/${moved.id}`, 'PUT', {
      planDate: '2026-12-12',
      mealType: 'LUNCH',
      version: 1,
      items: [{ itemType: 'CUSTOM', customName: '米饭' }],
    });
    // 馆主同时在 12-12 新建排餐并先上云，形成同槽位冲突。
    await owner.local('/plans', 'POST', {
      planDate: '2026-12-12',
      mealType: 'LUNCH',
      dinerCount: 1,
      title: '馆主新排餐',
      items: [{ itemType: 'CUSTOM', customName: '饺子' }],
    });
    await owner.engine.syncOnce();

    // 本地该计划仍有未确认改期（baseVersion=1），云端胜出计划必须整聚合跳过：
    // 父行被 `clearPlanSlot` 跳过时，其 MealPlanItem 也不能单独落库。
    let pullError: unknown = null;
    try {
      await member.engine.pullNow();
    } catch (error) {
      pullError = error;
    }
    expect(
      pullError === null ? null : String(pullError),
      '父行与聚合子行必须同进退跳过，不能只跳过父行导致子行外键悬空',
    ).toBeNull();
    const plans = await rows(member.database, 'MealPlan');
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ id: moved.id, planDate: '2026-12-12', version: 2 });
    expect(await rows(member.database, 'MealPlanItem')).toHaveLength(1);
  }, 60_000);

  it('既有排餐改期撞槽 push：保留既有排餐并回滚到服务端原槽位，不误删', async () => {
    const { owner, member } = await setupPair();

    const moved = await owner.local<{ id: string }>('/plans', 'POST', {
      planDate: '2026-12-10',
      mealType: 'LUNCH',
      dinerCount: 2,
      title: '原排餐',
      items: [{ itemType: 'CUSTOM', customName: '米饭' }],
    });
    const untouched = await owner.local<{ id: string }>('/plans', 'POST', {
      planDate: '2026-12-11',
      mealType: 'LUNCH',
      dinerCount: 1,
      title: '另一天',
      items: [{ itemType: 'CUSTOM', customName: '面条' }],
    });
    await owner.engine.syncOnce();
    await member.engine.pullNow();
    expect(await rows(member.database, 'MealPlan')).toHaveLength(2);

    // 双方离线：成员把已同步的排餐改到 12-12；馆主在 12-12 新建排餐并先上云。
    await member.local(`/plans/${moved.id}`, 'PUT', {
      planDate: '2026-12-12',
      mealType: 'LUNCH',
      version: 1,
      items: [{ itemType: 'CUSTOM', customName: '米饭' }],
    });
    const winner = await owner.local<{ id: string }>('/plans', 'POST', {
      planDate: '2026-12-12',
      mealType: 'LUNCH',
      dinerCount: 1,
      title: '馆主新排餐',
      items: [{ itemType: 'CUSTOM', customName: '饺子' }],
    });
    await owner.engine.syncOnce();

    await member.engine.syncOnce();

    expect(rejectedCodes(member)).toEqual(['PLAN_SLOT_CONFLICT']);
    expect(
      member.events.find(({ name }) => name === 'dafan:sync:plan-slot-conflict')?.detail,
    ).toMatchObject({
      planId: moved.id,
      winner: { id: winner.id },
      removed: false,
    });

    const plans = await rows(member.database, 'MealPlan');
    expect(plans.map((row) => row.id).sort()).toEqual([moved.id, untouched.id, winner.id].sort());
    expect(plans.find((row) => row.id === moved.id)).toMatchObject({
      planDate: '2026-12-10',
      mealType: 'LUNCH',
      version: 1,
    });
    expect(plans.find((row) => row.id === winner.id)?.planDate).toBe('2026-12-12');
    expect(
      (await rows(member.database, 'MealPlanItem')).filter((row) => row.mealPlanId === moved.id),
    ).toHaveLength(1);
    await noOutbox(member.database);
    expect((await member.engine.status()).phase).toBe('ok');
    await expectAligned(owner.database, member.database);
  }, 60_000);

  it('同批混合冲突：前序冲突使同批无冲突操作一并回滚后，继续推空发件箱并最终 ok', async () => {
    const { owner, member } = await setupPair();

    const recipe = await owner.local<{ id: string }>('/recipes', 'POST', { name: '番茄汤' });
    await owner.engine.syncOnce();
    await member.engine.pullNow();
    expect(await rows(member.database, 'Recipe')).toMatchObject([
      { id: recipe.id, name: '番茄汤', version: 1 },
    ]);

    // 馆主先改菜谱上云（服务端 version 2）。
    await owner.local(`/recipes/${recipe.id}`, 'PUT', { name: '云端番茄汤', version: 1 });
    await owner.engine.syncOnce();

    // 成员离线先改同一菜谱（版本已落后），再建一个完全不冲突的食客：同批共 2 个操作。
    await member.local(`/recipes/${recipe.id}`, 'PUT', { name: '本地番茄汤', version: 1 });
    const diner = await member.local<{ id: string }>('/diners', 'POST', { name: '小明' });
    const pending = await member.database.query<{ opId: string; entity: string }>(
      'SELECT "opId","entity" FROM sync_outbox ORDER BY rowid',
    );
    expect(pending.map(({ entity }) => entity)).toEqual(['Recipe', 'Diner']);

    await member.engine.syncOnce();

    // 第一批：菜谱冲突 → DO 事务整批回滚，食客未被确认（acceptedOperationIds 为空）。
    const first = member.pushes[0]!;
    expect(first.operations).toHaveLength(2);
    expect(first.status).toBe(409);
    expect(first.body?.acceptedOperationIds).toEqual([]);
    expect(rejectedCodes(member)).toEqual(['VERSION_CONFLICT']);
    // 收敛后第二轮只重推未被拒绝的食客。
    const second = member.pushes[1]!;
    expect(second.operations).toEqual([pending[1]!.opId]);
    expect(second.status).toBe(200);

    expect(await rows(member.database, 'Recipe')).toMatchObject([
      { id: recipe.id, name: '云端番茄汤', version: 2 },
    ]);
    await noOutbox(member.database);
    expect((await member.engine.status()).phase).toBe('ok');

    // 服务端确实落库了该食客，且两端 27 表逐列一致。
    await owner.engine.pullNow();
    expect((await rows(owner.database, 'Diner')).find((row) => row.id === diner.id)).toMatchObject({
      name: '小明',
      version: 1,
    });
    await expectAligned(owner.database, member.database);
  }, 60_000);

  it('购物单冲突不阻塞其它实体：发件箱清零且不误删对方新增项', async () => {
    const { owner, member } = await setupPair();

    const { version } = await owner.local<{ version: number }>(shopping);
    await owner.local(`${shopping}/items`, 'POST', {
      version,
      ingredientName: '馆主买肉',
    });
    // 成员未 pull 就基于同一版本追加两项：同批出现清单聚合与无关食客。
    await member.local(`${shopping}/items`, 'POST', {
      version,
      ingredientName: '成员买菜',
    });
    const second = await member.local<{ version: number }>(shopping);
    await member.local(`${shopping}/items`, 'POST', {
      version: second.version,
      ingredientName: '成员买蛋',
    });
    await member.local('/diners', 'POST', { name: '小红' });

    await member.engine.pullNow();
    await member.engine.syncOnce();
    await owner.engine.syncOnce();
    await owner.engine.pullNow();
    await member.engine.pullNow();

    await noOutbox(owner.database);
    await noOutbox(member.database);
    await expectAligned(owner.database, member.database);
    const names = (await rows(member.database, 'ShoppingListItem')).map(
      (row) => row.ingredientNameSnapshot,
    );
    expect(names).toContain('馆主买肉');
    expect(names).toContain('成员买菜');
    expect(names).toContain('成员买蛋');
    expect(new Set(names).size).toBe(names.length);
  }, 60_000);
});
