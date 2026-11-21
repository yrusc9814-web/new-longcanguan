/**
 * `HouseholdHub` 权威库 schema 迁移器。
 *
 * 结构 = 27 张端云同源业务表与索引（`@dafan/shared/contracts` 逐字共享）
 * + 6 张云端控制表（单家庭单例、成员、邀请、同步日志、幂等操作、图片对象）。
 *
 * 幂等约束：本函数在 DO 每次实例化（`blockConcurrencyWhile`）时执行一次，
 * 所有 DDL 以 `IF NOT EXISTS` 重放；种子数据以 `ON CONFLICT DO NOTHING` 预置，
 * 绝不覆盖既有家庭数据、版本号或已登记成员。
 */

import { BUSINESS_INDEX_DDL, BUSINESS_TABLE_DDL } from '@dafan/shared/contracts';
import { SHOPPING_DEFAULT_LIST_ID, SHOPPING_DEFAULT_LIST_NAME } from '@dafan/shared/sync';

export const HOUSEHOLD_ID = 'default';

const CONTROL_TABLE_DDL: readonly string[] = [
  `CREATE TABLE "household_meta" (
    "id" INTEGER NOT NULL PRIMARY KEY CHECK ("id" = 1),
    "household_id" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL DEFAULT 1,
    "initialized" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
  )`,
  `CREATE TABLE "household_members" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nickname" TEXT NOT NULL,
    "role" TEXT NOT NULL CHECK ("role" IN ('OWNER', 'MEMBER')),
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'REVOKED')),
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" DATETIME,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "household_members_token_hash_key" UNIQUE ("token_hash")
  )`,
  `CREATE TABLE "household_invites" (
    "code_hash" TEXT NOT NULL PRIMARY KEY,
    "created_by" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "used_by_member_id" TEXT,
    "used_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE "sync_log" (
    "epoch" INTEGER NOT NULL,
    "sync_seq" INTEGER NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payload_json" TEXT,
    "deleted_at" DATETIME,
    "actor_member_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("epoch", "sync_seq")
  )`,
  `CREATE TABLE "executed_operations" (
    "epoch" INTEGER NOT NULL,
    "operation_id" TEXT NOT NULL,
    "actor_member_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "command_type" TEXT,
    "payload_hash" TEXT NOT NULL,
    "result_json" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("epoch", "operation_id")
  )`,
  `CREATE TABLE "image_objects" (
    "asset_sha256" TEXT NOT NULL,
    "variant" TEXT NOT NULL CHECK ("variant" IN ('main', 'thumb')),
    "object_key" TEXT NOT NULL,
    "content_sha256" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "epoch" INTEGER NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("asset_sha256", "variant"),
    CONSTRAINT "image_objects_object_key_key" UNIQUE ("object_key")
  )`,
];

const HOUSEHOLD_SCHEMA_DDL = [
  ...BUSINESS_TABLE_DDL,
  ...BUSINESS_INDEX_DDL,
  ...CONTROL_TABLE_DDL,
  `CREATE INDEX "sync_log_epoch_sync_seq_idx" ON "sync_log" ("epoch", "sync_seq")`,
];

/**
 * 把 `CREATE TABLE "X"` / `CREATE INDEX "X"` 改写为 `IF NOT EXISTS` 版本。
 *
 * SQLite 落库时会去掉 `IF NOT EXISTS`，因此 `sqlite_master.sql` 与
 * `@dafan/shared/contracts` 的原文保持逐字一致，可用于端云零漂移断言。
 */
function withIfNotExists(ddl: string): string {
  return ddl
    .replace(/^CREATE TABLE\b(?! IF NOT EXISTS)/, 'CREATE TABLE IF NOT EXISTS')
    .replace(
      /^CREATE (UNIQUE )?INDEX\b(?! IF NOT EXISTS)/,
      (_match, unique: string | undefined) => `CREATE ${unique ?? ''}INDEX IF NOT EXISTS`,
    );
}

/**
 * 幂等建库：27 张业务表 + 全部业务索引 + 6 张控制表 + 控制索引，
 * 并预置 `household_meta(id = 1, epoch = 1, initialized = false)`、
 * `Settings(id = 1, version = 1)`、默认购物清单。
 *
 * 在 DO `blockConcurrencyWhile` 内调用；函数自身用 `storage.transactionSync`
 * 保证 DDL 与种子同一事务提交。
 */
export function migrateHousehold(storage: DurableObjectStorage): void {
  const timestamp = new Date().toISOString();
  const { sql } = storage;
  storage.transactionSync(() => {
    for (const ddl of HOUSEHOLD_SCHEMA_DDL) sql.exec(withIfNotExists(ddl));
    sql.exec(
      `INSERT INTO household_meta (id, household_id, created_at, updated_at)
       VALUES (1, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      HOUSEHOLD_ID,
      timestamp,
      timestamp,
    );
    sql.exec(
      `INSERT INTO "Settings" ("id", "version", "createdAt", "updatedAt")
       VALUES (1, 1, ?, ?) ON CONFLICT ("id") DO NOTHING`,
      timestamp,
      timestamp,
    );
    sql.exec(
      `INSERT INTO "ShoppingList" ("id", "name", "status", "version", "createdAt", "updatedAt")
       VALUES (?, ?, 'ACTIVE', 1, ?, ?) ON CONFLICT ("id") DO NOTHING`,
      SHOPPING_DEFAULT_LIST_ID,
      SHOPPING_DEFAULT_LIST_NAME,
      timestamp,
      timestamp,
    );
  });
}
