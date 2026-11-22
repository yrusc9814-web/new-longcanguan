import { describe, expect, it, vi } from 'vitest';
import {
  MEMBER_REMOVED_NOTICE_KEY,
  PendingWipeIncompleteError,
  consumeMemberRemovedNotice,
  createMemberRevocationWipe,
  isTrustedMemberRevocation,
  readMemberRemovedNotice,
  type WipeDependencies,
} from '../src/sync/wipe.js';
import type { GateState, LocalDataPurgeReport } from '../src/native/app-security.js';

const NOW = new Date('2026-03-04T05:06:07.000Z');

const COMPLETE: LocalDataPurgeReport = {
  complete: true,
  databaseRemoved: true,
  uploadsRemoved: true,
  restoreRemoved: true,
  failed: [],
};

function incomplete(...failed: string[]): LocalDataPurgeReport {
  return {
    complete: false,
    databaseRemoved: false,
    uploadsRemoved: false,
    restoreRemoved: false,
    failed,
  };
}

/**
 * 内存版原生门禁 + 文件世界。
 *
 * 状态存在 `world` 里，因此新建一个 wipe 实例（模拟进程重启）仍看到同一份持久状态，
 * 这正是崩溃重启用例需要的语义。
 */
function createHarness() {
  const world = {
    gate: { lockedPendingWipe: false, pinRequired: true, pinUnlocked: false } as GateState,
    token: 'member-token' as string | null,
    databaseOpen: true,
    uploads: ['thumb/a.webp', 'main/a.webp'],
    uploadsRestore: ['staged/b.webp'],
    purges: 0,
    /** 下一次 purge 时“顺手”重新落盘的文件，用来模拟过了门禁检查的延迟写。 */
    pendingLateWrites: [] as string[],
    events: [] as string[],
  };
  const storage = new Map<string, string>([['unrelated-cache', 'stale']]);

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
      if (world.gate.lockedPendingWipe) world.gate.pinUnlocked = false;
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
      return COMPLETE;
    },
    writeNotice(notice) {
      world.events.push('storage:notice');
      storage.clear();
      storage.set(MEMBER_REMOVED_NOTICE_KEY, JSON.stringify(notice));
    },
    resetDatabase() {
      world.events.push('db:reset');
    },
    now: () => NOW,
  };

  return { world, storage, deps };
}

type NoticeStorage = Pick<Storage, 'getItem' | 'removeItem'>;

/** 测试里需要替换个别步骤；生产契约保持只读。 */
type MutableDeps = { -readonly [K in keyof WipeDependencies]: WipeDependencies[K] };

function asStorage(store: Map<string, string>): NoticeStorage {
  return {
    getItem: (key) => store.get(key) ?? null,
    removeItem: (key) => void store.delete(key),
  };
}

describe('撤权清退状态机', () => {
  it('先持久门禁再删除，顺序固定且清退后保持锁定', async () => {
    const { world, storage, deps } = createHarness();
    const wipe = createMemberRevocationWipe(deps);

    const outcome = await wipe.wipe({ householdId: 'hh-1', memberId: 'm-1' });

    expect(outcome.status).toBe('wiped');
    // 门禁与令牌先于任何删除动作。
    expect(world.events[0]).toBe('gate:{"lockedPendingWipe":true,"pinUnlocked":false}');
    expect(world.events[1]).toBe('token:clear');
    expect(world.events.indexOf('sync:stop')).toBeLessThan(world.events.indexOf('db:close'));
    expect(world.events.indexOf('db:close')).toBeLessThan(world.events.indexOf('purge'));
    expect(world.purges).toBe(2);

    expect(world.token).toBeNull();
    expect(world.databaseOpen).toBe(false);
    expect(world.uploads).toEqual([]);
    expect(world.uploadsRestore).toEqual([]);
    // 在线清退完成后仍锁定：解锁只发生在冷启动补完里。
    expect(world.gate.lockedPendingWipe).toBe(true);
    expect(storage.get('unrelated-cache')).toBeUndefined();
    expect(readMemberRemovedNotice(asStorage(storage))).toEqual({
      version: 1,
      householdId: 'hh-1',
      memberId: 'm-1',
      wipedAt: NOW.toISOString(),
    });
  });

  it('物理删除不完整时抛错、保持锁定、不写提示也不 reset 数据库', async () => {
    const { world, storage, deps } = createHarness();
    world.pendingLateWrites = ['thumb/a.webp'];
    const wipe = createMemberRevocationWipe(deps);

    await expect(wipe.wipe()).rejects.toBeInstanceOf(PendingWipeIncompleteError);

    expect(world.gate.lockedPendingWipe).toBe(true);
    expect(world.events).not.toContain('storage:notice');
    expect(world.events).not.toContain('db:reset');
    expect(storage.get(MEMBER_REMOVED_NOTICE_KEY)).toBeUndefined();
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
    expect(world.gate.lockedPendingWipe).toBe(true);
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
});

describe('冷启动补完（模拟清退中途崩溃）', () => {
  it('锁住时先补完擦除再解锁并重建空库', async () => {
    const { world, storage, deps } = createHarness();
    // 崩溃现场：门禁已持久化、令牌已清，但文件与连接仍在。
    world.gate = { lockedPendingWipe: true, pinRequired: true, pinUnlocked: false };

    const restarted = createMemberRevocationWipe(deps);
    await expect(restarted.recoverAtStartup()).resolves.toBe('recovered');

    expect(world.uploads).toEqual([]);
    expect(world.uploadsRestore).toEqual([]);
    expect(world.events).toContain('db:reset');
    expect(world.gate).toEqual({
      lockedPendingWipe: false,
      pinRequired: false,
      pinUnlocked: false,
    });
    expect(readMemberRemovedNotice(asStorage(storage))).not.toBeNull();
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
    expect(world.events).not.toContain('storage:notice');

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

describe('一次性被移出提示', () => {
  it('读取后即删除，只出现一次', () => {
    const store = new Map<string, string>();
    store.set(
      MEMBER_REMOVED_NOTICE_KEY,
      JSON.stringify({ version: 1, householdId: 'hh', memberId: 'm', wipedAt: NOW.toISOString() }),
    );
    const storage = asStorage(store);

    expect(consumeMemberRemovedNotice(storage)?.memberId).toBe('m');
    expect(consumeMemberRemovedNotice(storage)).toBeNull();
  });

  it('损坏或旧版本内容视为无提示', () => {
    const broken: NoticeStorage = { getItem: () => '{not json', removeItem: () => undefined };
    const legacy: NoticeStorage = {
      getItem: () => JSON.stringify({ version: 0, wipedAt: NOW.toISOString() }),
      removeItem: () => undefined,
    };

    expect(readMemberRemovedNotice(broken)).toBeNull();
    expect(readMemberRemovedNotice(legacy)).toBeNull();
    expect(readMemberRemovedNotice(undefined)).toBeNull();
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

    const stop = vi.fn();
    await bootstrap.handleTrustedMemberRevocation(stop, { householdId: 'hh', memberId: 'm' });
    expect(stop).toHaveBeenCalledTimes(1);

    vi.doUnmock('@capacitor/core');
    vi.doUnmock('@capacitor-community/sqlite');
    vi.doUnmock('../src/db/index.js');
  });
});
