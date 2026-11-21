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

import { RETAINED_MODELS } from '@dafan/shared/contracts';

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

/** 27 张业务表建表语句。 */
export const BUSINESS_TABLE_DDL: readonly string[] = [
  `CREATE TABLE "Settings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "appName" TEXT NOT NULL DEFAULT '搭饭小馆',
    "subtitle" TEXT NOT NULL DEFAULT '让每一餐都更美好',
    "defaultPort" INTEGER NOT NULL DEFAULT 8787,
    "autoBackupEnabled" BOOLEAN NOT NULL DEFAULT true,
    "autoDeductInventory" BOOLEAN NOT NULL DEFAULT false,
    "defaultRepeatDays" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`,
  `CREATE TABLE "Diner" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "avatarPath" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "likesText" TEXT,
    "dislikesText" TEXT,
    "tabooText" TEXT,
    "allergyText" TEXT,
    "portionNote" TEXT,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`,
  `CREATE TABLE "Ingredient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "imagePath" TEXT,
    "category" TEXT,
    "quantity" REAL NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'OTHER',
    "purchaseDate" TEXT,
    "expiryDate" TEXT,
    "location" TEXT,
    "minStock" REAL,
    "maxStock" REAL,
    "opened" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`,
  `CREATE TABLE "InventoryBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ingredientId" TEXT NOT NULL,
    "quantity" REAL NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL,
    "purchaseDate" TEXT,
    "expiryDate" TEXT,
    "location" TEXT,
    "opened" BOOLEAN NOT NULL DEFAULT false,
    "consumePriority" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InventoryBatch_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE TABLE "InventoryLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ingredientId" TEXT,
    "ingredientNameSnapshot" TEXT NOT NULL,
    "inventoryBatchId" TEXT,
    "beforeQuantity" REAL NOT NULL,
    "changeQuantity" REAL NOT NULL,
    "afterQuantity" REAL NOT NULL,
    "unit" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "relatedPlanId" TEXT,
    "relatedRecordId" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InventoryLog_relatedRecordId_fkey" FOREIGN KEY ("relatedRecordId") REFERENCES "MealRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "InventoryLog_relatedPlanId_fkey" FOREIGN KEY ("relatedPlanId") REFERENCES "MealPlan" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "InventoryLog_inventoryBatchId_fkey" FOREIGN KEY ("inventoryBatchId") REFERENCES "InventoryBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "InventoryLog_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient" ("id") ON DELETE SET NULL ON UPDATE CASCADE
  )`,
  `CREATE TABLE "KitchenTool" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "imagePath" TEXT,
    "icon" TEXT,
    "category" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`,
  `CREATE TABLE "MealPlan" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    "planDate" TEXT NOT NULL,
    "mealType" TEXT NOT NULL,
    "dinerCount" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'UNPLANNED',
    "notes" TEXT,
    "time" TEXT,
    "title" TEXT,
    "subtext" TEXT,
    "icon" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "completedAt" DATETIME,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`,
  `CREATE TABLE "MealPlanDiner" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mealPlanId" TEXT NOT NULL,
    "dinerId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MealPlanDiner_dinerId_fkey" FOREIGN KEY ("dinerId") REFERENCES "Diner" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MealPlanDiner_mealPlanId_fkey" FOREIGN KEY ("mealPlanId") REFERENCES "MealPlan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE TABLE "MealPlanItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mealPlanId" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "mealRole" TEXT,
    "recipeId" TEXT,
    "storeId" TEXT,
    "customName" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MealPlanItem_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MealPlanItem_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MealPlanItem_mealPlanId_fkey" FOREIGN KEY ("mealPlanId") REFERENCES "MealPlan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE TABLE "MealRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recordDate" TEXT NOT NULL,
    "recordTime" TEXT,
    "mealType" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "imagePath" TEXT,
    "photosJson" TEXT,
    "rating" REAL,
    "satiety" INTEGER,
    "calories" INTEGER,
    "cost" INTEGER,
    "isNewTry" BOOLEAN NOT NULL DEFAULT false,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "relatedPlanId" TEXT,
    "sourceMealPlanId" TEXT,
    "confirmedAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" DATETIME,
    "planUncompleteProof" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MealRecord_sourceMealPlanId_fkey" FOREIGN KEY ("sourceMealPlanId") REFERENCES "MealPlan" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MealRecord_relatedPlanId_fkey" FOREIGN KEY ("relatedPlanId") REFERENCES "MealPlan" ("id") ON DELETE SET NULL ON UPDATE CASCADE
  )`,
  `CREATE TABLE "MealRecordDiner" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mealRecordId" TEXT NOT NULL,
    "dinerId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MealRecordDiner_dinerId_fkey" FOREIGN KEY ("dinerId") REFERENCES "Diner" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MealRecordDiner_mealRecordId_fkey" FOREIGN KEY ("mealRecordId") REFERENCES "MealRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE TABLE "MealRecordItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mealRecordId" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "mealRole" TEXT,
    "recipeId" TEXT,
    "storeId" TEXT,
    "customName" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MealRecordItem_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MealRecordItem_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MealRecordItem_mealRecordId_fkey" FOREIGN KEY ("mealRecordId") REFERENCES "MealRecord" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE TABLE "Recipe" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "imagePath" TEXT,
    "ingredientsText" TEXT,
    "cookingTimeMinutes" INTEGER,
    "difficulty" TEXT,
    "spicyLevel" INTEGER,
    "servings" INTEGER,
    "calories" INTEGER,
    "sourceNote" TEXT,
    "notes" TEXT,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "enabledForRecommendation" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`,
  `CREATE TABLE "RecipeIngredient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipeId" TEXT NOT NULL,
    "ingredientId" TEXT,
    "ingredientNameSnapshot" TEXT NOT NULL,
    "quantity" REAL,
    "unit" TEXT,
    "amountText" TEXT,
    "optional" BOOLEAN NOT NULL DEFAULT false,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RecipeIngredient_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "RecipeIngredient_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE TABLE "RecipeMealRole" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipeId" TEXT NOT NULL,
    "mealRole" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RecipeMealRole_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE TABLE "RecipeMealType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipeId" TEXT NOT NULL,
    "mealType" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RecipeMealType_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE TABLE "RecipeStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipeId" TEXT NOT NULL,
    "stepNo" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "title" TEXT,
    "timerMinutes" INTEGER,
    "imagePath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RecipeStep_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE TABLE "RecipeTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipeId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RecipeTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RecipeTag_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE TABLE "RecipeTool" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipeId" TEXT NOT NULL,
    "toolId" TEXT,
    "toolNameSnapshot" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RecipeTool_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "KitchenTool" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "RecipeTool_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE TABLE "ShoppingCheckinOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shoppingListId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "resultJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE "ShoppingList" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`,
  `CREATE TABLE "ShoppingListItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shoppingListId" TEXT NOT NULL,
    "ingredientId" TEXT,
    "ingredientNameSnapshot" TEXT NOT NULL,
    "quantity" REAL,
    "unit" TEXT,
    "amountText" TEXT,
    "category" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ShoppingListItem_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ShoppingListItem_shoppingListId_fkey" FOREIGN KEY ("shoppingListId") REFERENCES "ShoppingList" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE TABLE "Store" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "imagePath" TEXT,
    "address" TEXT,
    "storeType" TEXT,
    "cuisine" TEXT,
    "averageCost" REAL,
    "supportsDineIn" BOOLEAN NOT NULL DEFAULT false,
    "supportsTakeout" BOOLEAN NOT NULL DEFAULT false,
    "contact" TEXT,
    "businessHours" TEXT,
    "rating" REAL,
    "recommendedDishes" TEXT,
    "avoidDishes" TEXT,
    "tagsText" TEXT,
    "notes" TEXT,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`,
  `CREATE TABLE "StoreMealType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "mealType" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StoreMealType_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE TABLE "StoreMenuItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" INTEGER,
    "icon" TEXT,
    "isSignature" BOOLEAN NOT NULL DEFAULT false,
    "desc" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "StoreMenuItem_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
  )`,
  `CREATE TABLE "Tag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'GENERAL',
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
  )`,
  `CREATE TABLE "UploadAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "thumbnailPath" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "recipeId" TEXT,
    "storeId" TEXT,
    "mealRecordId" TEXT,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UploadAsset_mealRecordId_fkey" FOREIGN KEY ("mealRecordId") REFERENCES "MealRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "UploadAsset_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "UploadAsset_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE SET NULL ON UPDATE CASCADE
  )`,
];

/** 业务表索引（含 MealPlan active 部分唯一索引）。 */
export const BUSINESS_INDEX_DDL: readonly string[] = [
  'CREATE INDEX "Diner_active_idx" ON "Diner" ("active")',
  'CREATE INDEX "Diner_name_idx" ON "Diner" ("name")',
  'CREATE INDEX "Ingredient_category_idx" ON "Ingredient" ("category")',
  'CREATE INDEX "Ingredient_deletedAt_idx" ON "Ingredient" ("deletedAt")',
  'CREATE INDEX "Ingredient_expiryDate_idx" ON "Ingredient" ("expiryDate")',
  'CREATE INDEX "Ingredient_name_idx" ON "Ingredient" ("name")',
  'CREATE INDEX "InventoryBatch_consumePriority_idx" ON "InventoryBatch" ("consumePriority")',
  'CREATE INDEX "InventoryBatch_expiryDate_idx" ON "InventoryBatch" ("expiryDate")',
  'CREATE INDEX "InventoryBatch_ingredientId_deletedAt_idx" ON "InventoryBatch" ("ingredientId", "deletedAt")',
  'CREATE INDEX "InventoryLog_ingredientId_createdAt_idx" ON "InventoryLog" ("ingredientId", "createdAt")',
  'CREATE INDEX "InventoryLog_inventoryBatchId_createdAt_idx" ON "InventoryLog" ("inventoryBatchId", "createdAt")',
  'CREATE INDEX "InventoryLog_relatedPlanId_idx" ON "InventoryLog" ("relatedPlanId")',
  'CREATE INDEX "InventoryLog_relatedRecordId_idx" ON "InventoryLog" ("relatedRecordId")',
  'CREATE INDEX "KitchenTool_deletedAt_idx" ON "KitchenTool" ("deletedAt")',
  'CREATE INDEX "KitchenTool_name_idx" ON "KitchenTool" ("name")',
  'CREATE INDEX "MealPlan_deletedAt_idx" ON "MealPlan" ("deletedAt")',
  'CREATE INDEX "MealPlan_planDate_idx" ON "MealPlan" ("planDate")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "MealPlan_planDate_mealType_active_idx" ON "MealPlan"("planDate", "mealType") WHERE "deletedAt" IS NULL',
  'CREATE INDEX "MealPlan_status_idx" ON "MealPlan" ("status")',
  'CREATE INDEX "MealPlanDiner_dinerId_idx" ON "MealPlanDiner" ("dinerId")',
  'CREATE UNIQUE INDEX "MealPlanDiner_mealPlanId_dinerId_key" ON "MealPlanDiner" ("mealPlanId", "dinerId")',
  'CREATE INDEX "MealPlanItem_mealPlanId_sortOrder_idx" ON "MealPlanItem" ("mealPlanId", "sortOrder")',
  'CREATE INDEX "MealPlanItem_recipeId_idx" ON "MealPlanItem" ("recipeId")',
  'CREATE INDEX "MealPlanItem_storeId_idx" ON "MealPlanItem" ("storeId")',
  'CREATE INDEX "MealRecord_deletedAt_idx" ON "MealRecord" ("deletedAt")',
  'CREATE INDEX "MealRecord_mealType_recordDate_idx" ON "MealRecord" ("mealType", "recordDate")',
  'CREATE INDEX "MealRecord_recordDate_idx" ON "MealRecord" ("recordDate")',
  'CREATE UNIQUE INDEX "MealRecord_sourceMealPlanId_key" ON "MealRecord" ("sourceMealPlanId")',
  'CREATE INDEX "MealRecord_status_recordDate_idx" ON "MealRecord" ("status", "recordDate")',
  'CREATE INDEX "MealRecordDiner_dinerId_idx" ON "MealRecordDiner" ("dinerId")',
  'CREATE UNIQUE INDEX "MealRecordDiner_mealRecordId_dinerId_key" ON "MealRecordDiner" ("mealRecordId", "dinerId")',
  'CREATE INDEX "MealRecordItem_mealRecordId_sortOrder_idx" ON "MealRecordItem" ("mealRecordId", "sortOrder")',
  'CREATE INDEX "MealRecordItem_recipeId_idx" ON "MealRecordItem" ("recipeId")',
  'CREATE INDEX "MealRecordItem_storeId_idx" ON "MealRecordItem" ("storeId")',
  'CREATE INDEX "Recipe_deletedAt_idx" ON "Recipe" ("deletedAt")',
  'CREATE INDEX "Recipe_favorite_idx" ON "Recipe" ("favorite")',
  'CREATE INDEX "Recipe_name_idx" ON "Recipe" ("name")',
  'CREATE INDEX "RecipeIngredient_ingredientId_idx" ON "RecipeIngredient" ("ingredientId")',
  'CREATE INDEX "RecipeIngredient_recipeId_sortOrder_idx" ON "RecipeIngredient" ("recipeId", "sortOrder")',
  'CREATE INDEX "RecipeMealRole_mealRole_idx" ON "RecipeMealRole" ("mealRole")',
  'CREATE UNIQUE INDEX "RecipeMealRole_recipeId_mealRole_key" ON "RecipeMealRole" ("recipeId", "mealRole")',
  'CREATE INDEX "RecipeMealType_mealType_idx" ON "RecipeMealType" ("mealType")',
  'CREATE UNIQUE INDEX "RecipeMealType_recipeId_mealType_key" ON "RecipeMealType" ("recipeId", "mealType")',
  'CREATE INDEX "RecipeStep_recipeId_stepNo_idx" ON "RecipeStep" ("recipeId", "stepNo")',
  'CREATE UNIQUE INDEX "RecipeStep_recipeId_stepNo_key" ON "RecipeStep" ("recipeId", "stepNo")',
  'CREATE UNIQUE INDEX "RecipeTag_recipeId_tagId_key" ON "RecipeTag" ("recipeId", "tagId")',
  'CREATE INDEX "RecipeTag_tagId_idx" ON "RecipeTag" ("tagId")',
  'CREATE INDEX "RecipeTool_recipeId_idx" ON "RecipeTool" ("recipeId")',
  'CREATE INDEX "RecipeTool_toolId_idx" ON "RecipeTool" ("toolId")',
  'CREATE INDEX "ShoppingCheckinOperation_shoppingListId_createdAt_idx" ON "ShoppingCheckinOperation" ("shoppingListId", "createdAt")',
  'CREATE INDEX "ShoppingList_deletedAt_idx" ON "ShoppingList" ("deletedAt")',
  'CREATE INDEX "ShoppingList_status_idx" ON "ShoppingList" ("status")',
  'CREATE INDEX "ShoppingListItem_ingredientId_idx" ON "ShoppingListItem" ("ingredientId")',
  'CREATE INDEX "ShoppingListItem_shoppingListId_completed_sortOrder_idx" ON "ShoppingListItem" ("shoppingListId", "completed", "sortOrder")',
  'CREATE INDEX "Store_deletedAt_idx" ON "Store" ("deletedAt")',
  'CREATE INDEX "Store_favorite_idx" ON "Store" ("favorite")',
  'CREATE INDEX "Store_name_idx" ON "Store" ("name")',
  'CREATE INDEX "Store_storeType_idx" ON "Store" ("storeType")',
  'CREATE INDEX "StoreMealType_mealType_idx" ON "StoreMealType" ("mealType")',
  'CREATE UNIQUE INDEX "StoreMealType_storeId_mealType_key" ON "StoreMealType" ("storeId", "mealType")',
  'CREATE INDEX "StoreMenuItem_storeId_sortOrder_idx" ON "StoreMenuItem" ("storeId", "sortOrder")',
  'CREATE INDEX "Tag_deletedAt_idx" ON "Tag" ("deletedAt")',
  'CREATE UNIQUE INDEX "Tag_name_type_key" ON "Tag" ("name", "type")',
  'CREATE INDEX "UploadAsset_deletedAt_idx" ON "UploadAsset" ("deletedAt")',
  'CREATE UNIQUE INDEX "UploadAsset_filename_key" ON "UploadAsset" ("filename")',
  'CREATE INDEX "UploadAsset_mealRecordId_idx" ON "UploadAsset" ("mealRecordId")',
  'CREATE INDEX "UploadAsset_recipeId_idx" ON "UploadAsset" ("recipeId")',
  'CREATE INDEX "UploadAsset_sha256_idx" ON "UploadAsset" ("sha256")',
  'CREATE UNIQUE INDEX "UploadAsset_storagePath_key" ON "UploadAsset" ("storagePath")',
  'CREATE INDEX "UploadAsset_storeId_idx" ON "UploadAsset" ("storeId")',
];

/** 建库顺序：业务表 → 业务索引 → 私有端表 → 私有端索引。 */
export const SCHEMA_DDL: readonly string[] = [
  ...BUSINESS_TABLE_DDL,
  ...BUSINESS_INDEX_DDL,
  ...LOCAL_TABLE_DDL,
  ...LOCAL_INDEX_DDL,
];
