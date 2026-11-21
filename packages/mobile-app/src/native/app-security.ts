import { Capacitor, registerPlugin } from '@capacitor/core';

export interface GateState {
  lockedPendingWipe: boolean;
  pinRequired: boolean;
  pinUnlocked: boolean;
}

export type GateUpdate = Partial<GateState> & { pinExpiresAt?: number };

export interface AppSecurityBridge {
  getGateState(): Promise<GateState>;
  setGateState(update: GateUpdate): Promise<GateState>;
  getMemberToken(): Promise<{ memberToken: string | null }>;
  setMemberToken(options: { memberToken: string }): Promise<void>;
  clearMemberToken(): Promise<void>;
}

export function createMemoryAppSecurity(now = Date.now): AppSecurityBridge {
  let state: GateState = { lockedPendingWipe: false, pinRequired: false, pinUnlocked: false };
  let memberToken: string | null = null;
  let pinExpiresAt = 0;

  function readState() {
    if (pinExpiresAt > 0 && pinExpiresAt <= now()) state.pinUnlocked = false;
    return { ...state };
  }

  return {
    async getGateState() {
      return readState();
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
      pinExpiresAt = state.pinUnlocked ? (update.pinExpiresAt ?? pinExpiresAt) : 0;
      return readState();
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
