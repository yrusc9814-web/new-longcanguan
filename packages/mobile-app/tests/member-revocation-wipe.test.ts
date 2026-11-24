import { describe, expect, it, vi } from 'vitest';
import {
  PendingWipeIncompleteError,
  createMemberRevocationWipe,
  isTrustedMemberRevocation,
  memberRemovedNoticeFromNative,
  type MemberRemovedNotice,
  type WipeDependencies,
} from '../src/sync/wipe.js';
import type { GateState, LocalDataPurgeReport } from '../src/native/app-security.js';

const NOW = new Date('2026-03-04T05:06:07.000Z');

const COMPLETE: LocalDataPurgeReport = {
  complete: true,
  databaseRemoved: true,
  uploadsRemoved: true,
  restoreRemoved: true,
  safetyBackupsRemoved: true,
  failed: [],
};

function incomplete(...failed: string[]): LocalDataPurgeReport {
  return {
    complete: false,
    databaseRemoved: false,
    uploadsRemoved: false,
    restoreRemoved: false,
    safetyBackupsRemoved: false,
    failed,
  };
}

/**
 * 内存版原生门禁 + 文件世界。
 *
 * 状态存在 `world` 里，因此新建一个 wipe 实例（模拟进程重启）仍看到同一份持久状态，
 * 这正是崩溃重启用例需要的语义。提示也存 `world.notice`（模拟原生私有目录）。
 */
function createHarness() {
  const world = {
    gate: { lockedPendingWipe: false, pinRequired: true, pinUnlocked: false } as GateState,
    token: 'member-token' as string | null,
    databaseOpen: true,
    uploads: ['thumb/a.webp', 'main/a.webp'],
    uploadsRestore: ['staged/b.webp'],
    safetyBackups: ['dafan-epoch-1-to-2.zip'],
    notice: null as MemberRemovedNotice | null,
    webViewClearable: true,
    purges: 0,
    /** 下一次 purge 时“顺手”重新落盘的文件，用来模拟过了门禁检查的延迟写。 */
    pendingLateWrites: [] as string[],
    events: [] as string[],
  };

  const deps: MutableDeps = {
    async readGateState() {
      return { ...world.gate };
    },
    async applyGateState(update) {
      world.events.push(`gate:${JSON.stringify(update)}`);
      world.gate = {
        lockedPendingWipe: update.lockedPendingWipe ?? world.gate.lockedPendingWipe,
        pinRequired: update.pinRequired ?? world.gate.pinRequired,
        pinUnlocked: update.pinUnlocked ?? world.gate.pinUnlocked,
      };
      if (world.gate.lockedPendingWipe || !world.gate.pinRequired) world.gate.pinUnlocked = false;
      return { ...world.gate };
    },
    async clearMemberToken() {
      world.events.push('token:clear');
      world.token = null;
    },
    async stopBackground() {
      world.events.push('sync:stop');
    },
    async closeDatabase() {
      world.events.push('db:close');
      world.databaseOpen = false;
    },
    async purgeLocalData() {
      world.events.push('purge');
      world.purges += 1;
      if (!world.gate.lockedPendingWipe) throw new Error('NOT_LOCKED');
      if (world.pendingLateWrites.length) {
        world.uploads.push(...world.pendingLateWrites);
        world.pendingLateWrites = [];
        return incomplete('uploads');
      }
      world.uploads = [];
      world.uploadsRestore = [];
      world.safetyBackups = [];
      return COMPLETE;
    },
    async clearWebViewData() {
      world.events.push('webview:clear');
      return world.webViewClearable;
    },
    async readNotice() {
      return world.notice;
    },
    async writeNotice(notice) {
      world.events.push('notice:write');
      world.notice = { ...notice };
    },
    resetDatabase() {
      world.events.push('db:reset');
    },
    now: () => NOW,
  };

  return { world, deps };
}

type MutableDeps = { -readonly [K in keyof WipeDependencies]: WipeDependencies[K] };

describe('撤权清退状态机', () => {
  it('先持久门禁再删除，顺序固定，成功后当场解锁并重建空库', async () => {
    const { world, deps } = createHarness();
    const wipe = createMemberRevocationWipe(deps);

    const outcome = await wipe.wipe({ householdId: 'hh-1', memberId: 'm-1' });

    expect(outcome.status).toBe('wiped');
    expect(outcome.unlocked).toBe(true);
    // 门禁与令牌先于任何删除动作；提示在擦除前就落盘，崩溃也能读出真实身份。
    expect(world.events[0]).toBe('gate:{"lockedPendingWipe":true,"pinUnlocked":false}');
    expect(world.events[1]).toBe('token:clear');
    expect(world.events[2]).toBe('notice:write');
    expect(world.events.indexOf('sync:stop')).toBeLessThan(world.events.indexOf('db:close'));
    expect(world.events.indexOf('db:close')).toBeLessThan(world.events.indexOf('purge'));
    expect(world.events.indexOf('purge')).toBeLessThan(world.events.indexOf('webview:clear'));
    expect(world.purges).toBe(2);

    expect(world.token).toBeNull();
    expect(world.databaseOpen).toBe(false);
    expect(world.uploads).toEqual([]);
    expect(world.uploadsRestore).toEqual([]);
    expect(world.safetyBackups).toEqual([]);
    // 在线清退完成后立即解锁：用户无需强杀进程即可继续使用单机版。
    expect(world.gate).toEqual({
      lockedPendingWipe: false,
      pinRequired: false,
      pinUnlocked: false,
    });
    expect(world.events.at(-1)).toBe('db:reset');
    expect(world.notice).toEqual({
      version: 1,
      householdId: 'hh-1',
      memberId: 'm-1',
      wipedAt: NOW.toISOString(),
    });
    expect(world.events.filter((event) => event === 'notice:write')).toHaveLength(1);
  });

  it('物理删除不完整时抛错、保持锁定、不解锁也不 reset 数据库', async () => {
    const { world, deps } = createHarness();
    world.pendingLateWrites = ['thumb/a.webp'];
    const wipe = createMemberRevocationWipe(deps);

    await expect(wipe.wipe()).rejects.toBeInstanceOf(PendingWipeIncompleteError);

    expect(world.gate.lockedPendingWipe).toBe(true);
    expect(world.events).not.toContain('webview:clear');
    expect(world.events).not.toContain('db:reset');
    expect(
      world.events.some(
        (event) => event.startsWith('gate:') && event.includes('"lockedPendingWipe":false'),
      ),
    ).toBe(false);
  });

  it('WebView 清理失败时保持锁定，重试后完成', async () => {
    const { world, deps } = createHarness();
    world.webViewClearable = false;
    const wipe = createMemberRevocationWipe(deps);

    await expect(wipe.wipe({ householdId: 'hh-1', memberId: 'm-1' })).rejects.toBeInstanceOf(
      PendingWipeIncompleteError,
    );
    expect(world.gate.lockedPendingWipe).toBe(true);
    expect(world.events).not.toContain('db:reset');

    world.webViewClearable = true;
    await expect(wipe.wipe({ householdId: 'hh-1', memberId: 'm-1' })).resolves.toMatchObject({
      unlocked: true,
    });
    expect(world.gate.lockedPendingWipe).toBe(false);
  });

  it('延迟写复活后重试安全，最终不留文件', async () => {
    const { world, deps } = createHarness();
    world.pendingLateWrites = ['main/late.webp'];
    const wipe = createMemberRevocationWipe(deps);

    await expect(wipe.wipe()).rejects.toBeInstanceOf(PendingWipeIncompleteError);
    // 重试从头再跑，捕获第一轮之后才落盘的写入。
    await wipe.wipe();

    expect(world.uploads).toEqual([]);
    expect(world.uploadsRestore).toEqual([]);
    expect(world.safetyBackups).toEqual([]);
    expect(world.gate.lockedPendingWipe).toBe(false);
    expect(world.token).toBeNull();
  });

  it('并发调用共享同一次清退，不重复删除', async () => {
    const { world, deps } = createHarness();
    const wipe = createMemberRevocationWipe(deps);

    await Promise.all([wipe.wipe(), wipe.wipe(), wipe.wipe()]);

    expect(world.purges).toBe(2);
    expect(world.events.filter((event) => event === 'token:clear')).toHaveLength(1);
  });

  it('门禁写入失败即终止，绝不删除数据', async () => {
    const { world, deps } = createHarness();
    deps.applyGateState = async () => {
      throw new Error('GATE_UPDATE_FAILED');
    };
    const wipe = createMemberRevocationWipe(deps);

    await expect(wipe.wipe()).rejects.toThrow('GATE_UPDATE_FAILED');

    expect(world.events).toEqual([]);
    expect(world.uploads).toHaveLength(2);
    expect(world.token).toBe('member-token');
  });

  it('未带身份时不覆盖已持久化的真实身份', async () => {
    const { world, deps } = createHarness();
    world.notice = {
      version: 1,
      householdId: 'hh-real',
      memberId: 'm-real',
      wipedAt: '2026-03-01T00:00:00.000Z',
    };
    const wipe = createMemberRevocationWipe(deps);

    const outcome = await wipe.wipe();

    expect(outcome.notice).toMatchObject({ householdId: 'hh-real', memberId: 'm-real' });
    expect(world.notice).toMatchObject({ householdId: 'hh-real', memberId: 'm-real' });
  });
});

describe('冷启动补完（模拟清退中途崩溃）', () => {
  it('锁住时补完擦除并解锁，重建空库并保留原生身份', async () => {
    const { world, deps } = createHarness();
    // 崩溃现场：门禁已持久化、令牌已清、提示已落盘，但文件与连接仍在。
    world.gate = { lockedPendingWipe: true, pinRequired: true, pinUnlocked: false };
    world.notice = {
      version: 1,
      householdId: 'hh-crash',
      memberId: 'm-crash',
      wipedAt: '2026-03-02T00:00:00.000Z',
    };

    const restarted = createMemberRevocationWipe(deps);
    await expect(restarted.recoverAtStartup()).resolves.toBe('recovered');

    expect(world.uploads).toEqual([]);
    expect(world.uploadsRestore).toEqual([]);
    expect(world.safetyBackups).toEqual([]);
    expect(world.events).toContain('db:reset');
    expect(world.gate).toEqual({
      lockedPendingWipe: false,
      pinRequired: false,
      pinUnlocked: false,
    });
    // 冷启动补完不得用空身份覆盖已持久化的 householdId/memberId。
    expect(world.notice).toEqual({
      version: 1,
      householdId: 'hh-crash',
      memberId: 'm-crash',
      wipedAt: '2026-03-02T00:00:00.000Z',
    });
  });

  it('未处于 lockedPendingWipe 时跳过，不删除任何数据', async () => {
    const { world, deps } = createHarness();
    const wipe = createMemberRevocationWipe(deps);

    await expect(wipe.recoverAtStartup()).resolves.toBe('skipped');

    expect(world.events).toEqual([]);
    expect(world.uploads).toHaveLength(2);
  });

  it('补完删除失败保持锁定且抛错，下一次重启仍可重跑', async () => {
    const { world, deps } = createHarness();
    world.gate = { lockedPendingWipe: true, pinRequired: false, pinUnlocked: false };
    deps.purgeLocalData = async () => {
      world.events.push('purge');
      return incomplete('dafanSQLite.db-wal');
    };

    const first = createMemberRevocationWipe(deps);
    await expect(first.recoverAtStartup()).rejects.toBeInstanceOf(PendingWipeIncompleteError);
    expect(world.gate.lockedPendingWipe).toBe(true);
    expect(world.events).not.toContain('db:reset');

    // 再次重启：删除恢复正常后补完，说明锁定状态可安全重试。
    deps.purgeLocalData = async () => {
      world.events.push('purge');
      return COMPLETE;
    };
    const second = createMemberRevocationWipe(deps);
    await expect(second.recoverAtStartup()).resolves.toBe('recovered');
    expect(world.gate.lockedPendingWipe).toBe(false);
  });
});

describe('原生一次性被移出提示载荷校验', () => {
  it('当前版本且 wipedAt 非空时可用', () => {
    expect(
      memberRemovedNoticeFromNative({
        version: 1,
        householdId: 'hh',
        memberId: 'm',
        wipedAt: NOW.toISOString(),
      }),
    ).toEqual({ version: 1, householdId: 'hh', memberId: 'm', wipedAt: NOW.toISOString() });
  });

  it('缺身份字段时归 null，损坏或旧版本视为无提示', () => {
    expect(memberRemovedNoticeFromNative({ version: 1, wipedAt: NOW.toISOString() })).toMatchObject(
      { householdId: null, memberId: null },
    );
    expect(memberRemovedNoticeFromNative({ version: 0, wipedAt: NOW.toISOString() })).toBeNull();
    expect(memberRemovedNoticeFromNative({ version: 1 })).toBeNull();
    expect(memberRemovedNoticeFromNative({ version: 1, wipedAt: '' })).toBeNull();
    expect(memberRemovedNoticeFromNative(null)).toBeNull();
    expect(memberRemovedNoticeFromNative('notice')).toBeNull();
  });
});

describe('可信撤权触发判定', () => {
  const context = {
    householdId: 'hh-1',
    memberId: 'm-1',
    bindingGeneration: 4,
    requestGeneration: 4,
  };
  const frame = {
    code: 'MEMBER_REVOKED',
    householdId: 'hh-1',
    memberId: 'm-1',
    transport: 'ws',
  } as const;

  it('当前代际、当前家庭与成员匹配时触发', () => {
    expect(isTrustedMemberRevocation(frame, context)).toBe(true);
    expect(isTrustedMemberRevocation({ ...frame, transport: 'http', status: 403 }, context)).toBe(
      true,
    );
  });

  it.each([
    ['HTTP 非 403', { ...frame, transport: 'http' as const, status: 401 }, context],
    [
      'HTTP 403 但码不同',
      { ...frame, code: 'FORBIDDEN', transport: 'http' as const, status: 403 },
      context,
    ],
    ['HTTP 429', { ...frame, transport: 'http' as const, status: 429 }, context],
    ['HTTP 500', { ...frame, transport: 'http' as const, status: 500 }, context],
    ['代际不匹配', frame, { ...context, requestGeneration: 3 }],
    ['家庭不匹配', frame, { ...context, householdId: 'hh-2' }],
    ['成员不匹配', { ...frame, memberId: 'm-2' }, context],
    ['信号缺少成员', { ...frame, memberId: undefined }, context],
    ['绑定未建立', frame, { ...context, memberId: null }],
  ])('%s 时不触发', (_name, signal, ctx) => {
    expect(isTrustedMemberRevocation(signal as never, ctx)).toBe(false);
  });
});

describe('bootstrap 接线', () => {
  it('导出可注入 stopSync 的可信清退入口', async () => {
    vi.doMock('@capacitor/core', () => ({
      Capacitor: { getPlatform: () => 'web' },
      registerPlugin: () => ({}),
    }));
    vi.doMock('@capacitor-community/sqlite', () => ({ CapacitorSQLite: {} }));
    vi.doMock('../src/db/index.js', () => ({
      openCapacitorDatabase: async () => ({ query: async () => [{ pinEnabled: 0 }] }),
    }));

    const bootstrap = await import('../src/local-api/bootstrap.js');
    expect(typeof bootstrap.handleTrustedMemberRevocation).toBe('function');
    expect(typeof bootstrap.memberRevocationWipe.recoverAtStartup).toBe('function');
    expect(typeof bootstrap.consumeMemberRemovedNotice).toBe('function');

    const stop = vi.fn();
    await bootstrap.handleTrustedMemberRevocation(stop, { householdId: 'hh', memberId: 'm' });
    expect(stop).toHaveBeenCalledTimes(1);

    vi.doUnmock('@capacitor/core');
    vi.doUnmock('@capacitor-community/sqlite');
    vi.doUnmock('../src/db/index.js');
  });
});
