/**
 * 离线库 schema 终态（SQLite）。
 *
 * 事实来源：
 * - `da-fan-xiao-guan@e778d3bd3354123032e570e03ad85c6b19bd9ea4` 的 `app/server/prisma/migrations/*`
 *   11 个迁移顺序执行后的 SQLite 结构（列、默认值、外键、索引）；
 * - `@dafan/shared` 的 `RETAINED_MODELS`（27 张业务表）与同步协议。
 *
 * 与上游终态的差异（端侧设计选择，均有明确原因）：
 * 1. 不建 `ConsumptionOperation` / `RecommendationHistory` / `DeletedItem` 三张已剔除表。
 * 2. 上游 `DeletedItem.planUncompleteProof` 记录"撤销计划完成"的 provenance；剔除回收站表后改落在
 *    `MealRecord.planUncompleteProof`：它是同一行的软删证据，随行恢复/清理，不需要跨表关联。
 * 3. 上游 `MealPlan` 的 `@@unique([planDate, mealType])` 与软删冲突（删除后同日餐次无法重建）；
 *    端侧改为 `WHERE deletedAt IS NULL` 的部分唯一索引。
 * 4. `MealPlan.id` 由 Prisma `cuid()` 改为 `lower(hex(randomblob(16)))`：32 位十六进制随机串，
 *    离线建计划不依赖服务端，也不需要引入 cuid 依赖。
 * 5. 上游 `Settings` 的 `pinEnabled` / `pinHash` / `userNickname` / `userAvatarPath` /
 *    `onboardingCompleted` 迁到私有端表 `device_local_config`；`Settings` 只保留可同步业务配置，
 *    PIN 哈希不进同步链。
 * 6. 新增 3 张私有端表：`device_local_config`（本机配置，严禁同步）、`sync_outbox`（发件箱，
 *    与业务写入同事务落库）、`sync_state`（拉取游标 + 本机 epoch）。
 */

import { BUSINESS_INDEX_DDL, BUSINESS_TABLE_DDL, RETAINED_MODELS } from '@dafan/shared/contracts';

/** schema 版本，写入 PRAGMA user_version。 */
export const SCHEMA_VERSION = 2;

/** 27 张业务表，与 shared RETAINED_MODELS 一致。 */
export const BUSINESS_TABLES: readonly string[] = RETAINED_MODELS;

/** 私有端表：只存在于本机，严禁同步。 */
export const LOCAL_TABLES = ['device_local_config', 'sync_outbox', 'sync_state'] as const;

export const DEVICE_LOCAL_CONFIG_TABLE = 'device_local_config';
export const SYNC_OUTBOX_TABLE = 'sync_outbox';
export const SYNC_STATE_TABLE = 'sync_state';

const OUTBOX_DDL = `CREATE TABLE "sync_outbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "opId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" TEXT NOT NULL CHECK ("kind" IN ('upsert', 'delete', 'command')),
    "commandType" TEXT,
    "baseVersion" INTEGER,
    "payloadJson" TEXT,
    "payloadHash" TEXT,
    "epoch" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending', 'inflight', 'dead')),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "sync_outbox_opId_key" UNIQUE ("opId")
  )`;

/** 私有端表 DDL：本机配置、发件箱、同步状态。 */
export const LOCAL_TABLE_DDL: readonly string[] = [
  `CREATE TABLE "device_local_config" (
    "id" INTEGER NOT NULL PRIMARY KEY CHECK ("id" = 1),
    "pinEnabled" BOOLEAN NOT NULL DEFAULT false,
    "pinHash" TEXT,
    "userNickname" TEXT,
    "userAvatarPath" TEXT,
    "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false,
    "cloudOrigin" TEXT,
    "householdId" TEXT,
    "memberId" TEXT,
    "role" TEXT,
    "bindingGeneration" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
  )`,
  OUTBOX_DDL,
  `CREATE TABLE "sync_state" (
    "id" INTEGER NOT NULL PRIMARY KEY CHECK ("id" = 1),
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "last_sync_seq" TEXT,
    "updatedAt" DATETIME NOT NULL
  )`,
];

/** 私有端表索引。 */
export const LOCAL_INDEX_DDL: readonly string[] = [
  `CREATE INDEX "sync_outbox_state_createdAt_idx" ON "sync_outbox" ("state", "createdAt")`,
  `CREATE INDEX "sync_outbox_entity_entityId_idx" ON "sync_outbox" ("entity", "entityId")`,
];

const V1_OUTBOX_COLUMNS = `"id", "opId", "entity", "entityId", "kind", "baseVersion", "payloadJson", "epoch", "state", "attemptCount", "lastError", "nextAttemptAt", "createdAt", "updatedAt"`;

export const MIGRATE_V1_TO_V2: readonly string[] = [
  `ALTER TABLE "sync_outbox" RENAME TO "sync_outbox_v1"`,
  OUTBOX_DDL,
  `INSERT INTO "sync_outbox" (${V1_OUTBOX_COLUMNS}) SELECT ${V1_OUTBOX_COLUMNS} FROM "sync_outbox_v1" ORDER BY rowid`,
  `DROP TABLE "sync_outbox_v1"`,
  ...LOCAL_INDEX_DDL,
];

/**
 * 27 张业务表建表语句：与 `@dafan/shared/contracts` 的同源 DDL 完全一致，
 * 端侧不再单独维护，避免端云结构漂移。
 */
export { BUSINESS_INDEX_DDL, BUSINESS_TABLE_DDL } from '@dafan/shared/contracts';

/** 建库顺序：业务表 → 业务索引 → 私有端表 → 私有端索引。 */
export const SCHEMA_DDL: readonly string[] = [
  ...BUSINESS_TABLE_DDL,
  ...BUSINESS_INDEX_DDL,
  ...LOCAL_TABLE_DDL,
  ...LOCAL_INDEX_DDL,
];
