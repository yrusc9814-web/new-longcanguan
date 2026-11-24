import type { SyncEntityName, SyncOperation } from '@dafan/shared/sync';

import { deleteEntityChildren, upsertEntityChildren } from './sync-replay-children';
import { upsertShoppingList } from './sync-replay-shopping';
import {
  assertForeignKeys,
  ChangeCollector,
  insertRow,
  readRow,
  rememberBaseline,
  rememberTombstone,
  ReplayConflict,
  ReplayValidationError,
  rows,
  type RawRow,
  type ReplayResult,
  updateRow,
} from './sync-replay-support';
import { REPLAY_TABLES } from './sync-replay-tables';

/** 27 张业务表（父行）的 upsert / delete 重放。 */

function assertIdentity(operation: SyncOperation, payload: RawRow): string {
  const payloadId = payload.id;
  if (payloadId !== undefined) {
    if (typeof payloadId !== 'string' && typeof payloadId !== 'number') {
      throw new ReplayValidationError('payload.id 必须是字符串或数字');
    }
    if (String(payloadId) !== String(operation.entityId)) {
      throw new ReplayValidationError('payload.id 与 operation.entityId 不一致');
    }
  }
  return String(payloadId ?? operation.entityId);
}

/** 无 `id` 时的自然键对齐：`Tag`(name,type)、`UploadAsset`(filename/storagePath)。 */
function findNaturalKeyMatch(
  sql: SqlStorage,
  table: SyncEntityName,
  payload: RawRow,
): RawRow | null {
  if (table === 'Tag') {
    if (typeof payload.name !== 'string') return null;
    const type = typeof payload.type === 'string' ? payload.type : 'GENERAL';
    return (
      rows(sql, `SELECT * FROM "Tag" WHERE "name" = ? AND "type" = ?`, payload.name, type)[0] ??
      null
    );
  }
  if (table === 'UploadAsset') {
    if (typeof payload.filename === 'string') {
      const byName = rows(
        sql,
        `SELECT * FROM "UploadAsset" WHERE "filename" = ?`,
        payload.filename,
      )[0];
      if (byName) return byName;
    }
    if (typeof payload.storagePath === 'string') {
      return (
        rows(sql, `SELECT * FROM "UploadAsset" WHERE "storagePath" = ?`, payload.storagePath)[0] ??
        null
      );
    }
  }
  return null;
}

function assertPlanSlot(
  sql: SqlStorage,
  operation: SyncOperation,
  values: RawRow,
  id: string | number,
): void {
  const { planDate, mealType } = values;
  if (typeof planDate !== 'string' || typeof mealType !== 'string') {
    throw new ReplayValidationError('MealPlan 必须提供 planDate 与 mealType');
  }
  const winner = rows(
    sql,
    `SELECT * FROM "MealPlan"
     WHERE "planDate" = ? AND "mealType" = ? AND "deletedAt" IS NULL AND "id" <> ? LIMIT 1`,
    planDate,
    mealType,
    String(id),
  )[0];
  if (winner) {
    throw new ReplayConflict(
      {
        operationId: operation.id,
        code: 'PLAN_SLOT_CONFLICT',
        serverVersion: Number(winner.version ?? 1),
        winner: winner as never,
      },
      '同日同餐次已存在有效排餐',
    );
  }
}

function versionConflict(operation: SyncOperation, server: RawRow): ReplayConflict {
  return new ReplayConflict({
    operationId: operation.id,
    code: 'VERSION_CONFLICT',
    serverVersion: Number(server.version ?? 1),
    winner: server as never,
  });
}

export function upsertEntity(
  sql: SqlStorage,
  operation: Extract<SyncOperation, { kind: 'upsert' }>,
  changes: ChangeCollector,
): ReplayResult {
  const { entity } = operation;
  const meta = REPLAY_TABLES[entity];
  const payload = operation.payload as RawRow;
  const declaredId = assertIdentity(operation, payload);

  if (entity === 'ShoppingList') {
    return upsertShoppingList(sql, operation, payload, changes);
  }

  let targetId: string | number = entity === 'Settings' ? 1 : declaredId;
  let current = readRow(sql, entity, declaredId);
  if (!current) {
    const natural = findNaturalKeyMatch(sql, entity, payload);
    if (natural?.id !== undefined) {
      current = natural;
      targetId = natural.id as string | number;
    }
  }

  const currentVersion = Number(current?.version ?? 1);
  const baseVersion = operation.baseVersion;
  const nextVersion = meta.versioned
    ? baseVersion === null
      ? Number(payload.version ?? 1)
      : baseVersion + 1
    : 1;

  if (baseVersion !== null) {
    if (!current) {
      throw new ReplayConflict({
        operationId: operation.id,
        code: 'VERSION_CONFLICT',
        serverVersion: null,
      });
    }
    if (meta.versioned && currentVersion !== baseVersion) {
      throw versionConflict(operation, current);
    }
  } else if (current && meta.versioned && currentVersion !== Number(payload.version ?? 1)) {
    throw versionConflict(operation, current);
  }

  if (current?.deletedAt !== undefined && current.deletedAt !== null && baseVersion === null) {
    throw new ReplayConflict({
      operationId: operation.id,
      code: 'VERSION_CONFLICT',
      serverVersion: currentVersion,
      winner: current as never,
    });
  }

  // 无 version 列的表（Tag / UploadAsset）必须忽略载荷里多余的 version。
  const values: RawRow = {};
  for (const column of meta.columns) {
    if (column === 'id') {
      values.id = entity === 'Settings' ? 1 : targetId;
      continue;
    }
    if (column === 'version') {
      if (meta.versioned) values.version = nextVersion;
      continue;
    }
    if (payload[column] !== undefined) values[column] = payload[column];
    else if (meta.defaults && column in meta.defaults) values[column] = meta.defaults[column];
  }

  if (entity === 'Settings') values.id = 1;
  if (entity === 'MealPlan' && (values.deletedAt ?? null) === null) {
    assertPlanSlot(sql, operation, values, targetId);
  }
  assertForeignKeys(sql, entity, values);

  if (current) updateRow(sql, entity, targetId, values);
  else insertRow(sql, entity, values);
  changes.capture(entity, targetId);
  // 写入后的状态作为新版本基线，供其他设备的离线合并精确对齐。
  if (meta.versioned) rememberBaseline(sql, entity, readRow(sql, entity, targetId));

  // 聚合子表（批次 / 菜谱关系 / 店铺菜单 / 排餐与记录条目）属于同一次写入。
  upsertEntityChildren(sql, entity, String(targetId), payload, changes);

  return { newVersion: meta.versioned ? nextVersion : 1, changes: changes.list() };
}

export function deleteEntity(
  sql: SqlStorage,
  operation: Extract<SyncOperation, { kind: 'delete' }>,
  changes: ChangeCollector,
): ReplayResult {
  const { entity } = operation;
  const meta = REPLAY_TABLES[entity];
  const current = readRow(sql, entity, operation.entityId);

  if (!current) {
    // 目标已不存在：重推同一删除时接受，不产生变更。
    return { newVersion: meta.versioned ? operation.baseVersion + 1 : 1, changes: changes.list() };
  }

  const currentVersion = Number(current.version ?? 1);
  if (meta.versioned && currentVersion !== operation.baseVersion) {
    throw versionConflict(operation, current);
  }
  const nextVersion = meta.versioned ? operation.baseVersion + 1 : 1;

  if (meta.softDelete) {
    const values: RawRow = { deletedAt: operation.deletedAt, updatedAt: operation.deletedAt };
    if (meta.versioned) values.version = nextVersion;
    updateRow(sql, entity, operation.entityId, values);
    changes.capture(entity, operation.entityId);
    // 软删聚合根必须与端侧同语义级联软删子行（端侧 `deleteIngredient` 同事务
    // 软删全部未删除批次），否则他端会留下幽灵批次继续计入库存。
    if (entity === 'Ingredient') {
      for (const batch of rows(
        sql,
        `SELECT "id","version" FROM "InventoryBatch"
          WHERE "ingredientId" = ? AND "deletedAt" IS NULL`,
        operation.entityId,
      )) {
        const batchId = String(batch.id);
        updateRow(sql, 'InventoryBatch', batchId, {
          deletedAt: operation.deletedAt,
          updatedAt: operation.deletedAt,
          version: Number(batch.version ?? 1) + 1,
        });
        changes.capture('InventoryBatch', batchId);
      }
    }
  } else {
    deleteEntityChildren(sql, entity, String(operation.entityId), changes);
    sql.exec(`DELETE FROM "${entity}" WHERE "id" = ?`, operation.entityId);
    changes.record(entity, operation.entityId, null);
    if (entity === 'ShoppingListItem') {
      // 与聚合 upsert 的剪枝同语义：物理删除必须留墓碑，长离线客户端不能把它插回。
      // 版本取「删除后的父版本」，落后于该版本的客户端一律视为没见过这次删除。
      rememberTombstone(sql, entity, String(operation.entityId), operation.baseVersion + 1);
    }
  }
  return { newVersion: nextVersion, changes: changes.list() };
}
