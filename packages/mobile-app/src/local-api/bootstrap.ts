import { CapacitorSQLite } from '@capacitor-community/sqlite';
import { Capacitor } from '@capacitor/core';
import { openCapacitorDatabase } from '../db/index.js';
import { appSecurity } from '../native/app-security.js';
import { createPinSession } from '../native/pin-session.js';
import { registerDomainRoutes } from './domains.js';
import { createLocalApiFetch, createLocalApiRouter } from './router.js';

const isAndroid = Capacitor.getPlatform() === 'android';
let database: ReturnType<typeof openCapacitorDatabase> | undefined;

export function getDatabase() {
  database ??= openCapacitorDatabase({ plugin: CapacitorSQLite }).catch((error: unknown) => {
    database = undefined;
    throw error;
  });
  return database;
}

export const pinSession = createPinSession(appSecurity);

// A new WebView session has no verified PIN token in memory.
const initialGate = pinSession.lock().catch(() => undefined);

export const localApi = createLocalApiRouter({
  async readGateState() {
    await initialGate;
    const { lockedPendingWipe, pinRequired } = await appSecurity.getGateState();
    return { pendingWipe: lockedPendingWipe, pinRequired };
  },
  isPinTokenValid: pinSession.isValid,
  async healthDatabaseProbe() {
    if (!isAndroid) return { status: 'error' };
    const db = await getDatabase();
    const [result] = await db.query<{ ready: number }>('SELECT 1 AS ready');
    return { status: result?.ready === 1 ? 'ok' : 'error' };
  },
});

registerDomainRoutes(localApi, getDatabase);

// Install the local fetch before the deferred Google2 adapter executes.
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = createLocalApiFetch({ router: localApi, nativeFetch });
