import type { CloudFailure } from './http';

type AttemptScope = 'owner' | 'join';

const FAILURE_LIMIT = 5;
const COOLDOWN_MS = 60_000;
const UNAUTHORIZED = { code: 'UNAUTHORIZED', status: 401 } as const;

function cooldown(expiresAt: number, now: number): CloudFailure {
  return {
    code: 'RATE_LIMITED',
    status: 429,
    retryAfter: Math.ceil((expiresAt - now) / 1000),
  };
}

export class AuthAttempts {
  readonly #sql: SqlStorage;
  readonly #scope: AttemptScope;
  readonly #source: string;

  constructor(sql: SqlStorage, scope: AttemptScope, headers: Headers) {
    this.#sql = sql;
    this.#scope = scope;
    // The public Cloudflare ingress supplies this header. Missing addresses share a bucket.
    this.#source = headers.get('cf-connecting-ip')?.slice(0, 45) || '';
  }

  blocked(now: number): CloudFailure | undefined {
    const attempt = this.#sql
      .exec<{ expires_at: number }>(
        `SELECT expires_at FROM household_auth_attempts
         WHERE scope = ? AND source = ? AND failures >= ? AND expires_at > ?`,
        this.#scope,
        this.#source,
        FAILURE_LIMIT,
        now,
      )
      .toArray()[0];
    return attempt && cooldown(attempt.expires_at, now);
  }

  // Record failures in the same transaction as the credential check's outcome.
  fail(now: number): CloudFailure {
    this.#sql.exec('DELETE FROM household_auth_attempts WHERE expires_at <= ?', now);
    const expiresAt = now + COOLDOWN_MS;
    const { failures } = this.#sql
      .exec<{ failures: number }>(
        `INSERT INTO household_auth_attempts (scope, source, failures, expires_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT (scope, source) DO UPDATE SET
           failures = failures + 1,
           expires_at = CASE WHEN failures + 1 >= ? THEN excluded.expires_at ELSE expires_at END
         RETURNING failures`,
        this.#scope,
        this.#source,
        expiresAt,
        FAILURE_LIMIT,
      )
      .one();
    return failures >= FAILURE_LIMIT ? cooldown(expiresAt, now) : UNAUTHORIZED;
  }

  clear(): void {
    this.#sql.exec(
      'DELETE FROM household_auth_attempts WHERE scope = ? AND source = ?',
      this.#scope,
      this.#source,
    );
  }
}
