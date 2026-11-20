import { describe, expect, it } from 'vitest';
import { createMemoryAppSecurity } from '../src/native/app-security.js';
import { createPinSession } from '../src/native/pin-session.js';

describe('端内安全桥接', () => {
  it('Web 替身仅在实例内保留 memberToken，并可擦除', async () => {
    const security = createMemoryAppSecurity();
    await expect(security.setMemberToken({ memberToken: '' })).rejects.toThrow();
    await security.setMemberToken({ memberToken: 'fixture' });
    await expect(security.getMemberToken()).resolves.toEqual({ memberToken: 'fixture' });
    await expect(createMemoryAppSecurity().getMemberToken()).resolves.toEqual({
      memberToken: null,
    });
    await security.clearMemberToken();
    await expect(security.getMemberToken()).resolves.toEqual({ memberToken: null });
  });

  it('经验证的 PIN 会话同时开启原生读图门禁，并由锁定或封锁撤销', async () => {
    const security = createMemoryAppSecurity();
    const session = createPinSession(security);
    await security.setGateState({ pinRequired: true });
    await expect(session.isValid('verified')).resolves.toBe(false);
    await session.unlockAfterVerification('verified');
    await expect(security.getGateState()).resolves.toMatchObject({ pinUnlocked: true });
    await expect(session.isValid('verified')).resolves.toBe(true);
    await expect(session.isValid('unverified')).resolves.toBe(false);
    await security.setGateState({ lockedPendingWipe: true });
    await expect(security.getGateState()).resolves.toMatchObject({ pinUnlocked: false });
    await expect(session.isValid('verified')).resolves.toBe(false);
    await expect(session.unlockAfterVerification('verified')).rejects.toThrow('gate is locked');
  });

  it('解锁和重新锁定按调用顺序生效', async () => {
    const security = createMemoryAppSecurity();
    const session = createPinSession(security);
    await security.setGateState({ pinRequired: true });
    await Promise.all([session.unlockAfterVerification('verified'), session.lock()]);
    await expect(security.getGateState()).resolves.toMatchObject({ pinUnlocked: false });
    await expect(session.isValid('verified')).resolves.toBe(false);
  });
});
