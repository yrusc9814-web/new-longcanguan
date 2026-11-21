import type { DatabaseClient, WriteTransaction } from '../../db/database.js';
import { VersionConflictError } from '../../db/errors.js';
import { AsyncMutex } from '../../db/mutex.js';
import type { SqlValue } from '../../db/types.js';
import { LocalApiError } from '../../local-api/protocol.js';
import type { PinSession } from '../../native/pin-session.js';
import { requireVersion, sqlBoolean, validationError } from '../common.js';
import {
  createPinAuthorization,
  hashPin,
  invalidAuthorization,
  randomHex,
  requirePin,
} from './pin.js';

const DEFAULT_BRANDING = { appName: '搭饭小馆', subtitle: '让每一餐都更美好' };

interface SharedSettingsRow {
  id: number;
  appName: string;
  subtitle: string;
  defaultPort: number;
  autoBackupEnabled: boolean | number;
  autoDeductInventory: boolean | number;
  defaultRepeatDays: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface LocalSettingsRow {
  pinEnabled: boolean | number;
  pinHash: string | null;
  userNickname: string | null;
  userAvatarPath: string | null;
  onboardingCompleted: boolean | number;
}

async function sharedSettings(database: Pick<DatabaseClient, 'query'>): Promise<SharedSettingsRow> {
  const [row] = await database.query<SharedSettingsRow>('SELECT * FROM "Settings" WHERE "id" = 1');
  if (!row) throw new LocalApiError(503, 'DATABASE_ERROR', '本地设置尚未初始化');
  return row;
}

async function localSettings(database: Pick<DatabaseClient, 'query'>): Promise<LocalSettingsRow> {
  const [row] = await database.query<LocalSettingsRow>(
    `SELECT "pinEnabled", "pinHash", "userNickname", "userAvatarPath", "onboardingCompleted"
     FROM "device_local_config" WHERE "id" = 1`,
  );
  if (!row) throw new LocalApiError(503, 'DATABASE_ERROR', '本机设置尚未初始化');
  return row;
}

function sharedDto(row: SharedSettingsRow) {
  return {
    ...row,
    autoBackupEnabled: sqlBoolean(row.autoBackupEnabled),
    autoDeductInventory: sqlBoolean(row.autoDeductInventory),
  };
}

async function readSettings(database: Pick<DatabaseClient, 'query'>) {
  const [settings, local] = await Promise.all([sharedSettings(database), localSettings(database)]);
  return {
    ...sharedDto(settings),
    pinEnabled: sqlBoolean(local.pinEnabled),
    userNickname: local.userNickname,
    userAvatarPath: local.userAvatarPath,
    onboardingCompleted: sqlBoolean(local.onboardingCompleted),
  };
}

export async function readBranding(database: Pick<DatabaseClient, 'query'>) {
  const [row] = await database.query<typeof DEFAULT_BRANDING>(
    'SELECT "appName", "subtitle" FROM "Settings" WHERE "id" = 1',
  );
  return row ?? DEFAULT_BRANDING;
}

async function ensureSettings(database: DatabaseClient, now: () => Date) {
  const [settings] = await database.query<{ id: number }>(
    'SELECT "id" FROM "Settings" WHERE "id" = 1',
  );
  if (!settings) {
    await database.withWriteTransaction(async (tx) => {
      const stamp = now().toISOString();
      await tx.run(
        'INSERT OR IGNORE INTO "Settings" ("id", "createdAt", "updatedAt") VALUES (1, ?, ?)',
        [stamp, stamp],
      );
    });
  }
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw validationError(`${field} 必须是布尔值`);
  return value;
}

function parseSettings(body: Record<string, unknown>) {
  const shared: Record<string, SqlValue> = {};
  const local: Record<string, SqlValue> = {};
  for (const field of ['appName', 'subtitle'] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw validationError(`${field} 必须是字符串`);
    shared[field] = value;
  }
  for (const field of ['userNickname', 'userAvatarPath'] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'string')
      throw validationError(`${field} 必须是字符串或 null`);
    if (field === 'userAvatarPath' && value && /^(?:data|blob):/i.test(value.trim())) {
      throw validationError('头像必须使用图片路径');
    }
    local[field] = value;
  }
  for (const field of ['autoBackupEnabled', 'autoDeductInventory'] as const) {
    if (body[field] !== undefined) shared[field] = requireBoolean(body[field], field);
  }
  const onboarding = body.onboardingCompleted;
  if (onboarding !== undefined)
    local.onboardingCompleted = requireBoolean(onboarding, 'onboardingCompleted');
  for (const [field, min, max] of [
    ['defaultPort', 1, 65535],
    ['defaultRepeatDays', 0, 365],
  ] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw validationError(`${field} 必须是 ${min} 至 ${max} 的整数`);
    }
    shared[field] = value;
  }
  return { shared, local };
}

async function requireCurrentVersion(tx: WriteTransaction, expected: number) {
  const settings = await sharedSettings(tx);
  if (settings.version !== expected)
    throw new VersionConflictError('Settings', '1', expected, settings.version);
  return settings;
}

const unauthorized = () => new LocalApiError(401, 'UNAUTHORIZED', '需要有效的 PIN 解锁凭证');

export function createSettingsService(
  getDatabase: () => Promise<DatabaseClient>,
  session: PinSession,
  now = () => new Date(),
) {
  const authorization = createPinAuthorization(() => now().getTime());
  const pinChanges = new AsyncMutex();

  async function database() {
    const db = await getDatabase();
    await ensureSettings(db, now);
    return db;
  }

  function lockPin(required?: boolean) {
    authorization.clearGrants();
    return session.lock(required);
  }

  return {
    async initialize() {
      const db = await database();
      await lockPin(sqlBoolean((await localSettings(db)).pinEnabled));
    },
    lockPin,
    consumeHighRiskToken: authorization.consumeGrant,
    async read() {
      return readSettings(await database());
    },
    async update(body: Record<string, unknown>) {
      const version = requireVersion(body.version);
      const { shared, local } = parseSettings(body);
      const db = await database();
      return db.withWriteTransaction(async (tx) => {
        const current = sharedDto(await requireCurrentVersion(tx, version));
        const previous = current as Record<string, unknown>;
        const sharedChanges = Object.fromEntries(
          Object.entries(shared).filter(([field, value]) => previous[field] !== value),
        );
        if (Object.keys(sharedChanges).length) {
          await tx.updateVersioned({
            table: 'Settings',
            id: 1,
            expectedVersion: version,
            values: sharedChanges,
          });
          await tx.enqueue({
            opId: randomHex(16),
            entity: 'Settings',
            entityId: '1',
            baseVersion: version,
            kind: 'upsert',
            payload: sharedDto(await sharedSettings(tx)),
          });
        }
        if (Object.keys(local).length) {
          const fields = Object.keys(local)
            .map((field) => `"${field}" = ?`)
            .join(', ');
          await tx.run(
            `UPDATE "device_local_config" SET ${fields}, "updatedAt" = ? WHERE "id" = 1`,
            [...Object.values(local), now().toISOString()],
          );
        }
        return readSettings(tx);
      });
    },
    async updatePin(body: Record<string, unknown>, token: string | null) {
      const version = requireVersion(body.version);
      const enabled = requireBoolean(body.enabled, 'enabled');
      const pinHash = enabled ? await hashPin(requirePin(body.pin)) : null;
      const db = await database();
      return pinChanges.run(async () => {
        let closedBeforeCommit = false;
        let previousRequired = false;
        let result: Awaited<ReturnType<typeof readSettings>>;
        try {
          result = await db.withWriteTransaction(async (tx) => {
            await requireCurrentVersion(tx, version);
            previousRequired = sqlBoolean((await localSettings(tx)).pinEnabled);
            if (previousRequired && (!token || !(await session.isValid(token))))
              throw unauthorized();
            // Keep native images gated across the commit boundary in both directions.
            closedBeforeCommit = true;
            await lockPin(previousRequired || enabled);
            await tx.run(
              'UPDATE "device_local_config" SET "pinEnabled" = ?, "pinHash" = ?, "updatedAt" = ? WHERE "id" = 1',
              [enabled, pinHash, now().toISOString()],
            );
            return readSettings(tx);
          });
        } catch (error) {
          if (closedBeforeCommit) await lockPin(previousRequired);
          throw error;
        }
        if (!enabled) await lockPin(false);
        authorization.resetAttempts();
        return result;
      });
    },
    async sessionState(token: string | null) {
      const required = sqlBoolean((await localSettings(await database())).pinEnabled);
      if (required && (!token || !(await session.isValid(token)))) throw unauthorized();
      return { valid: true };
    },
    async verify(pin: unknown) {
      const db = await database();
      return db.withWriteTransaction(async (tx) => {
        const settings = await localSettings(tx);
        if (!sqlBoolean(settings.pinEnabled)) return { valid: true, required: false, token: null };
        if (!(await authorization.verify(pin, settings.pinHash))) {
          return { valid: false, required: true, token: null };
        }
        const token = randomHex(32);
        await session.unlockAfterVerification(token);
        return { valid: true, required: true, token };
      });
    },
    async authorize(body: Record<string, unknown>) {
      if (body.action !== 'RESTORE') throw validationError('高风险操作类型无效');
      const db = await database();
      return db.withWriteTransaction(async (tx) => {
        const settings = await localSettings(tx);
        if (sqlBoolean(settings.pinEnabled)) {
          if (!(await authorization.verify(body.pin, settings.pinHash)))
            throw invalidAuthorization();
        } else {
          if (body.challenge === undefined || body.challenge === null)
            return authorization.challenge();
          authorization.confirm(body.challenge, body.confirmation);
        }
        return authorization.grant();
      });
    },
  };
}

export type SettingsService = ReturnType<typeof createSettingsService>;
