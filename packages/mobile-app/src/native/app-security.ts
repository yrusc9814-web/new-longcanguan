import { Capacitor, registerPlugin } from '@capacitor/core';

export interface GateState {
  lockedPendingWipe: boolean;
  pinRequired: boolean;
  pinUnlocked: boolean;
}

export interface AppSecurityBridge {
  getGateState(): Promise<GateState>;
  setGateState(update: Partial<GateState>): Promise<GateState>;
  getMemberToken(): Promise<{ memberToken: string | null }>;
  setMemberToken(options: { memberToken: string }): Promise<void>;
  clearMemberToken(): Promise<void>;
}

export function createMemoryAppSecurity(): AppSecurityBridge {
  let state: GateState = { lockedPendingWipe: false, pinRequired: false, pinUnlocked: false };
  let memberToken: string | null = null;

  return {
    async getGateState() {
      return { ...state };
    },
    async setGateState(update) {
      if (
        update.lockedPendingWipe === true ||
        (update.lockedPendingWipe === false && state.lockedPendingWipe)
      ) {
        memberToken = null;
      }
      state = {
        lockedPendingWipe: update.lockedPendingWipe ?? state.lockedPendingWipe,
        pinRequired: update.pinRequired ?? state.pinRequired,
        pinUnlocked: update.pinUnlocked ?? state.pinUnlocked,
      };
      if (state.lockedPendingWipe || !state.pinRequired) state.pinUnlocked = false;
      return { ...state };
    },
    async getMemberToken() {
      return { memberToken: state.lockedPendingWipe ? null : memberToken };
    },
    async setMemberToken(options) {
      if (state.lockedPendingWipe) throw new Error('The device is pending wipe');
      if (typeof options.memberToken !== 'string' || options.memberToken.trim() === '') {
        throw new Error('memberToken is required');
      }
      memberToken = options.memberToken;
    },
    async clearMemberToken() {
      memberToken = null;
    },
  };
}

export const appSecurity =
  Capacitor.getPlatform() === 'android'
    ? registerPlugin<AppSecurityBridge>('AppSecurity')
    : createMemoryAppSecurity();
