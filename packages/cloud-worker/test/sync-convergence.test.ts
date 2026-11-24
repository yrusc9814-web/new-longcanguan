/**
 * 云端重放收敛的 HTTP 级验证：
 * - 冲突 409 响应直接携带被拒聚合根的权威行（含胜出计划与子行）；
 * - `epoch-reset` 整库替换后清理失去引用的 R2 对象。
 */

import { HOUSEHOLD_EPOCH_HEADER } from '@dafan/shared/sync';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  auth,
  BOOTSTRAP_SECRET,
  bucketKeys,
  bytes,
  call,
  initOwner,
  resetHousehold,
  snapshot,
  upload,
  type Binding,
} from './household-support';
import { startWorkerd, type WorkerdHarness } from './run-workerd';

let runtime: WorkerdHarness;
let owner: Binding;

const TS = '2026-11-21T08:00:00.000Z';

beforeAll(async () => {
  runtime = await startWorkerd(new URL('./workerd-entry.ts', import.meta.url), {
    bindings: { OWNER_BOOTSTRAP_SECRET: BOOTSTRAP_SECRET },
  });
}, 60_000);

afterAll(async () => {
  await runtime?.dispose();
});

beforeEach(async () => {
  await resetHousehold(runtime);
  owner = await initOwner(runtime);
});

function push(operations: unknown[]): Promise<Response> {
  return call(runtime, '/api/sync/push', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...auth(owner.token),
      [HOUSEHOLD_EPOCH_HEADER]: String(owner.epoch),
    },
    body: JSON.stringify({ deviceId: 'device-a', operations }),
  });
}

function plan(id: string, items: unknown[] = []): Record<string, unknown> {
  return {
    id,
    planDate: '2026-11-21',
    mealType: 'DINNER',
    dinerCount: 1,
    status: 'PLANNED',
    notes: null,
    time: null,
    title: null,
    subtext: null,
    icon: null,
    version: 1,
    completedAt: null,
    deletedAt: null,
    createdAt: TS,
    updatedAt: TS,
    items,
    diners: [],
  };
}

function planItem(id: string, planId: string): Record<string, unknown> {
  return {
    id,
    mealPlanId: planId,
    itemType: 'CUSTOM',
    mealRole: 'MAIN',
    recipeId: null,
    storeId: null,
    customName: '番茄炒蛋',
    sortOrder: 0,
    createdAt: TS,
    updatedAt: TS,
  };
}

describe('push 冲突响应携带权威聚合行', () => {
  it('PLAN_SLOT_CONFLICT：被拒根为空、胜出计划带完整条目', async () => {
    const accepted = await push([
      {
        id: 'op-plan-a',
        entity: 'MealPlan',
        entityId: 'plan-a',
        kind: 'upsert',
        baseVersion: null,
        payload: plan('plan-a', [planItem('mpi-a', 'plan-a')]),
      },
    ]);
    expect(accepted.status).toBe(200);

    const response = await push([
      {
        id: 'op-plan-b',
        entity: 'MealPlan',
        entityId: 'plan-b',
        kind: 'upsert',
        baseVersion: null,
        payload: plan('plan-b'),
      },
    ]);
    const body = (await response.json()) as {
      rejected: {
        code: string;
        authoritative?: {
          entity: string;
          entityId: string;
          rows: { table: string; id: unknown }[];
        }[];
      }[];
    };
    expect(response.status).toBe(409);
    expect(body.rejected[0]?.code).toBe('PLAN_SLOT_CONFLICT');
    const units = body.rejected[0]?.authoritative ?? [];
    expect(units.map((unit) => `${unit.entity}:${unit.entityId}`)).toEqual([
      'MealPlan:plan-b',
      'MealPlan:plan-a',
    ]);
    expect(units[0]?.rows).toEqual([]);
    expect(units[1]?.rows.map((change) => `${change.table}:${String(change.id)}`)).toEqual([
      'MealPlan:plan-a',
      'MealPlanItem:mpi-a',
    ]);
    // 整批回滚：被拒计划不落地，胜出计划保持原样。
    const logged = (await snapshot(runtime)).syncLog.map((entry) => entry.entity_id);
    expect(logged).toContain('plan-a');
    expect(logged).not.toContain('plan-b');
  });

  it('VERSION_CONFLICT：回传服务端当前行', async () => {
    const day = { planDate: '2026-11-23' };
    const first = await push([
      {
        id: 'op-plan-1',
        entity: 'MealPlan',
        entityId: 'plan-1',
        kind: 'upsert',
        baseVersion: null,
        payload: { ...plan('plan-1'), ...day },
      },
    ]);
    expect(first.status, await first.clone().text()).toBe(200);
    const second = await push([
      {
        id: 'op-plan-2',
        entity: 'MealPlan',
        entityId: 'plan-1',
        kind: 'upsert',
        baseVersion: 1,
        payload: { ...plan('plan-1', [planItem('mpi-1', 'plan-1')]), ...day },
      },
    ]);
    expect(second.status, await second.clone().text()).toBe(200);
    const response = await push([
      {
        id: 'op-plan-3',
        entity: 'MealPlan',
        entityId: 'plan-1',
        kind: 'upsert',
        baseVersion: 1,
        payload: { ...plan('plan-1'), ...day },
      },
    ]);
    const body = JSON.parse(await response.text()) as {
      rejected: {
        code: string;
        authoritative?: {
          entityId: string;
          rows: { table: string; row: { id: string; version?: number } | null }[];
        }[];
      }[];
    };
    expect(response.status).toBe(409);
    expect(body.rejected[0]?.code).toBe('VERSION_CONFLICT');
    const units = body.rejected[0]?.authoritative ?? [];
    expect(units).toHaveLength(1);
    expect(units[0]?.entityId).toBe('plan-1');
    const rejectedRow = units[0]!.rows[0];
    expect(rejectedRow?.row).toMatchObject({ id: 'plan-1' });
    expect(units[0]?.rows.map((change) => change.row?.id)).toEqual(['plan-1', 'mpi-1']);
  });
});

describe('epoch-reset 清理 R2 孤儿对象', () => {
  it('整库替换后删除不再被引用的对象并清空 image_objects', async () => {
    const body = bytes('epoch-orphan');
    expect((await upload(runtime, owner.token, body)).status).toBe(204);
    expect(await bucketKeys(runtime)).toHaveLength(1);
    expect((await snapshot(runtime)).counts.images).toBe(1);

    const response = await call(runtime, '/api/sync/epoch-reset', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...auth(owner.token),
        [HOUSEHOLD_EPOCH_HEADER]: '1',
      },
      body: JSON.stringify({
        uploadId: 'upload-1',
        page: 0,
        finalize: true,
        rows: [
          {
            table: 'Settings',
            id: 1,
            row: {
              id: 1,
              appName: '搭饭小馆',
              subtitle: '让每一餐都更美好',
              defaultPort: 8787,
              autoBackupEnabled: 1,
              autoDeductInventory: 0,
              defaultRepeatDays: 0,
              version: 1,
              createdAt: TS,
              updatedAt: TS,
            },
          },
          {
            table: 'ShoppingList',
            id: 'shopping_list_active_default',
            row: {
              id: 'shopping_list_active_default',
              name: '购物清单',
              status: 'ACTIVE',
              notes: null,
              version: 1,
              deletedAt: null,
              createdAt: TS,
              updatedAt: TS,
            },
          },
        ],
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ epoch: 2, seq: 0, complete: true });
    expect((await snapshot(runtime)).counts.images).toBe(0);
    expect(await bucketKeys(runtime)).toEqual([]);
  });
});
