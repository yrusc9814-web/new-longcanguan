import type { SyncEntityName, SyncOperation, SyncRowChange } from '@dafan/shared/sync';

import {
  activeBatches,
  arrayPayload,
  assertForeignKeys,
  convertQuantity,
  bindable,
  ChangeCollector,
  insertRow,
  isTrue,
  objectPayload,
  readRow,
  ReplayConflict,
  ReplayValidationError,
  requireNumber,
  requireString,
  rememberTombstone,
  roundQuantity,
  rowVersion,
  rows,
  summarizeBatchMeta,
  summarizeQuantity,
  updateRow,
  type RawRow,
  type ReplayResult,
} from './sync-replay-support';

/** 7 类业务命令的原子重放。 */

interface Target {
  readonly row: RawRow;
  readonly version: number;
}

function commandTarget(
  sql: SqlStorage,
  operation: Extract<SyncOperation, { kind: 'command' }>,
  payload: RawRow,
): Target {
  const row = readRow(sql, operation.entity, operation.entityId);
  if (!row) {
    throw new ReplayConflict({
      operationId: operation.id,
      code: 'VERSION_CONFLICT',
      serverVersion: null,
    });
  }
  const current = rowVersion(row, operation.entity);
  const baseVersion =
    typeof payload.baseVersion === 'number' ? payload.baseVersion : operation.baseVersion;
  if (baseVersion !== null && current !== baseVersion) {
    throw new ReplayConflict({
      operationId: operation.id,
      code: 'VERSION_CONFLICT',
      serverVersion: current,
      winner: row as never,
    });
  }
  return { row, version: current };
}

function insufficientStock(
  operation: SyncOperation,
  ingredient: RawRow,
  serverVersion: number,
): ReplayConflict {
  return new ReplayConflict(
    {
      operationId: operation.id,
      code: 'INSUFFICIENT_STOCK',
      serverVersion,
      ingredientId: String(ingredient.id),
      winner: ingredient as never,
    },
    '库存不足，本次扣减被拒绝',
  );
}

/** 扣减批次并写日志；数量不足抛 `INSUFFICIENT_STOCK`。 */
function deductBatch(
  sql: SqlStorage,
  operation: SyncOperation,
  ingredient: RawRow,
  deduction: RawRow,
  executedAt: string,
  notes: string | null,
  changes: ChangeCollector,
): void {
  const batchId = requireString(deduction, 'batchId');
  const logId = requireString(deduction, 'logId');
  const changeQuantity = requireNumber(deduction, 'changeQuantity');
  const take = -changeQuantity;
  if (!(take > 0)) throw new ReplayValidationError('扣减数量必须为正');
  const batch = readRow(sql, 'InventoryBatch', batchId);
  if (!batch || String(batch.ingredientId) !== String(ingredient.id)) {
    throw new ReplayValidationError(`扣减批次 ${batchId} 不属于食材 ${String(ingredient.id)}`);
  }
  const before = Number(batch.quantity ?? 0);
  if (before + 1e-9 < take) {
    throw insufficientStock(operation, ingredient, rowVersion(ingredient, 'Ingredient'));
  }
  const after = roundQuantity(before - take);
  const updated = sql.exec(
    `UPDATE "InventoryBatch" SET "quantity" = ?, "version" = "version" + 1, "updatedAt" = ?
     WHERE "id" = ? AND "version" = ? AND "deletedAt" IS NULL AND "quantity" >= ?`,
    after,
    executedAt,
    batchId,
    Number(batch.version),
    take,
  );
  if (updated.rowsWritten < 1) {
    throw insufficientStock(operation, ingredient, rowVersion(ingredient, 'Ingredient'));
  }
  insertRow(sql, 'InventoryLog', {
    id: logId,
    ingredientId: String(ingredient.id),
    ingredientNameSnapshot: String(ingredient.name),
    inventoryBatchId: batchId,
    beforeQuantity: before,
    changeQuantity,
    afterQuantity: after,
    unit: String(batch.unit),
    changeType: 'MANUAL_DEDUCT',
    relatedPlanId: null,
    relatedRecordId: null,
    notes,
    createdAt: executedAt,
    updatedAt: executedAt,
  });
  changes.capture('InventoryBatch', batchId);
  changes.capture('InventoryLog', logId);
}

function refreshIngredientTotals(
  sql: SqlStorage,
  operation: SyncOperation,
  ingredient: RawRow,
  version: number,
  executedAt: string,
  changes: ChangeCollector,
): number {
  const remaining = activeBatches(sql, String(ingredient.id));
  const summary = summarizeBatchMeta(remaining);
  const quantity = summarizeQuantity(remaining, String(ingredient.unit));
  const opened = remaining.some((batch) => Number(batch.quantity ?? 0) > 0 && isTrue(batch.opened))
    ? 1
    : 0;
  const updated = sql.exec(
    `UPDATE "Ingredient" SET "quantity" = ?, "purchaseDate" = ?, "expiryDate" = ?,
       "location" = ?, "opened" = ?, "version" = "version" + 1, "updatedAt" = ?
     WHERE "id" = ? AND "version" = ? AND "deletedAt" IS NULL`,
    quantity,
    summary.purchaseDate,
    summary.expiryDate,
    summary.location,
    opened,
    executedAt,
    String(ingredient.id),
    version,
  );
  if (updated.rowsWritten < 1) {
    throw new ReplayConflict({
      operationId: operation.id,
      code: 'VERSION_CONFLICT',
      serverVersion: version + 1,
      ingredientId: String(ingredient.id),
    });
  }
  changes.capture('Ingredient', String(ingredient.id));
  return version + 1;
}

function insertImplicitBatch(
  sql: SqlStorage,
  ingredient: RawRow,
  ref: RawRow,
  executedAt: string,
  changes: ChangeCollector,
): void {
  const batchId = requireString(ref, 'batchId');
  const logId = requireString(ref, 'logId');
  const quantity = Number(ingredient.quantity ?? 0);
  insertRow(sql, 'InventoryBatch', {
    id: batchId,
    ingredientId: String(ingredient.id),
    quantity,
    unit: String(ingredient.unit),
    purchaseDate: ingredient.purchaseDate ?? null,
    expiryDate: ingredient.expiryDate ?? null,
    location: ingredient.location ?? null,
    opened: isTrue(ingredient.opened) ? 1 : 0,
    consumePriority: 0,
    notes: '历史存量自动补建等效批次',
    version: 1,
    deletedAt: null,
    createdAt: executedAt,
    updatedAt: executedAt,
  });
  insertRow(sql, 'InventoryLog', {
    id: logId,
    ingredientId: String(ingredient.id),
    ingredientNameSnapshot: String(ingredient.name),
    inventoryBatchId: batchId,
    beforeQuantity: 0,
    changeQuantity: quantity,
    afterQuantity: quantity,
    unit: String(ingredient.unit),
    changeType: 'ADJUST',
    relatedPlanId: null,
    relatedRecordId: null,
    notes: '历史存量自动补建等效批次',
    createdAt: executedAt,
    updatedAt: executedAt,
  });
  changes.capture('InventoryBatch', batchId);
  changes.capture('InventoryLog', logId);
}

// ---------------------------------------------------------------------------
// INGREDIENT_CONSUME
// ---------------------------------------------------------------------------

export function consumeIngredient(
  sql: SqlStorage,
  operation: Extract<SyncOperation, { kind: 'command' }>,
  payload: RawRow,
  changes: ChangeCollector,
): ReplayResult {
  const { row: ingredient, version } = commandTarget(sql, operation, payload);
  const executedAt = requireString(payload, 'executedAt');
  const request = objectPayload(payload.request, 'request');
  const notes = typeof request.notes === 'string' ? request.notes : null;

  if (payload.implicitBatch) {
    insertImplicitBatch(
      sql,
      ingredient,
      objectPayload(payload.implicitBatch, 'implicitBatch'),
      executedAt,
      changes,
    );
  }
  for (const deduction of arrayPayload(payload.deductions)) {
    deductBatch(sql, operation, ingredient, deduction, executedAt, notes, changes);
  }
  const nextVersion = refreshIngredientTotals(
    sql,
    operation,
    ingredient,
    version,
    executedAt,
    changes,
  );
  return { newVersion: nextVersion, changes: changes.list() };
}

// ---------------------------------------------------------------------------
// INGREDIENT_UPDATE_SYNC_BATCHES
// ---------------------------------------------------------------------------

export function updateIngredientBatches(
  sql: SqlStorage,
  operation: Extract<SyncOperation, { kind: 'command' }>,
  payload: RawRow,
  changes: ChangeCollector,
): ReplayResult {
  const { row: ingredient, version } = commandTarget(sql, operation, payload);
  const ingredientId = String(ingredient.id);
  const executedAt = requireString(payload, 'executedAt');
  const request = objectPayload(payload.request, 'request');
  const name = requireString(request, 'name');
  const unit = requireString(request, 'unit');
  const replacedRefs = Array.isArray(payload.replacedBatches)
    ? (payload.replacedBatches as RawRow[])
    : null;
  const requestBatches = arrayPayload(request.batches);

  let targetQuantity: number;
  let replacedOpened = false;

  if (replacedRefs) {
    if (requestBatches.length !== replacedRefs.length) {
      throw new ReplayValidationError('replacedBatches 与 request.batches 长度不一致');
    }
    for (const batch of activeBatches(sql, ingredientId)) {
      updateRow(sql, 'InventoryBatch', batch.id as string, {
        deletedAt: executedAt,
        updatedAt: executedAt,
        version: Number(batch.version) + 1,
      });
      changes.capture('InventoryBatch', batch.id as string);
    }
    let total = 0;
    for (const [index, ref] of replacedRefs.entries()) {
      const source = requestBatches[index] as RawRow;
      const batchId = requireString(ref, 'batchId');
      const logId = requireString(ref, 'logId');
      const quantity = requireNumber(source, 'quantity');
      const batchUnit = requireString(source, 'unit');
      insertRow(sql, 'InventoryBatch', {
        id: batchId,
        ingredientId,
        quantity,
        unit: batchUnit,
        purchaseDate: source.purchaseDate ?? null,
        expiryDate: source.expiryDate ?? null,
        location: source.location ?? null,
        opened: source.opened ? 1 : 0,
        consumePriority: source.consumePriority ? 1 : 0,
        notes: source.notes ?? null,
        version: 1,
        deletedAt: null,
        createdAt: executedAt,
        updatedAt: executedAt,
      });
      insertRow(sql, 'InventoryLog', {
        id: logId,
        ingredientId,
        ingredientNameSnapshot: name,
        inventoryBatchId: batchId,
        beforeQuantity: 0,
        changeQuantity: quantity,
        afterQuantity: quantity,
        unit: batchUnit,
        changeType: 'ADJUST',
        relatedPlanId: null,
        relatedRecordId: null,
        notes: '食材编辑替换批次',
        createdAt: executedAt,
        updatedAt: executedAt,
      });
      changes.capture('InventoryBatch', batchId);
      changes.capture('InventoryLog', logId);
      total += convertQuantity(quantity, batchUnit, unit) ?? 0;
      if (quantity > 0 && source.opened) replacedOpened = true;
    }
    targetQuantity = roundQuantity(total);
  } else {
    let total = summarizeQuantity(activeBatches(sql, ingredientId), unit);
    if (payload.implicitBatch) {
      insertImplicitBatch(
        sql,
        ingredient,
        objectPayload(payload.implicitBatch, 'implicitBatch'),
        executedAt,
        changes,
      );
      total = summarizeQuantity(activeBatches(sql, ingredientId), unit);
    }
    targetQuantity =
      typeof request.quantity === 'number' && request.quantity !== null
        ? roundQuantity(request.quantity)
        : total;
    const delta = roundQuantity(targetQuantity - total);
    if (delta > 1e-9) {
      if (!payload.addedBatch) throw new ReplayValidationError('增加数量必须提供 addedBatch');
      const ref = objectPayload(payload.addedBatch, 'addedBatch');
      const batchId = requireString(ref, 'batchId');
      const logId = requireString(ref, 'logId');
      insertRow(sql, 'InventoryBatch', {
        id: batchId,
        ingredientId,
        quantity: delta,
        unit,
        purchaseDate: request.purchaseDate ?? ingredient.purchaseDate ?? null,
        expiryDate: request.expiryDate ?? ingredient.expiryDate ?? null,
        location: request.location ?? ingredient.location ?? null,
        opened:
          request.opened !== undefined
            ? request.opened
              ? 1
              : 0
            : isTrue(ingredient.opened)
              ? 1
              : 0,
        consumePriority: 0,
        notes: null,
        version: 1,
        deletedAt: null,
        createdAt: executedAt,
        updatedAt: executedAt,
      });
      insertRow(sql, 'InventoryLog', {
        id: logId,
        ingredientId,
        ingredientNameSnapshot: name,
        inventoryBatchId: batchId,
        beforeQuantity: 0,
        changeQuantity: delta,
        afterQuantity: delta,
        unit,
        changeType: 'ADJUST',
        relatedPlanId: null,
        relatedRecordId: null,
        notes: '食材编辑同步库存',
        createdAt: executedAt,
        updatedAt: executedAt,
      });
      changes.capture('InventoryBatch', batchId);
      changes.capture('InventoryLog', logId);
    } else if (delta < -1e-9) {
      let remaining = roundQuantity(-delta);
      for (const deduction of arrayPayload(payload.deductions)) {
        if (remaining <= 1e-9) break;
        deductBatch(sql, operation, ingredient, deduction, executedAt, '食材编辑同步库存', changes);
        remaining = roundQuantity(remaining + requireNumber(deduction, 'changeQuantity'));
      }
      if (remaining > 1e-9) throw insufficientStock(operation, ingredient, version);
    }

    const metaFields = ['purchaseDate', 'expiryDate', 'location', 'opened'] as const;
    if (metaFields.some((field) => field in request)) {
      const assignments: string[] = [];
      const values: Array<string | number | null> = [];
      for (const field of ['purchaseDate', 'expiryDate', 'location'] as const) {
        if (field in request) {
          assignments.push(`"${field}" = ?`);
          values.push(bindable(request[field]));
        }
      }
      if ('opened' in request) {
        assignments.push('"opened" = ?');
        values.push(request.opened ? 1 : 0);
      }
      if (assignments.length) {
        sql.exec(
          `UPDATE "InventoryBatch" SET ${assignments.join(', ')}, "updatedAt" = ?
           WHERE "ingredientId" = ? AND "deletedAt" IS NULL AND "quantity" > 0`,
          ...values,
          executedAt,
          ingredientId,
        );
        for (const batch of activeBatches(sql, ingredientId)) {
          changes.capture('InventoryBatch', batch.id as string);
        }
      }
    }
  }

  const finalBatches = activeBatches(sql, ingredientId);
  const summary = summarizeBatchMeta(finalBatches);
  const purchaseDate =
    request.purchaseDate !== undefined
      ? (request.purchaseDate as string | null)
      : (summary.purchaseDate ??
        (replacedRefs ? null : ((ingredient.purchaseDate as string | null) ?? null)));
  const expiryDate =
    request.expiryDate !== undefined
      ? (request.expiryDate as string | null)
      : (summary.expiryDate ??
        (replacedRefs ? null : ((ingredient.expiryDate as string | null) ?? null)));
  const location =
    request.location !== undefined
      ? (request.location as string | null)
      : (summary.location ??
        (replacedRefs ? null : ((ingredient.location as string | null) ?? null)));
  const opened = replacedRefs
    ? request.opened !== undefined
      ? request.opened
        ? 1
        : 0
      : replacedOpened
        ? 1
        : 0
    : isTrue(ingredient.opened)
      ? 1
      : 0;

  const updated = sql.exec(
    `UPDATE "Ingredient" SET "name" = ?, "imagePath" = ?, "category" = ?, "unit" = ?,
       "quantity" = ?, "minStock" = ?, "maxStock" = ?, "notes" = ?, "purchaseDate" = ?,
       "expiryDate" = ?, "location" = ?, "opened" = ?, "version" = "version" + 1, "updatedAt" = ?
     WHERE "id" = ? AND "version" = ? AND "deletedAt" IS NULL`,
    name,
    bindable(request.imagePath ?? null),
    bindable(request.category ?? ingredient.category ?? null),
    unit,
    targetQuantity,
    bindable(request.minStock ?? null),
    bindable(request.maxStock ?? null),
    bindable(request.notes ?? null),
    purchaseDate,
    expiryDate,
    location,
    opened,
    executedAt,
    ingredientId,
    version,
  );
  if (updated.rowsWritten < 1) {
    throw new ReplayConflict({
      operationId: operation.id,
      code: 'VERSION_CONFLICT',
      serverVersion: version + 1,
      ingredientId,
    });
  }
  changes.capture('Ingredient', ingredientId);
  return { newVersion: version + 1, changes: changes.list() };
}

// ---------------------------------------------------------------------------
// 排餐 / 记录命令
// ---------------------------------------------------------------------------

function planItems(sql: SqlStorage, planId: string): RawRow[] {
  return rows(
    sql,
    `SELECT * FROM "MealPlanItem" WHERE "mealPlanId" = ? ORDER BY "sortOrder" ASC, rowid ASC`,
    planId,
  );
}

function planDinerRows(sql: SqlStorage, planId: string): RawRow[] {
  return rows(
    sql,
    `SELECT * FROM "MealPlanDiner" WHERE "mealPlanId" = ? ORDER BY rowid ASC`,
    planId,
  );
}

/** 与端侧 `mealRecordDinerId` 同一格式：旧命令载荷缺 `dinerRowIds` 时按此补齐。 */
function recordDinerRowId(recordId: string, dinerId: string): string {
  return `mrd:${recordId}:${dinerId}`;
}

function writeRecordRow(
  sql: SqlStorage,
  payloadRecord: RawRow,
  extra: RawRow,
  changes: ChangeCollector,
  mode: 'insert' | 'revive',
): void {
  const recordId = requireString(payloadRecord, 'id');
  const values: RawRow = {
    id: recordId,
    recordDate: payloadRecord.recordDate,
    recordTime: payloadRecord.recordTime ?? null,
    mealType: payloadRecord.mealType,
    sourceType: payloadRecord.sourceType,
    title: payloadRecord.title ?? null,
    status: payloadRecord.status,
    imagePath: null,
    photosJson: null,
    rating: null,
    satiety: null,
    calories: null,
    cost: null,
    isNewTry: 0,
    favorite: 0,
    notes: null,
    relatedPlanId: payloadRecord.relatedPlanId ?? null,
    sourceMealPlanId: payloadRecord.sourceMealPlanId ?? null,
    confirmedAt: payloadRecord.confirmedAt ?? null,
    version: Number(payloadRecord.version),
    deletedAt: payloadRecord.deletedAt ?? null,
    planUncompleteProof: null,
    createdAt: payloadRecord.createdAt,
    updatedAt: payloadRecord.updatedAt,
    ...extra,
  };
  assertForeignKeys(sql, 'MealRecord', values);
  if (mode === 'insert') insertRow(sql, 'MealRecord', values);
  else {
    const columns = Object.keys(values).filter((column) => column !== 'id');
    updateRow(sql, 'MealRecord', recordId, Object.fromEntries(columns.map((c) => [c, values[c]])));
  }
  changes.capture('MealRecord', recordId);
}

function replaceRecordChildren(
  sql: SqlStorage,
  recordId: string,
  itemIds: readonly string[],
  itemRows: readonly RawRow[],
  dinerRowIds: readonly string[],
  dinerRows: readonly RawRow[],
  executedAt: string,
  changes: ChangeCollector,
): void {
  for (const child of rows(
    sql,
    `SELECT "id" FROM "MealRecordItem" WHERE "mealRecordId" = ?`,
    recordId,
  )) {
    sql.exec(`DELETE FROM "MealRecordItem" WHERE "id" = ?`, child.id);
  }
  for (const child of rows(
    sql,
    `SELECT "id" FROM "MealRecordDiner" WHERE "mealRecordId" = ?`,
    recordId,
  )) {
    sql.exec(`DELETE FROM "MealRecordDiner" WHERE "id" = ?`, child.id);
  }
  for (const [index, itemId] of itemIds.entries()) {
    const source = itemRows[index];
    if (!source) throw new ReplayValidationError('record.itemIds 多于排餐项目');
    const values = {
      id: itemId,
      mealRecordId: recordId,
      itemType: source.itemType,
      mealRole: source.mealRole ?? null,
      recipeId: source.recipeId ?? null,
      storeId: source.storeId ?? null,
      customName: source.customName ?? null,
      sortOrder: Number(source.sortOrder ?? index),
      createdAt: executedAt,
      updatedAt: executedAt,
    };
    assertForeignKeys(sql, 'MealRecordItem', values);
    insertRow(sql, 'MealRecordItem', values);
    changes.capture('MealRecordItem', itemId);
  }
  for (const [index, rowId] of dinerRowIds.entries()) {
    const source = dinerRows[index];
    const values = {
      id: rowId,
      mealRecordId: recordId,
      dinerId: (source?.dinerId as string | null | undefined) ?? null,
      createdAt: executedAt,
      updatedAt: executedAt,
    };
    assertForeignKeys(sql, 'MealRecordDiner', values);
    insertRow(sql, 'MealRecordDiner', values);
    changes.capture('MealRecordDiner', rowId);
  }
}

function assertPlanFact(plan: RawRow, id: string, baseVersion: number): void {
  const planId = requireString(plan, 'id');
  if (planId !== id) throw new ReplayValidationError('plan.id 与命令 id 不一致');
  if (plan.version !== baseVersion + 1) {
    throw new ReplayValidationError('plan.version 必须等于 baseVersion + 1');
  }
}

/**
 * 关联行 ID：新载荷直接给 `record.dinerRowIds`；旧载荷缺失时按
 * `(recordId, dinerId)` 派生（与端侧 `mealRecordDinerId` 一致），
 * 否则重放会清空已有就餐人且不重建。
 */
function recordDinerRowIds(
  recordId: string,
  record: RawRow,
  dinerIds: readonly string[],
): string[] {
  const declared = Array.isArray(record.dinerRowIds) ? (record.dinerRowIds as string[]) : [];
  if (declared.length) return declared;
  return dinerIds.map((dinerId) => recordDinerRowId(recordId, dinerId));
}

export function completePlan(
  sql: SqlStorage,
  operation: Extract<SyncOperation, { kind: 'command' }>,
  payload: RawRow,
  changes: ChangeCollector,
): ReplayResult {
  const { row: plan, version } = commandTarget(sql, operation, payload);
  const planPayload = objectPayload(payload.plan, 'plan');
  assertPlanFact(planPayload, String(plan.id), version);
  const executedAt = requireString(payload, 'executedAt');
  const record = objectPayload(payload.record, 'record');
  const recordCreated = payload.recordCreated === true;
  const recordRevived = payload.recordRevived === true;
  const existingRecord = readRow(sql, 'MealRecord', requireString(record, 'id'));

  if (existingRecord) {
    if (recordCreated) {
      throw new ReplayConflict({
        operationId: operation.id,
        code: 'VERSION_CONFLICT',
        serverVersion: rowVersion(existingRecord, 'MealRecord'),
        winner: existingRecord as never,
      });
    }
    if (recordRevived) {
      writeRecordRow(
        sql,
        record,
        {
          status: 'DRAFT',
          recordDate: plan.planDate,
          recordTime: null,
          title: null,
          imagePath: null,
          photosJson: null,
          rating: null,
          satiety: null,
          calories: null,
          cost: null,
          isNewTry: 0,
          favorite: 0,
          notes: null,
          relatedPlanId: plan.id,
          sourceMealPlanId: plan.id,
          confirmedAt: null,
          deletedAt: null,
          planUncompleteProof: null,
        },
        changes,
        'revive',
      );
      const planDiners = planDinerRows(sql, String(plan.id));
      replaceRecordChildren(
        sql,
        String(record.id),
        Array.isArray(record.itemIds) ? (record.itemIds as string[]) : [],
        planItems(sql, String(plan.id)),
        recordDinerRowIds(
          String(record.id),
          record,
          planDiners
            .map((row) => row.dinerId)
            .filter((dinerId): dinerId is string => typeof dinerId === 'string'),
        ),
        planDiners,
        executedAt,
        changes,
      );
    }
  } else if (recordCreated) {
    writeRecordRow(sql, record, {}, changes, 'insert');
    const planDiners = planDinerRows(sql, String(plan.id));
    replaceRecordChildren(
      sql,
      String(record.id),
      Array.isArray(record.itemIds) ? (record.itemIds as string[]) : [],
      planItems(sql, String(plan.id)),
      recordDinerRowIds(
        String(record.id),
        record,
        planDiners
          .map((row) => row.dinerId)
          .filter((dinerId): dinerId is string => typeof dinerId === 'string'),
      ),
      planDiners,
      executedAt,
      changes,
    );
  } else {
    throw new ReplayValidationError('PLAN_COMPLETE 引用的饮食记录不存在');
  }

  updateRow(sql, 'MealPlan', plan.id as string, {
    status: planPayload.status,
    completedAt: planPayload.completedAt ?? executedAt,
    version: Number(planPayload.version),
    updatedAt: planPayload.updatedAt ?? executedAt,
  });
  changes.capture('MealPlan', plan.id as string);
  return { newVersion: Number(planPayload.version), changes: changes.list() };
}

export function uncompletePlan(
  sql: SqlStorage,
  operation: Extract<SyncOperation, { kind: 'command' }>,
  payload: RawRow,
  changes: ChangeCollector,
): ReplayResult {
  const { row: plan } = commandTarget(sql, operation, payload);
  const planPayload = objectPayload(payload.plan, 'plan');
  const executedAt = requireString(payload, 'executedAt');
  if (payload.removedRecord) {
    const removed = objectPayload(payload.removedRecord, 'removedRecord');
    const recordId = requireString(removed, 'id');
    const record = readRow(sql, 'MealRecord', recordId);
    if (!record) {
      throw new ReplayValidationError(`PLAN_UNCOMPLETE 引用的记录不存在: ${recordId}`);
    }
    updateRow(sql, 'MealRecord', recordId, {
      deletedAt: requireString(removed, 'deletedAt'),
      planUncompleteProof: requireString(removed, 'planUncompleteProof'),
      version: requireNumber(removed, 'version'),
      updatedAt: requireString(removed, 'deletedAt'),
    });
    changes.capture('MealRecord', recordId);
  }
  updateRow(sql, 'MealPlan', plan.id as string, {
    status: planPayload.status,
    completedAt: null,
    version: Number(planPayload.version),
    updatedAt: planPayload.updatedAt ?? executedAt,
  });
  changes.capture('MealPlan', plan.id as string);
  return { newVersion: Number(planPayload.version), changes: changes.list() };
}

export function deleteMealRecord(
  sql: SqlStorage,
  operation: Extract<SyncOperation, { kind: 'command' }>,
  payload: RawRow,
  changes: ChangeCollector,
): ReplayResult {
  const { row: record, version } = commandTarget(sql, operation, payload);
  const deletedAt = requireString(payload, 'deletedAt');
  const released = payload.releasedSourceMealPlanId;
  updateRow(sql, 'MealRecord', record.id as string, {
    deletedAt,
    version: version + 1,
    updatedAt: deletedAt,
    ...(released === null || released === undefined ? {} : { sourceMealPlanId: null }),
  });
  changes.capture('MealRecord', record.id as string);

  if (payload.revertedPlan) {
    const reverted = objectPayload(payload.revertedPlan, 'revertedPlan');
    const planId = requireString(reverted, 'id');
    const plan = readRow(sql, 'MealPlan', planId);
    if (!plan) throw new ReplayValidationError(`回退排餐不存在: ${planId}`);
    const expected = Number(reverted.version) - 1;
    if (rowVersion(plan, 'MealPlan') !== expected) {
      throw new ReplayConflict({
        operationId: operation.id,
        code: 'VERSION_CONFLICT',
        serverVersion: rowVersion(plan, 'MealPlan'),
        winner: plan as never,
      });
    }
    updateRow(sql, 'MealPlan', planId, {
      status: reverted.status,
      completedAt: reverted.completedAt ?? null,
      version: Number(reverted.version),
      updatedAt: reverted.updatedAt ?? deletedAt,
    });
    changes.capture('MealPlan', planId);
  }
  return { newVersion: version + 1, changes: changes.list() };
}

export function recipeCookCheckin(
  sql: SqlStorage,
  operation: Extract<SyncOperation, { kind: 'command' }>,
  payload: RawRow,
  changes: ChangeCollector,
): ReplayResult {
  const record = objectPayload(payload.record, 'record');
  const recordId = requireString(record, 'id');
  const recipeId = requireString(payload, 'recipeId');
  const request = objectPayload(payload.request, 'request');
  const executedAt = requireString(payload, 'executedAt');
  const existing = readRow(sql, 'MealRecord', recordId);
  if (existing) {
    const expected = Number(record.version);
    const current = rowVersion(existing, 'MealRecord');
    if (current !== expected) {
      throw new ReplayConflict({
        operationId: operation.id,
        code: 'VERSION_CONFLICT',
        serverVersion: current,
        winner: existing as never,
      });
    }
    return { newVersion: current, changes: changes.list() };
  }

  const photos = Array.isArray(request.photos) ? (request.photos as string[]) : null;
  writeRecordRow(
    sql,
    record,
    {
      imagePath: photos && photos.length ? photos[0] : null,
      photosJson: photos && photos.length ? JSON.stringify(photos) : null,
      rating: request.rating ?? null,
      satiety: request.satiety ?? null,
      calories: request.calories ?? null,
      cost: request.cost ?? null,
      isNewTry: 0,
      favorite: 0,
      notes: request.notes ?? null,
      relatedPlanId: null,
      sourceMealPlanId: null,
      confirmedAt: record.confirmedAt ?? executedAt,
      deletedAt: null,
      planUncompleteProof: null,
    },
    changes,
    'insert',
  );

  const itemIds = Array.isArray(record.itemIds) ? (record.itemIds as string[]) : [];
  if (itemIds.length !== 1) {
    throw new ReplayValidationError('RECIPE_COOK_CHECKIN 必须且只能落一行菜谱项目');
  }
  const itemId = itemIds[0] as string;
  insertRow(sql, 'MealRecordItem', {
    id: itemId,
    mealRecordId: recordId,
    itemType: 'RECIPE',
    mealRole: 'MAIN',
    recipeId,
    storeId: null,
    customName: null,
    sortOrder: 0,
    createdAt: executedAt,
    updatedAt: executedAt,
  });
  changes.capture('MealRecordItem', itemId);

  const dinerIds = Array.isArray(request.dinerIds) ? (request.dinerIds as string[]) : [];
  const dinerRowIds = recordDinerRowIds(recordId, record, dinerIds);
  for (const [index, rowId] of dinerRowIds.entries()) {
    const dinerId = dinerIds[index] ?? null;
    if (dinerId === null) throw new ReplayValidationError('dinerRowIds 与 dinerIds 长度不一致');
    insertRow(sql, 'MealRecordDiner', {
      id: rowId,
      mealRecordId: recordId,
      dinerId,
      createdAt: executedAt,
      updatedAt: executedAt,
    });
    changes.capture('MealRecordDiner', rowId);
  }
  return { newVersion: Number(record.version), changes: changes.list() };
}

// ---------------------------------------------------------------------------
// SHOPPING_CHECKIN
// ---------------------------------------------------------------------------

export function shoppingCheckin(
  sql: SqlStorage,
  operation: Extract<SyncOperation, { kind: 'command' }>,
  payload: RawRow,
  changes: ChangeCollector,
): ReplayResult {
  const listId = requireString(payload, 'shoppingListId');
  const request = objectPayload(payload.request, 'request');
  const operationFact = objectPayload(payload.operation, 'operation');
  const operationId = requireString(operationFact, 'id');
  const requestHash = requireString(operationFact, 'payloadHash');
  const existing = readRow(sql, 'ShoppingCheckinOperation', operationId);
  if (existing) {
    if (
      String(existing.shoppingListId) !== listId ||
      String(existing.payloadHash) !== requestHash
    ) {
      throw new ReplayConflict({
        operationId: operation.id,
        code: 'IDEMPOTENCY_CONFLICT',
        serverVersion: null,
      });
    }
    return { newVersion: Number(payload.listVersion ?? 1), changes: changes.list() };
  }

  const { row: list, version } = commandTarget(sql, operation, payload);
  if (String(list.id) !== listId) throw new ReplayValidationError('shoppingListId 与实体不一致');
  const executedAt = requireString(payload, 'executedAt');
  const purchaseDate = requireString(payload, 'purchaseDate');

  for (const fact of arrayPayload(payload.inventory)) {
    const ingredientId = requireString(fact, 'ingredientId');
    const kind = requireString(fact, 'kind');
    const createdIngredient = fact.createdIngredient === true;
    const ingredient = readRow(sql, 'Ingredient', ingredientId);
    if (createdIngredient) {
      if (ingredient) {
        throw new ReplayConflict({
          operationId: operation.id,
          code: 'VERSION_CONFLICT',
          serverVersion: rowVersion(ingredient, 'Ingredient'),
          winner: ingredient as never,
        });
      }
      insertRow(sql, 'Ingredient', {
        id: ingredientId,
        name: fact.ingredientNameSnapshot,
        imagePath: null,
        category: fact.ingredientCategory ?? null,
        quantity: fact.ingredientQuantity,
        unit: fact.ingredientUnit,
        purchaseDate,
        expiryDate: null,
        location: null,
        minStock: null,
        maxStock: null,
        opened: 0,
        notes: null,
        version: fact.ingredientVersion,
        deletedAt: null,
        createdAt: executedAt,
        updatedAt: executedAt,
      });
      changes.capture('Ingredient', ingredientId);
    } else {
      if (!ingredient) {
        throw new ReplayValidationError(`入库食材不存在: ${ingredientId}`);
      }
      const base = requireNumber(fact, 'ingredientBaseVersion');
      if (rowVersion(ingredient, 'Ingredient') !== base) {
        throw new ReplayConflict({
          operationId: operation.id,
          code: 'VERSION_CONFLICT',
          serverVersion: rowVersion(ingredient, 'Ingredient'),
          ingredientId,
          winner: ingredient as never,
        });
      }
      updateRow(sql, 'Ingredient', ingredientId, {
        quantity: fact.ingredientQuantity,
        category: fact.ingredientCategory ?? ingredient.category ?? null,
        version: fact.ingredientVersion,
        updatedAt: executedAt,
      });
      changes.capture('Ingredient', ingredientId);
    }

    const batchId = requireString(fact, 'batchId');
    insertRow(sql, 'InventoryBatch', {
      id: batchId,
      ingredientId,
      quantity: fact.batchQuantity,
      unit: fact.batchUnit,
      purchaseDate,
      expiryDate: null,
      location: null,
      opened: 0,
      consumePriority: 0,
      notes: null,
      version: 1,
      deletedAt: null,
      createdAt: executedAt,
      updatedAt: executedAt,
    });
    changes.capture('InventoryBatch', batchId);

    const logId = requireString(fact, 'logId');
    insertRow(sql, 'InventoryLog', {
      id: logId,
      ingredientId,
      ingredientNameSnapshot: fact.ingredientNameSnapshot,
      inventoryBatchId: batchId,
      beforeQuantity: fact.beforeQuantity,
      changeQuantity: fact.batchQuantity,
      afterQuantity: fact.afterQuantity,
      unit: fact.batchUnit,
      changeType: kind === 'LEGACY_HEAL' ? 'ADJUST' : 'PURCHASE',
      relatedPlanId: null,
      relatedRecordId: null,
      notes: kind === 'LEGACY_HEAL' ? '历史存量自动补建等效批次' : '购物清单入库',
      createdAt: executedAt,
      updatedAt: executedAt,
    });
    changes.capture('InventoryLog', logId);
  }

  const itemIds = Array.isArray(request.itemIds) ? (request.itemIds as string[]) : [];
  for (const itemId of itemIds) {
    const item = readRow(sql, 'ShoppingListItem', itemId);
    if (!item || String(item.shoppingListId) !== listId) {
      throw new ReplayValidationError(`入库条目不存在或不属于该清单: ${itemId}`);
    }
    sql.exec(`DELETE FROM "ShoppingListItem" WHERE "id" = ?`, itemId);
    // 物理删除留墓碑：长离线客户端带着旧清单推送时不能把入库条目复活。
    rememberTombstone(sql, 'ShoppingListItem', itemId, version + 1);
    changes.record('ShoppingListItem', itemId, null);
  }

  const listVersion = requireNumber(payload, 'listVersion');
  if (listVersion !== version + 1) {
    throw new ReplayValidationError('listVersion 必须等于 baseVersion + 1');
  }
  updateRow(sql, 'ShoppingList', listId, { version: listVersion, updatedAt: executedAt });
  changes.capture('ShoppingList', listId);

  insertRow(sql, 'ShoppingCheckinOperation', {
    id: operationId,
    shoppingListId: listId,
    payloadHash: requestHash,
    resultJson: requireString(operationFact, 'resultJson'),
    createdAt: executedAt,
  });
  changes.capture('ShoppingCheckinOperation', operationId);
  return { newVersion: listVersion, changes: changes.list() };
}

export const COMMAND_HANDLERS: Readonly<
  Record<
    string,
    (
      sql: SqlStorage,
      operation: Extract<SyncOperation, { kind: 'command' }>,
      payload: RawRow,
      changes: ChangeCollector,
    ) => ReplayResult
  >
> = {
  INGREDIENT_CONSUME: consumeIngredient,
  INGREDIENT_UPDATE_SYNC_BATCHES: updateIngredientBatches,
  PLAN_COMPLETE: completePlan,
  PLAN_UNCOMPLETE: uncompletePlan,
  RECORD_DELETE: deleteMealRecord,
  RECIPE_COOK_CHECKIN: recipeCookCheckin,
  SHOPPING_CHECKIN: shoppingCheckin,
};

export type { SyncRowChange, RawRow, SyncEntityName };
