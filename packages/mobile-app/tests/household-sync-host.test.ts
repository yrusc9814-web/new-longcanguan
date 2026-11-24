import { describe, expect, it, vi } from 'vitest';

import type { SyncStatusSnapshot } from '../src/sync/events.js';

/**
 * 受控宿主接口 `window.DafanHouseholdSync` 的暴露面。
 *
 * 要求：只列业务动作与只读状态，绝不导出 member token、裸 engine 或 http 客户端；一次性被移出提示
 * 通过 `consumeRemovedNotice()` 读取，且只出现一次。
 */

const EXPECTED_METHODS = [
  'initOwner',
  'recoverOwner',
  'join',
  'leave',
  'pushNow',
  'pullNow',
  'status',
  'consumeRemovedNotice',
];

const status: SyncStatusSnapshot = {
  phase: 'ok',
  bound: true,
  householdId: 'hh-1',
  memberId: 'm-1',
  role: 'MEMBER',
  epoch: 1,
  lastSeq: 7,
  pendingOperations: 0,
  lastError: null,
  lastSyncedAt: '2026-03-04T05:06:07.000Z',
};

function engineStub() {
  return {
    initOwner: vi.fn(async () => ({
      binding: { householdId: 'hh-1', memberId: 'm-1', role: 'OWNER', epoch: 1, token: 'secret' },
      initialized: true,
    })),
    recoverOwner: vi.fn(async () => ({
      binding: { householdId: 'hh-1', memberId: 'm-1', role: 'OWNER', epoch: 2, token: 'secret' },
      initialized: false,
    })),
    join: vi.fn(async () => ({
      binding: { householdId: 'hh-1', memberId: 'm-2', role: 'MEMBER', epoch: 2, token: 'secret' },
      initialized: false,
    })),
    leave: vi.fn(async () => undefined),
    pushNow: vi.fn(async () => undefined),
    pullNow: vi.fn(async () => undefined),
    status: vi.fn(async () => status),
    start: vi.fn(),
    stop: vi.fn(),
    wake: vi.fn(async () => undefined),
  };
}

async function loadBootstrap(engine: ReturnType<typeof engineStub>) {
  vi.resetModules();
  const notice = {
    version: 1,
    householdId: 'hh-1',
    memberId: 'm-1',
    wipedAt: '2026-03-04T05:06:07.000Z',
  };
  const noticeQueue: unknown[] = [{ ...notice }];
  const security = {
    async getGateState() {
      return { lockedPendingWipe: false, pinRequired: false, pinUnlocked: false };
    },
    async setGateState() {
      return { lockedPendingWipe: false, pinRequired: false, pinUnlocked: false };
    },
    async getMemberToken() {
      return { memberToken: null };
    },
    async setMemberToken() {},
    async clearMemberToken() {},
    async purgeLocalData() {
      return {
        complete: true,
        databaseRemoved: true,
        uploadsRemoved: true,
        restoreRemoved: true,
        safetyBackupsRemoved: true,
        failed: [],
      };
    },
    async getMemberRemovedNotice() {
      return { notice: noticeQueue.length ? noticeQueue[0] : null };
    },
    async consumeMemberRemovedNotice() {
      const next = noticeQueue.shift() ?? null;
      return { notice: next };
    },
    async setMemberRemovedNotice() {},
    async clearWebViewData() {
      return { cleared: true };
    },
  };

  vi.doMock('@capacitor/core', () => ({
    Capacitor: { getPlatform: () => 'android' },
    registerPlugin: () => ({}),
  }));
  vi.doMock('@capacitor-community/sqlite', () => ({ CapacitorSQLite: {} }));
  vi.doMock('../src/native/app-security.js', () => ({ appSecurity: security }));
  vi.doMock('../src/sync/engine.js', () => ({
    createSyncEngine: () => engine,
  }));
  vi.doMock('../src/db/index.js', () => ({
    openCapacitorDatabase: async () => ({
      query: async () => [{ pinEnabled: 0 }],
      close: async () => undefined,
    }),
  }));
  vi.doMock('../src/modules/backup/service.js', () => ({
    recoverBackupFiles: async () => undefined,
  }));
  vi.doMock('../src/local-api/sync-cache.js', () => ({
    installSyncCacheRefresh: () => undefined,
  }));

  vi.stubGlobal('window', {});
  return import('../src/local-api/bootstrap.js');
}

describe('受控家庭同步宿主', () => {
  it('只暴露约定方法，不泄漏 token、engine 或 http', async () => {
    const engine = engineStub();
    const bootstrap = await loadBootstrap(engine);

    const host = (globalThis as unknown as { window: { DafanHouseholdSync?: object } }).window
      .DafanHouseholdSync as Record<string, unknown>;
    expect(host).toBeDefined();
    const { DafanHouseholdSync } = (
      globalThis as unknown as { window: { DafanHouseholdSync?: object } }
    ).window;
    expect(DafanHouseholdSync).toBe(bootstrap.householdSyncHost);

    const methods = Object.keys(host).sort();
    expect(methods).toEqual([...EXPECTED_METHODS].sort());
    for (const forbidden of ['token', 'memberToken', 'engine', 'http', 'socket', 'deviceId']) {
      expect(host[forbidden]).toBeUndefined();
    }
    expect(JSON.stringify(Object.keys(host))).not.toContain('token');
  });

  it('绑定类动作只回传身份摘要，不含 member token', async () => {
    const engine = engineStub();
    const bootstrap = await loadBootstrap(engine);
    const host = bootstrap.householdSyncHost!;

    await expect(
      host.join({ inviteCode: 'invite', nickname: '小周' }, { origin: 'https://cloud.example' }),
    ).resolves.toEqual({ householdId: 'hh-1', memberId: 'm-2', epoch: 2 });
    await expect(
      host.initOwner(
        { bootstrapSecret: 'secret', nickname: '馆主' },
        { origin: 'https://cloud.example' },
      ),
    ).resolves.toEqual({ householdId: 'hh-1', memberId: 'm-1', epoch: 1 });
    // 摘要里绝不能出现云端返回的 token。
    const summaries = [
      await host.recoverOwner({ bootstrapSecret: 'secret' }, { origin: 'https://cloud.example' }),
      await host.status(),
    ];
    expect(JSON.stringify(summaries)).not.toContain('"secret"');
  });

  it('consumeRemovedNotice 读原生一次性提示且只返回一次', async () => {
    const engine = engineStub();
    const bootstrap = await loadBootstrap(engine);
    const host = bootstrap.householdSyncHost!;

    await expect(host.consumeRemovedNotice()).resolves.toMatchObject({
      householdId: 'hh-1',
      memberId: 'm-1',
    });
    await expect(host.consumeRemovedNotice()).resolves.toBeNull();
    await expect(bootstrap.consumeMemberRemovedNotice()).resolves.toBeNull();
  });

  it('解绑与手动同步直接转交给引擎', async () => {
    const engine = engineStub();
    const bootstrap = await loadBootstrap(engine);
    const host = bootstrap.householdSyncHost!;

    await host.leave();
    await host.pushNow();
    await host.pullNow();

    expect(engine.leave).toHaveBeenCalledTimes(1);
    expect(engine.pushNow).toHaveBeenCalledTimes(1);
    expect(engine.pullNow).toHaveBeenCalledTimes(1);
  });
});
