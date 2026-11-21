import { CapacitorSQLite } from '@capacitor-community/sqlite';
import { Capacitor } from '@capacitor/core';
import { openCapacitorDatabase } from '../db/index.js';
import { recoverBackupFiles } from '../modules/backup/service.js';
import { createSettingsService } from '../modules/settings/service.js';
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

const settings = createSettingsService(getDatabase, pinSession);
let initialGate: Promise<void> | undefined;

function initializeGate() {
  initialGate ??= (async () => {
    // Android images stay locked until SQLite confirms the device's persisted PIN policy.
    if (isAndroid) await pinSession.lock(true);
    else await pinSession.lock();
    if (isAndroid && !(await appSecurity.getGateState()).lockedPendingWipe) {
      await recoverBackupFiles(await getDatabase());
      await settings.initialize();
    }
  })().catch((error: unknown) => {
    initialGate = undefined;
    throw error;
  });
  return initialGate;
}

export const localApi = createLocalApiRouter({
  async readGateState() {
    await initializeGate();
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

registerDomainRoutes(localApi, getDatabase, settings);
void initializeGate().catch(() => undefined);

// Install the local fetch before the deferred Google2 adapter executes.
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = createLocalApiFetch({ router: localApi, nativeFetch });
