import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { RunResult, SqlDriver, SqlValue } from '../../src/db/types';

/**
 * Node 24 `node:sqlite` 测试驱动（只进测试，不进浏览器/Android 包）。
 *
 * 行为刻意贴近 Capacitor 原生驱动：
 * - 每条语句独立 prepare，不做语句缓存；
 * - 写语句不自行开事务（等价插件 `transaction: false`）；
 * - 外键与 WAL 显式打开；
 * - `busy_timeout` 用"失败后让出事件循环 + 重试"模拟：`node:sqlite` 是同步 API，真机 busy
 *   handler 在 native 线程阻塞等待，而同步等待会卡死本线程里的另一条连接，因此这里改成
 *   `timeout: 0` + `await sleep()` 重试，语义（等到超时或拿到锁）保持一致。
 */
export interface NodeSqliteDriverOptions {
  /** 数据库文件路径；`:memory:` 表示内存库。 */
  readonly path: string;
  /** 等锁总时长，默认 5000ms。 */
  readonly timeoutMs?: number;
  readonly enableForeignKeyConstraints?: boolean;
}

export interface NodeSqliteDriver extends SqlDriver {
  /** 显式实现，便于测试直接关闭。 */
  close(): Promise<void>;
  readonly path: string;
  readonly db: DatabaseSync;
  /** 测试用：检查 WAL 是否真的开启（文件库返回 wal）。 */
  journalMode(): string;
}

const BUSY_PATTERN = /busy|database is locked|SQLITE_BUSY/i;

function isBusy(error: unknown): boolean {
  return error instanceof Error && BUSY_PATTERN.test(error.message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createNodeSqliteDriver(options: NodeSqliteDriverOptions): NodeSqliteDriver {
  if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
  const timeoutMs = options.timeoutMs ?? 5000;
  const db = new DatabaseSync(options.path, {
    timeout: 0,
    enableForeignKeyConstraints: options.enableForeignKeyConstraints ?? true,
  });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  async function withBusyRetry<T>(operation: () => T): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        return operation();
      } catch (error) {
        if (!isBusy(error) || Date.now() >= deadline) throw error;
        await sleep(2);
      }
    }
  }

  return {
    kind: 'node:sqlite@24',
    path: options.path,
    db,
    journalMode() {
      const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
      return row?.journal_mode ?? '';
    },
    async query<T>(sql: string, values: readonly SqlValue[] = []): Promise<T[]> {
      return withBusyRetry(() => {
        const statement = db.prepare(sql);
        return statement.all(...normalize(values)) as T[];
      });
    },
    async run(sql: string, values: readonly SqlValue[] = []): Promise<RunResult> {
      return withBusyRetry(() => {
        const statement = db.prepare(sql);
        const result = statement.run(...normalize(values));
        return {
          changes: Number(result.changes),
          lastInsertRowid: Number(result.lastInsertRowid),
        };
      });
    },
    async exec(sql: string): Promise<void> {
      return withBusyRetry(() => {
        db.exec(sql);
      });
    },
    async close(): Promise<void> {
      if (db.isOpen) db.close();
    },
  };
}

function normalize(values: readonly SqlValue[]): (string | number | null)[] {
  return values.map((value) => (typeof value === 'boolean' ? (value ? 1 : 0) : value));
}

/** 生成临时库路径，测试结束时删除（Windows 上需容忍短暂文件锁）。 */
export function createTempDatabasePath(tag: string): { path: string; cleanup(): void } {
  const path = `${process.env.TEMP ?? '/tmp'}/dafan-db-test/${tag}-${randomUUID()}.db`;
  return {
    path,
    cleanup() {
      for (const suffix of ['', '-wal', '-shm']) {
        const target = path + suffix;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          try {
            rmSync(target, { force: true });
            break;
          } catch (error) {
            if (attempt === 19) throw error;
          }
        }
      }
    },
  };
}

/** 指纹：断言"同一 schema 两次建库完全一致"用。 */
export function schemaFingerprint(db: DatabaseSync): string {
  const rows = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
