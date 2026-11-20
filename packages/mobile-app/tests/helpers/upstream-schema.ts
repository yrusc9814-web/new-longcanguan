import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface UpstreamColumn {
  name: string;
  type: string;
  notnull: boolean;
  default: string | null;
  pk: number;
}

export interface UpstreamTable {
  columns: UpstreamColumn[];
  foreignKeys: string[];
}

export interface UpstreamIndex {
  name: string;
  table: string;
  unique: boolean;
  columns: string[];
}

export interface UpstreamSchema {
  commit: string;
  tables: Record<string, UpstreamTable>;
  indexes: UpstreamIndex[];
}

/**
 * `da-fan-xiao-guan@e778d3b` 11 个 Prisma 迁移执行后的 SQLite 结构快照，
 * 由 `node:sqlite` 顺序执行迁移生成（非手写）。
 */
export function loadUpstreamSchema(): UpstreamSchema {
  const path = resolve(import.meta.dirname, '../fixtures/upstream-schema-e778d3b.json');
  return JSON.parse(readFileSync(path, 'utf8')) as UpstreamSchema;
}

export function tableColumns(db: DatabaseSync, table: string): UpstreamColumn[] {
  return db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((c) => ({
      name: String(c.name),
      type: String(c.type),
      notnull: c.notnull === 1,
      default: c.dflt_value === null ? null : String(c.dflt_value),
      pk: Number(c.pk),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function tableForeignKeys(db: DatabaseSync, table: string): string[] {
  return db
    .prepare(`PRAGMA foreign_key_list("${table}")`)
    .all()
    .map((f) => `${f.from}->${f.table}.${f.to}[${f.on_delete}/${f.on_update}]`)
    .sort();
}

export function tableIndexes(db: DatabaseSync, table: string): UpstreamIndex[] {
  return db
    .prepare(`PRAGMA index_list("${table}")`)
    .all()
    .filter((r) => !String(r.name).startsWith('sqlite_autoindex'))
    .map((r) => {
      const columns = db
        .prepare(`PRAGMA index_info("${r.name}")`)
        .all()
        .sort((a, b) => Number(a.seqno) - Number(b.seqno))
        .map((c) => String(c.name));
      return {
        name: String(r.name),
        table,
        unique: r.unique === 1,
        columns,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
