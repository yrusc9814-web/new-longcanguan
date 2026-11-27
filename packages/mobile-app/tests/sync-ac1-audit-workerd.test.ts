/**
 * AC1③ 独立审计补充：真实 workerd + 双端独立 SQLite 文件端到端闭环。
 *
 * 审计指出下列五类只被 DO 层单测覆盖，缺少「端侧 SQLite 本地写入 → 推送 →
 * 云端重放 → 另一端拉取落库」的真实链路证据：
 *
 * 1. 软删 `Ingredient` 时其 `InventoryBatch` 必须同语义级联软删（无幽灵批次）。
 * 2. `SHOPPING_CHECKIN` 空库存换单位：端侧先对齐基础单位再重算汇总，云端重放同口径，
 *    数量不能丢、单位不能被回退。
 * 3. `PLAN_COMPLETE` 复活软删草稿时必须删除旧 `MealRecordItem`/`MealRecordDiner`，
 *    否则他端残留幽灵子行。
 * 4. `PLAN_UNCOMPLETE` 撞上已 `CONFIRMED` 的记录必须被服务端拒绝并整链回滚，
 *    不得误删已确认记录。
 * 5. 排餐更新载荷内嵌的 `DinerDto` 不得覆盖其它端已推进的 `Diner` 主表字段与版本。
 *
 * 每个用例结束时断言 27 张同步表逐列一致，并校验发件箱清零。
 */
import { SHOPPING_DEFAULT_LIST_ID, SYNC_SNAPSHOT_TABLES } from '@dafan/shared/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

interface Device {
  readonly name: string;
  readonly database: DatabaseHandle;
  readonly engine: ReturnType<typeof createSyncEngine>;
  readonly pushes: PushRecord[];
  readonly actualSockets: WebSocket[];
  local<T>(path: string, method?: string, body?: unknown): Promise<T>;
  token(): Promise<string>;
  cleanup(): void;
}

let runtime: WorkerdHarness;
let owner: Device;
let member: Device;

const shopping = `/shopping-lists/${SHOPPING_DEFAULT_LIST_ID}`;

async function makeDevice(name: string): Promise<Device> {
  const target = createTempDatabasePath(`ac1-audit-${name}`);
  const database = await openDatabase({
    driver: createNodeSqliteDriver({ path: target.path }),
  });
  const security = createMemoryAppSecurity();
  const files = createMemoryUploadsFiles();
  const pushes: PushRecord[] = [];
  const actualSockets: WebSocket[] = [];
  const { port } = new URL((await runtime.mf.ready).href);
  const engine = createSyncEngine({
    getDatabase: async () => database,
    security,
    files,
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
      actualSockets.push(actual);
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
    pushes,
    actualSockets,
    local,
    token,
    cleanup: target.cleanup,
  };
}

async function rows(database: DatabaseHandle, table: string) {
  return database.query<Record<string, unknown>>(`SELECT * FROM "${table}" ORDER BY "id"`);
}

async function noOutbox(database: DatabaseHandle) {
  expect(await database.query('SELECT opId FROM sync_outbox')).toEqual([]);
}

/** 27 张同步表逐列一致（含软删行、子行与操作日志）。 */
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

beforeAll(async () => {
  runtime = await startWorkerd(
    new URL('../../cloud-worker/test/workerd-entry.ts', import.meta.url),
    { bindings: { OWNER_BOOTSTRAP_SECRET: BOOTSTRAP_SECRET } },
  );
  owner = await makeDevice('owner');
  await owner.engine.initOwner(
    { bootstrapSecret: BOOTSTRAP_SECRET, nickname: '馆主' },
    { origin: ORIGIN },
  );
  member = await makeDevice('member');
  const { inviteCode } = await invite(runtime, await owner.token());
  await member.engine.join({ inviteCode, nickname: '成员' }, { origin: ORIGIN });
  // 关闭自动长连与后台循环：每个用例显式 syncOnce/pullNow，避免并发轮次干扰断言。
  owner.engine.stop();
  member.engine.stop();
}, 120_000);

afterAll(async () => {
  for (const device of [owner, member]) device?.engine.stop();
  try {
    await Promise.all(
      [owner, member].flatMap(
        (device) =>
          device?.actualSockets.map(async (socket) => {
            if (socket.readyState === WebSocket.CLOSED) return;
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error('WebSocket did not close before dispose')),
                10_000,
              );
              socket.addEventListener(
                'close',
                () => {
                  clearTimeout(timeout);
                  resolve();
                },
                { once: true },
              );
              try {
                socket.close();
              } catch {
                // 关闭已终止的连接会抛错，忽略即可交给上面的超时兜底。
              }
            });
          }) ?? [],
      ),
    );
  } finally {
    for (const device of [owner, member]) {
      await device?.database.close();
      device?.cleanup();
    }
    await runtime?.dispose();
  }
}, 60_000);

describe('AC1③ 端云重放补充审计', () => {
  it('同步表清单为 27 张，作为本套件的对齐基线', () => {
    expect(SYNC_SNAPSHOT_TABLES).toHaveLength(27);
  });

  it('软删含批次的 Ingredient：两端级联软删批次且逐列一致', async () => {
    const flour = await owner.local<{ id: string }>('/ingredients', 'POST', {
      name: '审计面粉',
      unit: 'GRAM',
      batches: [
        { quantity: 600, unit: 'GRAM' },
        { quantity: 400, unit: 'GRAM' },
      ],
    });
    await owner.engine.syncOnce();
    await member.engine.pullNow();
    expect(await rows(member.database, 'InventoryBatch')).toHaveLength(2);

    await owner.local(`/ingredients/${flour.id}?version=1`, 'DELETE');
    await owner.engine.syncOnce();
    await member.engine.pullNow();

    const ingredient = (await rows(owner.database, 'Ingredient')).find(
      (row) => row.id === flour.id,
    );
    expect(ingredient).toMatchObject({ version: 2 });
    expect(ingredient?.deletedAt).toBeTruthy();
    const batches = (await rows(owner.database, 'InventoryBatch')).filter(
      (row) => row.ingredientId === flour.id,
    );
    expect(batches).toHaveLength(2);
    expect(batches.every((row) => Boolean(row.deletedAt) && row.version === 2)).toBe(true);
    // 另一端拉取后不得残留任何活批次（幽灵库存）。
    const memberBatches = (await rows(member.database, 'InventoryBatch')).filter(
      (row) => row.ingredientId === flour.id,
    );
    expect(memberBatches.map((row) => row.deletedAt).filter((value) => value === null)).toEqual([]);
    await noOutbox(owner.database);
    await noOutbox(member.database);
    await expectAligned(owner.database, member.database);
  }, 60_000);

  it('SHOPPING_CHECKIN 空库存换单位：两端基础单位与汇总数量一致', async () => {
    // 空库存（quantity 0、无批次）且基础单位为 GRAM，入库条目用不可换算的 PIECE。
    await owner.local('/ingredients', 'POST', { name: '审计换单位面粉', unit: 'GRAM' });
    await owner.engine.syncOnce();
    await member.engine.pullNow();

    const { version } = await owner.local<{ version: number }>(shopping);
    const list = await owner.local<{
      version: number;
      items: { id: string; ingredientName: string }[];
    }>(shopping);
    await owner.local(`${shopping}/items`, 'POST', {
      version,
      ingredientName: '审计换单位面粉',
      quantity: 3,
      unit: 'PIECE',
    });
    const withItem = await owner.local<{
      version: number;
      items: { id: string; ingredientName: string }[];
    }>(shopping);
    expect(withItem.version).toBe(list.version + 1);
    const item = withItem.items.find(({ ingredientName }) => ingredientName === '审计换单位面粉')!;

    await owner.local(`${shopping}/check-in`, 'POST', {
      version: withItem.version,
      operationId: 'ac1-audit-unit-reset',
      itemIds: [item.id],
    });
    const localIngredient = (await rows(owner.database, 'Ingredient')).find(
      ({ name }) => name === '审计换单位面粉',
    );
    expect(localIngredient).toMatchObject({ unit: 'PIECE', quantity: 3, version: 2 });

    await owner.engine.syncOnce();
    await member.engine.pullNow();

    const remoteIngredient = (await rows(member.database, 'Ingredient')).find(
      ({ name }) => name === '审计换单位面粉',
    );
    // 云端重放必须同口径换单位并重算汇总，不能把数量记成 0 或退回 GRAM。
    expect(remoteIngredient).toMatchObject({ unit: 'PIECE', quantity: 3, version: 2 });
    expect(
      (await rows(member.database, 'InventoryBatch')).filter(
        (row) => row.ingredientId === remoteIngredient?.id,
      ),
    ).toMatchObject([{ quantity: 3, unit: 'PIECE', deletedAt: null }]);
    expect(await rows(member.database, 'ShoppingCheckinOperation')).toMatchObject([
      { id: 'ac1-audit-unit-reset' },
    ]);
    await noOutbox(owner.database);
    await noOutbox(member.database);
    await expectAligned(owner.database, member.database);
  }, 60_000);

  it('PLAN_COMPLETE 复活草稿：两端删除旧子行、不残留幽灵条目与就餐人', async () => {
    const diner = await owner.local<{ id: string }>('/diners', 'POST', { name: '审计食客' });
    const plan = await owner.local<{ id: string }>('/plans', 'POST', {
      planDate: '2026-12-20',
      mealType: 'LUNCH',
      dinerCount: 2,
      title: '审计复活排餐',
      items: [
        { itemType: 'CUSTOM', customName: '米饭' },
        { itemType: 'CUSTOM', customName: '青菜' },
      ],
      dinerIds: [diner.id],
    });
    await owner.engine.syncOnce();
    await member.engine.pullNow();

    await owner.local(`/plans/${plan.id}/complete`, 'POST', { version: 1 });
    await owner.engine.syncOnce();
    await member.engine.pullNow();
    const completed = (await rows(owner.database, 'MealRecord')).find(
      (row) => row.sourceMealPlanId === plan.id && row.deletedAt === null,
    );
    expect(completed).toBeTruthy();
    const recordId = String(completed!.id);
    const oldItemIds = (await rows(owner.database, 'MealRecordItem'))
      .filter((row) => row.mealRecordId === recordId)
      .map((row) => String(row.id));
    expect(oldItemIds).toHaveLength(2);

    await owner.local(`/plans/${plan.id}/uncomplete`, 'POST', { version: 2 });
    await owner.engine.syncOnce();
    await member.engine.pullNow();
    expect(
      (await rows(member.database, 'MealRecord')).find((row) => row.id === recordId)?.deletedAt,
    ).toBeTruthy();

    // 撤销后改计划内容再完成：复活路径必须删掉旧草稿子行后按新计划重建。
    await owner.local(`/plans/${plan.id}`, 'PUT', {
      version: 3,
      items: [{ itemType: 'CUSTOM', customName: '汤面' }],
    });
    await owner.local(`/plans/${plan.id}/complete`, 'POST', { version: 4 });
    await owner.engine.syncOnce();
    await member.engine.pullNow();

    const revived = (await rows(owner.database, 'MealRecord')).find((row) => row.id === recordId)!;
    expect(revived).toMatchObject({ status: 'DRAFT', deletedAt: null, sourceMealPlanId: plan.id });
    const items = (await rows(owner.database, 'MealRecordItem')).filter(
      (row) => row.mealRecordId === recordId,
    );
    expect(items).toMatchObject([{ itemType: 'CUSTOM', customName: '汤面' }]);
    expect(items.map((row) => String(row.id))).not.toEqual(expect.arrayContaining(oldItemIds));
    expect(
      (await rows(owner.database, 'MealRecordDiner')).filter(
        (row) => row.mealRecordId === recordId,
      ),
    ).toHaveLength(1);
    // 另一端：旧子行已被显式删除，不存在幽灵条目。
    expect(
      (await rows(member.database, 'MealRecordItem')).filter(
        (row) => row.mealRecordId === recordId,
      ),
    ).toMatchObject([{ itemType: 'CUSTOM', customName: '汤面' }]);
    expect(
      (await rows(member.database, 'MealRecordItem')).some((row) =>
        oldItemIds.includes(String(row.id)),
      ),
    ).toBe(false);
    await noOutbox(owner.database);
    await noOutbox(member.database);
    await expectAligned(owner.database, member.database);
  }, 60_000);

  it('PLAN_UNCOMPLETE 撞上已 CONFIRMED 记录：服务端拒绝、整链回滚且不误删记录', async () => {
    const plan = await owner.local<{ id: string }>('/plans', 'POST', {
      planDate: '2026-12-22',
      mealType: 'DINNER',
      dinerCount: 1,
      title: '审计撤销排餐',
      items: [{ itemType: 'CUSTOM', customName: '饺子' }],
    });
    await owner.engine.syncOnce();
    await member.engine.pullNow();

    await owner.local(`/plans/${plan.id}/complete`, 'POST', { version: 1 });
    await owner.engine.syncOnce();
    await member.engine.pullNow();
    const record = (await rows(member.database, 'MealRecord')).find(
      (row) => row.sourceMealPlanId === plan.id && row.deletedAt === null,
    )!;
    expect(record).toMatchObject({ status: 'DRAFT', version: 1 });

    // 成员离线先撤销完成（本地记录仍是未编辑草稿，允许软删）。
    await member.local(`/plans/${plan.id}/uncomplete`, 'POST', { version: 2 });
    expect(
      (await rows(member.database, 'MealRecord')).find((row) => row.id === record.id)?.deletedAt,
    ).toBeTruthy();

    // 馆主同时确认该记录并先上云。
    await owner.local(`/records/${record.id}/confirm`, 'POST', { version: 1 });
    await owner.engine.syncOnce();
    await noOutbox(owner.database);

    // 成员推送撤销 → 服务端拒绝，并把权威计划/记录回灌本地。
    await member.engine.syncOnce();
    expect(rejectedCodes(member)).toEqual(['VERSION_CONFLICT']);
    expect(member.pushes.at(-1)?.status).toBe(409);

    const restored = (await rows(member.database, 'MealRecord')).find(
      (row) => row.id === record.id,
    )!;
    expect(restored).toMatchObject({ status: 'CONFIRMED', version: 2, deletedAt: null });
    expect(restored.planUncompleteProof ?? null).toBeNull();
    expect(
      (await rows(member.database, 'MealPlan')).find((row) => row.id === plan.id),
    ).toMatchObject({ status: 'COMPLETED', version: 2 });
    expect(
      (await rows(member.database, 'MealRecordItem')).filter(
        (row) => row.mealRecordId === record.id,
      ),
    ).toHaveLength(1);

    await owner.engine.pullNow();
    await member.engine.pullNow();
    await noOutbox(member.database);
    expect((await member.engine.status()).phase).toBe('ok');
    await expectAligned(owner.database, member.database);
  }, 60_000);

  it('排餐更新载荷内嵌的 Diner 不覆盖其它端已推进的 Diner 版本', async () => {
    const diner = await owner.local<{ id: string; version: number }>('/diners', 'POST', {
      name: '审计食客二',
    });
    const plan = await owner.local<{ id: string }>('/plans', 'POST', {
      planDate: '2026-12-24',
      mealType: 'LUNCH',
      dinerCount: 2,
      title: '审计排餐',
      items: [{ itemType: 'CUSTOM', customName: '炒饭' }],
      dinerIds: [diner.id],
    });
    await owner.engine.syncOnce();
    await member.engine.pullNow();

    // 成员先把 Diner 改名推进到 v2 并上云；馆主仍持有 v1 的排餐快照。
    await member.local(`/diners/${diner.id}`, 'PUT', { name: '审计食客二改', version: 1 });
    await member.engine.syncOnce();
    await noOutbox(member.database);

    // 馆主随后更新排餐（载荷内嵌 v1 的 DinerDto）并推送。
    await owner.local(`/plans/${plan.id}`, 'PUT', { version: 1, title: '审计排餐改' });
    await owner.engine.syncOnce();
    expect(rejectedCodes(owner)).toEqual([]);

    await owner.engine.pullNow();
    await member.engine.pullNow();

    const remoteDiner = (await rows(member.database, 'Diner')).find((row) => row.id === diner.id);
    expect(remoteDiner).toMatchObject({ name: '审计食客二改', version: 2 });
    expect((await rows(owner.database, 'Diner')).find((row) => row.id === diner.id)).toMatchObject({
      name: '审计食客二改',
      version: 2,
    });
    expect(
      (await rows(owner.database, 'MealPlan')).find((row) => row.id === plan.id),
    ).toMatchObject({ title: '审计排餐改', version: 2 });
    await noOutbox(owner.database);
    await noOutbox(member.database);
    await expectAligned(owner.database, member.database);
  }, 60_000);
});
