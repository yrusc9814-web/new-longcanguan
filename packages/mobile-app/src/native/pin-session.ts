import type { AppSecurityBridge } from './app-security.js';

export function createPinSession(security: AppSecurityBridge) {
  let token: string | undefined;
  let transition = Promise.resolve();

  function updateSession(nextToken: string | undefined): Promise<void> {
    const update = transition.then(async () => {
      token = undefined;
      const state = await security.setGateState({ pinUnlocked: nextToken !== undefined });
      if (nextToken === undefined) return;
      if (!state.pinRequired || !state.pinUnlocked || state.lockedPendingWipe) {
        throw new Error('The device PIN gate is locked');
      }
      token = nextToken;
    });
    transition = update.catch(() => undefined);
    return update;
  }

  return {
    async unlockAfterVerification(verifiedToken: string) {
      if (!verifiedToken.trim()) throw new Error('PIN session token is required');
      await updateSession(verifiedToken);
    },
    lock() {
      return updateSession(undefined);
    },
    async isValid(candidate: string) {
      await transition;
      if (token === undefined || candidate !== token) return false;
      const state = await security.getGateState();
      return (
        token === candidate && state.pinRequired && state.pinUnlocked && !state.lockedPendingWipe
      );
    },
  };
}
