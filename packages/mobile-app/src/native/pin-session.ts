import type { AppSecurityBridge } from './app-security.js';

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

export function createPinSession(security: AppSecurityBridge, now = () => Date.now()) {
  let session: { token: string; expiresAt: number } | undefined;
  let transition = Promise.resolve();

  function updateSession(nextToken: string | undefined, pinRequired?: boolean): Promise<void> {
    const expiresAt = nextToken === undefined ? 0 : now() + SESSION_LIFETIME_MS;
    const update = transition.then(async () => {
      session = undefined;
      const state = await security.setGateState({
        ...(pinRequired === undefined ? {} : { pinRequired }),
        pinUnlocked: nextToken !== undefined,
        pinExpiresAt: expiresAt,
      });
      if (nextToken === undefined) return;
      if (!state.pinRequired || !state.pinUnlocked || state.lockedPendingWipe) {
        throw new Error('The device PIN gate is locked');
      }
      session = { token: nextToken, expiresAt };
    });
    transition = update.catch(() => undefined);
    return update;
  }

  return {
    unlockAfterVerification(verifiedToken: string) {
      if (!verifiedToken.trim()) throw new Error('PIN session token is required');
      return updateSession(verifiedToken, true);
    },
    lock(pinRequired?: boolean) {
      return updateSession(undefined, pinRequired);
    },
    async isValid(candidate: string) {
      await transition;
      const current = session;
      if (!current) return false;
      if (current.expiresAt <= now()) {
        await updateSession(undefined);
        return false;
      }
      if (candidate !== current.token) return false;
      const state = await security.getGateState();
      return (
        session === current && state.pinRequired && state.pinUnlocked && !state.lockedPendingWipe
      );
    },
  };
}

export type PinSession = ReturnType<typeof createPinSession>;
