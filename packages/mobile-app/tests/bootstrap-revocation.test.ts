import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberRemovedNotice } from '../src/sync/wipe.js';

/**
 * 冷启动补完与在线清退的接线验证。
 *
 * `bootstrap` 在模块载入时就会尝试初始化门禁，所以测试 mock 原生桥，观察：
 * - 「清退中途崩溃」的进程如何重启：先补完物理擦除，再解锁并重建全新库；
 * - 在线被踢如何当场自愈：擦除 + 清 WebView + 落原生提示后立刻解锁并重建空库。
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

const webView = { cleared: true, calls: 0 };
const world: { notice: MemberRemovedNotice | null } = { notice: null };
let reloads = 0;

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
      if (gateState.lockedPendingWipe || !gateState.pinRequired) gateState.pinUnlocked = false;
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
        safetyBackupsRemoved: purge.complete,
        failed: purge.complete ? [] : ['uploads'],
      };
    },
    async clearWebViewData() {
      webView.calls += 1;
      events.push('webview:clear');
      return { cleared: webView.cleared };
    },
    async getMemberRemovedNotice() {
      return { notice: world.notice ? { ...world.notice } : null };
    },
    async consumeMemberRemovedNotice() {
      const notice = world.notice;
      world.notice = null;
      return { notice: notice ? { ...notice } : null };
    },
    async setMemberRemovedNotice(options: {
      householdId: string | null;
      memberId: string | null;
      wipedAt: string;
    }) {
      events.push('notice:write');
      world.notice = {
        version: 1,
        householdId: options.householdId,
        memberId: options.memberId,
        wipedAt: options.wipedAt,
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

beforeEach(async () => {
  events.length = 0;
  purge.complete = true;
  purge.calls = 0;
  webView.cleared = true;
  webView.calls = 0;
  world.notice = null;
  // 上一个用例调度的一次性重载 timer 可能还在飞，先让它落地再清零，避免计数串味。
  await new Promise((resolve) => setTimeout(resolve, 200));
  reloads = 0;
  vi.unstubAllGlobals();
  vi.stubGlobal('location', {
    origin: 'https://localhost',
    reload: () => {
      reloads += 1;
    },
  });
  openDatabase.mockClear();
  gateState.lockedPendingWipe = true;
  gateState.pinRequired = true;
  gateState.pinUnlocked = false;
});

// 冷启动用例还要承担 bootstrap 模块图的首次 transform 与两次擦除：
// 单文件实测约 1.2s，与其它测试文件同轮并发时 4~5.3s，默认 5000ms 预算不足。
const COLD_START_TIMEOUT_MS = 15_000;

describe('冷启动补完物理擦除', () => {
  it(
    '锁定状态下先擦除再解锁，然后才打开全新库',
    async () => {
      const bootstrap = await loadBootstrap();
      const response = await bootstrap.localApi.handle(health());

      expect(response.status).toBe(200);
      const unlockIndex = events.findIndex(
        (event) => event.startsWith('gate:write') && event.includes('"lockedPendingWipe":false'),
      );
      expect(events.indexOf('purge')).toBeGreaterThanOrEqual(0);
      expect(events.indexOf('purge')).toBeLessThan(unlockIndex);
      expect(events.indexOf('webview:clear')).toBeLessThan(unlockIndex);
      expect(unlockIndex).toBeLessThan(events.indexOf('db:open'));
      // 两次删除都发生在解锁之前。
      expect(events.filter((event) => event === 'purge')).toHaveLength(2);
      expect(gateState.lockedPendingWipe).toBe(false);
      expect(events).toContain('backup:recover');
    },
    COLD_START_TIMEOUT_MS,
  );

  it(
    '擦除不完整时保持锁定且从不打开旧库',
    async () => {
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
    },
    COLD_START_TIMEOUT_MS,
  );

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
  it('擦除与清 WebView 后立刻解锁并重建空库，无需强杀进程', async () => {
    gateState.lockedPendingWipe = false;
    gateState.pinRequired = true;
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
    expect(events.indexOf('purge')).toBeLessThan(events.indexOf('webview:clear'));
    expect(purge.calls).toBe(2);
    expect(webView.calls).toBe(1);
    // 在线清退成功后当场解锁：用户无需重启即可继续使用干净单机版。
    expect(gateState).toEqual({
      lockedPendingWipe: false,
      pinRequired: false,
      pinUnlocked: false,
    });
    expect(world.notice).toMatchObject({ version: 1, householdId: 'hh-1', memberId: 'm-1' });

    // 解锁后的下一次请求会重建空库：db:open 出现在解锁之后。
    const unlockIndex = events.findIndex(
      (event) => event.startsWith('gate:write') && event.includes('"lockedPendingWipe":false'),
    );
    const response = await bootstrap.localApi.handle(health());
    expect(response.status).toBe(200);
    expect(events.indexOf('db:open')).toBeGreaterThan(unlockIndex);

    const consumed = await bootstrap.consumeMemberRemovedNotice();
    expect(consumed).toMatchObject({ householdId: 'hh-1', memberId: 'm-1' });
    await expect(bootstrap.consumeMemberRemovedNotice()).resolves.toBeNull();
  });

  it('擦除不完整时抛错并保持锁定，不解锁也不清 WebView', async () => {
    gateState.lockedPendingWipe = false;
    purge.complete = false;
    const bootstrap = await loadBootstrap();

    await expect(bootstrap.handleTrustedMemberRevocation(() => undefined)).rejects.toThrow();

    expect(gateState.lockedPendingWipe).toBe(true);
    expect(gateState.pinUnlocked).toBe(false);
    expect(unlockedWrite()).toBe(false);
    expect(events).not.toContain('webview:clear');
    expect(events).not.toContain('db:reset');
  });

  it('WebView 清理失败时保持锁定并抛错', async () => {
    gateState.lockedPendingWipe = false;
    webView.cleared = false;
    const bootstrap = await loadBootstrap();

    await expect(bootstrap.handleTrustedMemberRevocation(() => undefined)).rejects.toThrow();

    expect(gateState.lockedPendingWipe).toBe(true);
    expect(unlockedWrite()).toBe(false);
    expect(reloads).toBe(0);
  });

  it('清退成功后调度一次文档重载，让页面丢弃旧内存视图', async () => {
    gateState.lockedPendingWipe = false;
    const bootstrap = await loadBootstrap();
    await bootstrap.localApi.handle(health());
    // 前序用例的重载 timer 可能还在飞，先让它落脚再清零，避免计数串味。
    await new Promise((resolve) => setTimeout(resolve, 200));
    reloads = 0;

    await bootstrap.handleTrustedMemberRevocation(() => undefined, {
      householdId: 'hh-1',
      memberId: 'm-1',
    });

    // 重载是异步调度（100ms），等待它真正触发。
    expect(reloads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reloads).toBe(1);
    expect(gateState.lockedPendingWipe).toBe(false);
  });
});
