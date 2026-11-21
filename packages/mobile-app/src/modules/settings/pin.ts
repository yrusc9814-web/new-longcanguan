import { LocalApiError } from '../../local-api/protocol.js';
import { pinAttemptsExceeded } from '../../local-api/router.js';

const PIN_ITERATIONS = 600_000;
const LOCKOUT_MS = 30_000;
const GRANT_MS = 5 * 60_000;
const CHALLENGE_MS = 2 * 60_000;

export function randomHex(length: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function derive(pin: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: PIN_ITERATIONS },
    key,
    256,
  );
  return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function requirePin(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4,8}$/.test(value)) {
    throw new LocalApiError(422, 'PIN_INVALID', '请输入 4～8 位数字 PIN');
  }
  return value;
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomHex(16);
  return `pbkdf2-sha256:${salt}:${await derive(pin, salt)}`;
}

async function matches(pin: string, hash: string | null): Promise<boolean> {
  const [, salt, expected] = /^pbkdf2-sha256:([a-f0-9]{32}):([a-f0-9]{64})$/.exec(hash ?? '') ?? [];
  if (!salt || !expected) return false;
  const actual = await derive(pin, salt);
  let diff = 0;
  for (let index = 0; index < expected.length; index++) {
    diff |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}

export const invalidAuthorization = () =>
  new LocalApiError(401, 'HIGH_RISK_AUTHORIZATION_INVALID', '恢复授权无效或已过期');

export function createPinAuthorization(now: () => number) {
  const challenges = new Map<string, number>();
  const grants = new Map<string, number>();
  let failures = 0;
  let attemptsExpireAt = 0;

  function issue(pool: Map<string, number>, lifetime: number): [string, string] {
    const current = now();
    for (const [key, expiry] of pool) if (expiry <= current) pool.delete(key);
    const key = randomHex(32);
    const expiry = current + lifetime;
    pool.set(key, expiry);
    return [key, new Date(expiry).toISOString()];
  }

  function consume(pool: Map<string, number>, key: unknown) {
    if (typeof key !== 'string') throw invalidAuthorization();
    const expiry = pool.get(key);
    pool.delete(key);
    if (expiry === undefined || expiry <= now()) throw invalidAuthorization();
  }

  return {
    async verify(pin: unknown, hash: string | null) {
      const current = now();
      if (attemptsExpireAt <= current) failures = 0;
      if (failures >= 5) throw pinAttemptsExceeded(Math.ceil((attemptsExpireAt - current) / 1000));
      if (await matches(requirePin(pin), hash)) {
        failures = 0;
        return true;
      }
      failures += 1;
      attemptsExpireAt = now() + LOCKOUT_MS;
      return false;
    },
    challenge() {
      const [challenge, expiresAt] = issue(challenges, CHALLENGE_MS);
      return { action: 'RESTORE', challenge, expiresAt, requiresConfirmation: true };
    },
    confirm(challenge: unknown, confirmation: unknown) {
      consume(challenges, challenge);
      if (confirmation !== 'RESTORE_LOCAL_DATA') throw invalidAuthorization();
    },
    grant() {
      const [token, expiresAt] = issue(grants, GRANT_MS);
      return { action: 'RESTORE', token, expiresAt };
    },
    consumeGrant(token: string | null) {
      consume(grants, token);
    },
    clearGrants() {
      challenges.clear();
      grants.clear();
    },
    resetAttempts() {
      failures = 0;
      attemptsExpireAt = 0;
    },
  };
}
