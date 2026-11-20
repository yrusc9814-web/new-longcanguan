import { DatabaseSync } from 'node:sqlite';

import type { CapacitorSqlitePluginLike } from '../../src/db/capacitor-driver';
import type { SqlValue } from '../../src/db/types';

const bind = (values: readonly SqlValue[]) =>
  values.map((value) => (typeof value === 'boolean' ? (value ? 1 : 0) : value));

/**
 * `@capacitor-community/sqlite@7.0.3` 插件契约的 Node 侧替身：
 * 用真实 `node:sqlite` 执行 SQL，同时记录每次调用的参数，供测试断言驱动实际怎么调用插件。
 *
 * 只用于测试，不进入浏览器/Android 包。
 */
export interface PluginCall {
  readonly method: 'createConnection' | 'open' | 'closeConnection' | 'execute' | 'run' | 'query';
  readonly options: Record<string, unknown>;
}

export interface FakeCapacitorPlugin extends CapacitorSqlitePluginLike {
  readonly calls: PluginCall[];
  readonly db: DatabaseSync;
}

export function createFakeCapacitorPlugin(path = ':memory:'): FakeCapacitorPlugin {
  const db = new DatabaseSync(path, { timeout: 5000, enableForeignKeyConstraints: true });
  db.exec('PRAGMA foreign_keys = ON');
  const calls: PluginCall[] = [];
  const record = (method: PluginCall['method'], options: Record<string, unknown>) => {
    calls.push({ method, options });
  };

  return {
    db,
    calls,
    async createConnection(options) {
      record('createConnection', options);
    },
    async open(options) {
      record('open', options);
    },
    async closeConnection(options) {
      record('closeConnection', options);
      db.close();
    },
    async execute(options) {
      record('execute', options);
      db.exec(options.statements);
      const changes = db.prepare('SELECT changes() AS c').get() as { c?: number } | undefined;
      return { changes: { changes: Number(changes?.c ?? 0) } };
    },
    async run(options) {
      record('run', options);
      const statement = db.prepare(options.statement);
      const result = statement.run(...bind(options.values));
      return {
        changes: { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) },
      };
    },
    async query(options) {
      record('query', options);
      const statement = db.prepare(options.statement);
      const rows = statement.all(...bind(options.values));
      // An in-memory Node database reports 'memory'; the on-device file database reports 'wal'.
      if (path === ':memory:' && options.statement === 'PRAGMA journal_mode = WAL') {
        return { values: [{ journal_mode: 'wal' }] };
      }
      return { values: rows };
    },
  };
}
