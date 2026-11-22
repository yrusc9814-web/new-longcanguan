import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MEMBER_REMOVED_NOTICE_KEY } from '../src/sync/wipe.js';

/**
 * 冷启动补完与在线清退的接线验证。
 *
 * `bootstrap` 在模块载入时就会尝试初始化门禁，所以测试 mock 原生桥，观察一个「清退中途崩溃」的
 * 进程如何重启：先补完物理擦除，再解锁并重建全新库；擦除不完整时始终停留锁定。
 */
const events: string[] = [];

const gateState = {
  lockedPendingWipe: true,
  pinRequired: true,
  pinUnlocked: false,
};

const purge = {
  complete: true,
  calls: 0,
};

const openDatabase = vi.fn(async () => {
  events.push('db:open');
  return {
    query: vi.fn(async (sql: string) =>
      sql.includes('device_local_config') ? [{ pinEnabled: 0 }] : [{ ready: 1 }],
    ),
    close: vi.fn(async () => {
      events.push('db:close');
    }),
  };
});

function securityStub() {
  return {
    async getGateState() {
      return { ...gateState };
    },
    async setGateState(update: Partial<typeof gateState>) {
      events.push(`gate:write:${JSON.stringify(update)}`);
      if (update.lockedPendingWipe !== undefined) {
        gateState.lockedPendingWipe = update.lockedPendingWipe;
      }
      if (update.pinRequired !== undefined) gateState.pinRequired = update.pinRequired;
      if (update.pinUnlocked !== undefined) gateState.pinUnlocked = update.pinUnlocked;
      if (gateState.lockedPendingWipe) gateState.pinUnlocked = false;
      return { ...gateState };
    },
    async getMemberToken() {
      return { memberToken: null };
    },
    async setMemberToken() {
      events.push('token:set');
    },
    async clearMemberToken() {
      events.push('token:clear');
    },
    async purgeLocalData() {
      purge.calls += 1;
      events.push('purge');
      if (!gateState.lockedPendingWipe) throw new Error('NOT_LOCKED');
      return {
        complete: purge.complete,
        databaseRemoved: purge.complete,
        uploadsRemoved: purge.complete,
        restoreRemoved: purge.complete,
        failed: purge.complete ? [] : ['uploads'],
      };
    },
  };
}

function installMocks() {
  vi.doMock('@capacitor/core', () => ({
    Capacitor: { getPlatform: () => 'android' },
    registerPlugin: () => ({}),
  }));
  vi.doMock('@capacitor-community/sqlite', () => ({ CapacitorSQLite: {} }));
  vi.doMock('../src/native/app-security.js', () => ({ appSecurity: securityStub() }));
  vi.doMock('../src/db/index.js', () => ({ openCapacitorDatabase: openDatabase }));
  vi.doMock('../src/modules/backup/service.js', () => ({
    recoverBackupFiles: async () => {
      events.push('backup:recover');
    },
  }));
}

async function loadBootstrap() {
  vi.resetModules();
  installMocks();
  return import('../src/local-api/bootstrap.js');
}

function health() {
  return new Request('https://localhost/api/v1/health', { method: 'GET' });
}

const unlockedWrite = () =>
  events.some(
    (event) => event.startsWith('gate:write') && event.includes('"lockedPendingWipe":false'),
  );

beforeEach(() => {
  events.length = 0;
  purge.complete = true;
  purge.calls = 0;
  openDatabase.mockClear();
  gateState.lockedPendingWipe = true;
  gateState.pinRequired = true;
  gateState.pinUnlocked = false;
});

describe('冷启动补完物理擦除', () => {
  it('锁定状态下先擦除再解锁，然后才打开全新库', async () => {
    const bootstrap = await loadBootstrap();
    const response = await bootstrap.localApi.handle(health());

    expect(response.status).toBe(200);
    const unlockIndex = events.findIndex(
      (event) => event.startsWith('gate:write') && event.includes('"lockedPendingWipe":false'),
    );
    expect(events.indexOf('purge')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('purge')).toBeLessThan(unlockIndex);
    expect(unlockIndex).toBeLessThan(events.indexOf('db:open'));
    // 两次删除都发生在解锁之前。
    expect(events.filter((event) => event === 'purge')).toHaveLength(2);
    expect(gateState.lockedPendingWipe).toBe(false);
    expect(events).toContain('backup:recover');
  });

  it('擦除不完整时保持锁定且从不打开旧库', async () => {
    purge.complete = false;
    const bootstrap = await loadBootstrap();

    const response = await bootstrap.localApi.handle(health());

    // 补完失败 → 路由按持久门禁返回 403 MEMBER_REVOKED，绝不回落到旧库。
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'MEMBER_REVOKED' } });
    expect(gateState.lockedPendingWipe).toBe(true);
    expect(unlockedWrite()).toBe(false);
    expect(events).not.toContain('db:open');
    expect(events).not.toContain('backup:recover');
  });

  it('未处于锁定状态时跳过补完，直接打开库', async () => {
    gateState.lockedPendingWipe = false;
    gateState.pinRequired = false;
    const bootstrap = await loadBootstrap();

    const response = await bootstrap.localApi.handle(health());

    expect(response.status).toBe(200);
    expect(purge.calls).toBe(0);
    expect(events).toContain('db:open');
  });
});

describe('在线可信撤权入口', () => {
  it('先落持久门禁与清令牌，再停同步、关库并删除，最后只留一次性提示', async () => {
    gateState.lockedPendingWipe = false;
    const store = new Map<string, string>([['cache', 'x']]);
    vi.stubGlobal('localStorage', {
      clear: () => store.clear(),
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    vi.stubGlobal('sessionStorage', {
      clear: () => undefined,
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });

    const bootstrap = await loadBootstrap();
    // 先把模块级初始化跑完（此处门禁已解锁），再观察清退自身的动作顺序。
    await bootstrap.localApi.handle(health());
    events.length = 0;
    const stop = vi.fn(() => events.push('sync:stop'));

    await bootstrap.handleTrustedMemberRevocation(stop, {
      householdId: 'hh-1',
      memberId: 'm-1',
    });

    expect(stop).toHaveBeenCalledTimes(1);
    const gateIndex = events.findIndex(
      (event) => event.startsWith('gate:write') && event.includes('"lockedPendingWipe":true'),
    );
    expect(gateIndex).toBe(0);
    expect(events[1]).toBe('token:clear');
    expect(events.indexOf('sync:stop')).toBeLessThan(events.indexOf('purge'));
    expect(purge.calls).toBe(2);
    // 在线清退完成后仍然锁定；解锁交给冷启动补完。
    expect(gateState.lockedPendingWipe).toBe(true);
    expect(store.get('cache')).toBeUndefined();
    expect(JSON.parse(store.get(MEMBER_REMOVED_NOTICE_KEY) ?? '{}')).toMatchObject({
      version: 1,
      householdId: 'hh-1',
      memberId: 'm-1',
    });

    vi.unstubAllGlobals();
  });

  it('擦除不完整时抛错并保持锁定', async () => {
    gateState.lockedPendingWipe = false;
    purge.complete = false;
    const bootstrap = await loadBootstrap();

    await expect(bootstrap.handleTrustedMemberRevocation(() => undefined)).rejects.toThrow();

    expect(gateState.lockedPendingWipe).toBe(true);
    expect(gateState.pinUnlocked).toBe(false);
  });
});
