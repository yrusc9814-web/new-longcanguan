/**
 * 增量拉取与冲突收敛。
 *
 * 无回声铁律：云端行写入本地业务表时绝不入队 `sync_outbox`；
 * 本地仍有未确认写入的 `(entity, entityId)` 默认跳过远端行，避免覆盖用户新操作，
 * 只有冲突判定要求「对齐权威数据」时才强制覆盖。
 */
import type { SyncPullPage, SyncRowChange } from '@dafan/shared/sync';

import type { DatabaseClient, WriteTransaction } from '../db/database.js';
import { SyncHttpError } from './http.js';
import type { SyncHttpClient } from './http.js';
import {
  applyRowChanges,
  createColumnCache,
  pendingEntityKeys,
  readSyncState,
  writeSyncState,
  type ColumnCache,
} from './ledger.js';
import type { PushConflict } from './push.js';

export interface PullResult {
  readonly applied: number;
  readonly nextSeq: number;
  readonly hasMore: boolean;
  readonly epoch: number;
  /** 因本地未确认操作而跳过的行（父/子同进退）。 */
  readonly skipped: readonly string[];
}

/**
 * 聚合根 → 子表（父列）：父表存在未确认操作时，其子表行必须一起跳过，
 * 否则本地聚合被云端子行拆散，推送失败后也无从得知该对齐哪些行。
 */
const AGGREGATE_CHILDREN: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  Ingredient: [
    ['InventoryBatch', 'ingredientId'],
    ['InventoryLog', 'ingredientId'],
  ],
  Recipe: [
    ['RecipeIngredient', 'recipeId'],
    ['RecipeStep', 'recipeId'],
    ['RecipeTag', 'recipeId'],
    ['RecipeMealType', 'recipeId'],
    ['RecipeMealRole', 'recipeId'],
    ['RecipeTool', 'recipeId'],
  ],
  Store: [
    ['StoreMealType', 'storeId'],
    ['StoreMenuItem', 'storeId'],
  ],
  MealPlan: [
    ['MealPlanItem', 'mealPlanId'],
    ['MealPlanDiner', 'mealPlanId'],
  ],
  MealRecord: [
    ['MealRecordItem', 'mealRecordId'],
    ['MealRecordDiner', 'mealRecordId'],
  ],
  ShoppingList: [['ShoppingListItem', 'shoppingListId']],
};

/** 子表 → (聚合根, 父列)：子行必须能归到某个聚合根。 */
const CHILD_PARENT = new Map<string, { root: string; column: string }>();
for (const [root, children] of Object.entries(AGGREGATE_CHILDREN)) {
  for (const [table, column] of children) CHILD_PARENT.set(table, { root, column });
}

export interface PullOptions {
  readonly database: DatabaseClient;
  readonly http: SyncHttpClient;
  readonly epoch: number;
  readonly limit?: number;
  readonly cache?: ColumnCache;
  /** 强制覆盖这些实体的本地行（冲突对齐时使用）。 */
  readonly forceKeys?: readonly string[];
  /** 是否跳过本地未确认实体，默认 true。 */
  readonly respectPending?: boolean;
  /** 每页实际写入的行（用于图片下载入队等副作用）。 */
  readonly onApplied?: (changes: readonly SyncRowChange[]) => void;
}

function parsePage(raw: unknown): SyncPullPage {
  if (!raw || typeof raw !== 'object') throw new SyncHttpError(502, 'BAD_RESPONSE', '拉取响应无效');
  const page = raw as Partial<SyncPullPage>;
  if (!Array.isArray(page.entries)) {
    throw new SyncHttpError(502, 'BAD_RESPONSE', '拉取响应缺少 entries');
  }
  const nextSeq = Number(page.nextSeq);
  if (!Number.isSafeInteger(nextSeq) || nextSeq < 0) {
    throw new SyncHttpError(502, 'BAD_RESPONSE', '拉取响应 nextSeq 无效');
  }
  return {
    epoch: Number(page.epoch),
    entries: page.entries,
    nextSeq,
    hasMore: page.hasMore === true,
  };
}

/** 拉取一页并写入本地；返回本次推进后的序号。 */
export async function pullOnce(options: PullOptions): Promise<PullResult> {
  const state = await readSyncState(options.database);
  return pullFrom(options, state.lastSeq);
}

export async function pullFrom(options: PullOptions, after: number): Promise<PullResult> {
  const page = parsePage(
    await options.http.request(`/api/sync/pull?after=${after}&limit=${options.limit ?? 200}`),
  );
  const cache = options.cache ?? createColumnCache();
  const force = new Set(options.forceKeys ?? []);
  const pending =
    (options.respectPending ?? true)
      ? await pendingEntityKeys(options.database, options.epoch)
      : new Set<string>();
  let applied = 0;
  const skipped: string[] = [];
  await options.database.withWriteTransaction(async (tx) => {
    for (const entry of page.entries) {
      const accepted: SyncRowChange[] = [];
      for (const change of entry.changes) {
        const table = String(change.table);
        const key = `${table}:${String(change.id)}`;
        if (force.has(key)) {
          accepted.push(change);
          continue;
        }
        // 父行有未确认操作：父表与全部聚合子表同进退跳过。
        if (pending.has(key)) {
          skipped.push(key);
          continue;
        }
        // 子表按其父列归属到聚合根：父根有未确认操作时同样跳过。
        const parent = CHILD_PARENT.get(table);
        if (parent) {
          const row = change.row as Record<string, unknown> | null;
          let parentId: unknown = row?.[parent.column];
          if (parentId === undefined || parentId === null) {
            const [local] = await tx.query<Record<string, unknown>>(
              `SELECT "${parent.column}" FROM "${table}" WHERE "id" = ?`,
              [change.id as string | number],
            );
            parentId = local?.[parent.column];
          }
          if (parentId !== undefined && parentId !== null) {
            const parentKey = `${parent.root}:${String(parentId)}`;
            if (pending.has(parentKey)) {
              skipped.push(key);
              continue;
            }
          }
        }
        accepted.push(change);
      }
      if (accepted.length === 0) continue;
      await applyRowChanges(tx, cache, accepted);
      applied += accepted.length;
      options.onApplied?.(accepted);
    }
    await writeSyncState(tx, page.epoch || options.epoch, page.nextSeq);
  });

  return {
    applied,
    nextSeq: page.nextSeq,
    hasMore: page.hasMore,
    epoch: page.epoch || options.epoch,
    skipped,
  };
}

/** 循环拉取直到追平。 */
export async function pullUntilIdle(options: PullOptions, maxPages = 20): Promise<PullResult> {
  let total = 0;
  let last = await pullOnce(options);
  total += last.applied;
  let pages = 1;
  while (last.hasMore && pages < maxPages) {
    last = await pullFrom(options, last.nextSeq);
    total += last.applied;
    pages += 1;
  }
  return { ...last, applied: total };
}

/** 冲突后强制对齐指定实体（不受本地未确认行保护）。 */
export async function alignConflictedEntities(
  options: Omit<PullOptions, 'forceKeys' | 'respectPending'>,
  conflicts: readonly PushConflict[],
): Promise<PullResult> {
  const keys = [...new Set(conflicts.map((conflict) => `${conflict.entity}:${conflict.entityId}`))];
  return pullUntilIdle({ ...options, forceKeys: keys, respectPending: false });
}

/**
 * 回滚本地未确认的排餐新建：删除该计划及其子行，清掉发件箱里该计划的全部操作。
 *
 * 只回滚「本地新建但服务端拒绝」的计划；已确认的排餐不会被这里删除。
 */
export async function rollbackLocalPlan(database: DatabaseClient, planId: string): Promise<void> {
  await database.withWriteTransaction(async (tx) => {
    await tx.run(`DELETE FROM "sync_outbox" WHERE "entity" = 'MealPlan' AND "entityId" = ?`, [
      planId,
    ]);
    await tx.run(`DELETE FROM "MealPlanItem" WHERE "mealPlanId" = ?`, [planId]);
    await tx.run(`DELETE FROM "MealPlanDiner" WHERE "mealPlanId" = ?`, [planId]);
    await tx.run(`DELETE FROM "MealPlan" WHERE "id" = ?`, [planId]);
  });
}

interface RollbackIds {
  readonly batchIds: Set<string>;
  readonly logIds: Set<string>;
  readonly ingredientIds: Set<string>;
  readonly recordIds: Set<string>;
  readonly checkinOperationIds: Set<string>;
  /** 被拒 `SHOPPING_CHECKIN` 从清单里删掉的条目（载荷保存了完整行，需原样放回）。 */
  readonly restoredItems: Map<string, Record<string, unknown>>;
  /** 被拒 `RECORD_DELETE` 本地已软删的记录：恢复未删除并还原来源计划引用。 */
  readonly restoredRecords: Map<
    string,
    { sourceMealPlanId: string | null; updatedAt: string | null }
  >;
  /** 被拒 `RECORD_DELETE` 同事务回退的排餐：恢复为完成态。 */
  readonly revertedPlans: Map<string, Record<string, unknown>>;
  planId: string | null;
  planIsNew: boolean;
}

function emptyRollbackIds(): RollbackIds {
  return {
    batchIds: new Set(),
    logIds: new Set(),
    ingredientIds: new Set(),
    recordIds: new Set(),
    checkinOperationIds: new Set(),
    restoredItems: new Map(),
    restoredRecords: new Map(),
    revertedPlans: new Map(),
    planId: null,
    planIsNew: false,
  };
}

function collectIngredientRefs(payload: Record<string, unknown> | null, into: RollbackIds): void {
  if (!payload) return;
  const collect = (ref: unknown) => {
    if (!ref || typeof ref !== 'object') return;
    const entry = ref as { batchId?: unknown; logId?: unknown };
    if (typeof entry.batchId === 'string') into.batchIds.add(entry.batchId);
    if (typeof entry.logId === 'string') into.logIds.add(entry.logId);
  };
  collect(payload.implicitBatch);
  collect(payload.addedBatch);
  if (Array.isArray(payload.deductions)) {
    for (const deduction of payload.deductions) {
      const logId = (deduction as { logId?: unknown } | null)?.logId;
      if (typeof logId === 'string') into.logIds.add(logId);
    }
  }
  if (Array.isArray(payload.replacedBatches)) payload.replacedBatches.forEach(collect);
  if (Array.isArray(payload.inventoryLogIds)) {
    for (const id of payload.inventoryLogIds) if (typeof id === 'string') into.logIds.add(id);
  }
}

/** 收集整条被丢操作链上每个操作产生的本地副作用主键。 */
function collectChainEffects(conflict: PushConflict): RollbackIds {
  const ids = emptyRollbackIds();
  for (const operation of conflict.chain) {
    const payload = operation.payloadJson === null ? null : JSON.parse(operation.payloadJson);
    const data = payload as Record<string, unknown> | null;
    switch (operation.commandType) {
      case 'INGREDIENT_CONSUME':
      case 'INGREDIENT_UPDATE_SYNC_BATCHES':
        collectIngredientRefs(data, ids);
        break;
      case 'SHOPPING_CHECKIN': {
        if (data && Array.isArray(data.inventory)) {
          for (const fact of data.inventory as Record<string, unknown>[]) {
            if (typeof fact.batchId === 'string') ids.batchIds.add(fact.batchId);
            if (typeof fact.logId === 'string') ids.logIds.add(fact.logId);
            // 本次入库新建的食材：拒绝后必须一并移除，避免留下幽灵食材。
            if (fact.createdIngredient === true && typeof fact.ingredientId === 'string') {
              ids.ingredientIds.add(fact.ingredientId);
            }
          }
        }
        if (data && Array.isArray(data.items)) {
          for (const item of data.items as Record<string, unknown>[]) {
            if (typeof item.id === 'string') ids.restoredItems.set(item.id, item);
          }
        }
        const operationFact = data?.operation as Record<string, unknown> | undefined;
        if (operationFact && typeof operationFact.id === 'string') {
          ids.checkinOperationIds.add(operationFact.id);
        }
        break;
      }
      case 'PLAN_COMPLETE': {
        const record = data?.record as Record<string, unknown> | undefined;
        // 只整体删除本次命令新建的草稿记录：复活的记录原本是软删行，
        // 载荷不含旧 proof 与旧版本，删除会丢历史，因此保留交给权威行校正。
        if (record && typeof record.id === 'string' && data?.recordCreated === true) {
          ids.recordIds.add(record.id);
        }
        break;
      }
      case 'RECIPE_COOK_CHECKIN': {
        const record = data?.record as Record<string, unknown> | undefined;
        if (record && typeof record.id === 'string') ids.recordIds.add(record.id);
        break;
      }
      case 'RECORD_DELETE': {
        // 本地已完成软删（并可能回退了来源计划）：拒绝后把记录恢复为未删除，
        // 版本与计划状态交给随后的权威行/增量对齐，避免删了却不存在的幽灵状态。
        if (data && typeof data.id === 'string') {
          ids.restoredRecords.set(data.id, {
            sourceMealPlanId:
              typeof data.releasedSourceMealPlanId === 'string'
                ? data.releasedSourceMealPlanId
                : null,
            updatedAt: typeof data.executedAt === 'string' ? data.executedAt : null,
          });
          const reverted = data.revertedPlan as Record<string, unknown> | null | undefined;
          if (reverted && typeof reverted.id === 'string') {
            ids.revertedPlans.set(reverted.id, reverted);
          }
        }
        break;
      }
      default:
        if (operation.entity === 'MealPlan') {
          ids.planId = operation.entityId;
          if (operation.baseVersion === null) ids.planIsNew = true;
        }
    }
  }
  return ids;
}
/** 在事务内删除聚合根的全部关联子行（父列名由 `AGGREGATE_CHILDREN` 推导）。 */
async function deleteAggregateChildren(
  tx: WriteTransaction,
  root: string,
  rootId: string,
): Promise<void> {
  for (const [table, column] of AGGREGATE_CHILDREN[root] ?? []) {
    await tx.run(`DELETE FROM "${table}" WHERE "${column}" = ?`, [rootId]);
  }
}

/** 回滚被丢操作链的全部本地副作用（不含权威行对齐）。 */
async function rollbackChainEffects(tx: WriteTransaction, ids: RollbackIds): Promise<void> {
  for (const id of ids.batchIds) {
    await tx.run(`DELETE FROM "InventoryLog" WHERE "inventoryBatchId" = ?`, [id]);
    await tx.run(`DELETE FROM "InventoryBatch" WHERE "id" = ?`, [id]);
  }
  for (const id of ids.logIds) await tx.run(`DELETE FROM "InventoryLog" WHERE "id" = ?`, [id]);
  for (const id of ids.ingredientIds) {
    await tx.run(`DELETE FROM "InventoryLog" WHERE "ingredientId" = ?`, [id]);
    await tx.run(`DELETE FROM "InventoryBatch" WHERE "ingredientId" = ?`, [id]);
    await tx.run(`DELETE FROM "ShoppingListItem" WHERE "ingredientId" = ?`, [id]);
    await tx.run(`DELETE FROM "RecipeIngredient" WHERE "ingredientId" = ?`, [id]);
    await tx.run(`DELETE FROM "Ingredient" WHERE "id" = ?`, [id]);
  }
  for (const id of ids.recordIds) {
    await tx.run(`DELETE FROM "MealRecordItem" WHERE "mealRecordId" = ?`, [id]);
    await tx.run(`DELETE FROM "MealRecordDiner" WHERE "mealRecordId" = ?`, [id]);
    await tx.run(`DELETE FROM "MealRecord" WHERE "id" = ?`, [id]);
  }
  for (const id of ids.checkinOperationIds) {
    await tx.run(`DELETE FROM "ShoppingCheckinOperation" WHERE "id" = ?`, [id]);
  }
  for (const [id, row] of ids.restoredRecords) {
    await tx.run(
      `UPDATE "MealRecord" SET "deletedAt" = NULL, "sourceMealPlanId" = ?,
         "updatedAt" = COALESCE(?, "updatedAt")
        WHERE "id" = ?`,
      [row.sourceMealPlanId, row.updatedAt, id],
    );
  }
  for (const [id, plan] of ids.revertedPlans) {
    // 本地已把来源计划回退为 PLANNED 并 +1 版本；拒绝后回退这次本地回退：
    // 状态恢复 COMPLETED、版本退回本次写入前的值。完成时间载荷未携带，
    // 保持本地值不变，最终由权威集合或后续增量对齐校正。
    const version = typeof plan.version === 'number' ? plan.version : null;
    await tx.run(
      `UPDATE "MealPlan" SET "status" = 'COMPLETED', "version" = COALESCE(?, "version")
        WHERE "id" = ?`,
      [version === null ? null : version - 1, id],
    );
  }
  if (ids.planId && ids.planIsNew) {
    // 只有本地新建、未上云的计划才允许物理删除；既有排餐改期撞槽只回滚内容。
    await deleteAggregateChildren(tx, 'MealPlan', ids.planId);
    await tx.run(`DELETE FROM "MealPlan" WHERE "id" = ?`, [ids.planId]);
  }
}

/**
 * 用云端权威聚合行完整替换本地父子表：先删掉本地多出来的子行，
 * 再按行 upsert/删除，保证「回滚后本地聚合 == 服务端聚合」。
 */
async function applyAuthoritative(
  tx: WriteTransaction,
  cache: ColumnCache,
  authoritative: PushConflict['authoritative'],
): Promise<void> {
  for (const entry of authoritative) {
    const root = String(entry.entity);
    if (entry.rows.length === 0) {
      await deleteAggregateChildren(tx, root, entry.entityId);
      await tx.run(`DELETE FROM "${root}" WHERE "id" = ?`, [entry.entityId]);
      continue;
    }
    for (const [table, column] of AGGREGATE_CHILDREN[root] ?? []) {
      const keep = entry.rows
        .filter((change) => String(change.table) === table && change.row !== null)
        .map((change) => change.id as string | number);
      if (keep.length === 0) {
        await tx.run(`DELETE FROM "${table}" WHERE "${column}" = ?`, [entry.entityId]);
        continue;
      }
      await tx.run(
        `DELETE FROM "${table}" WHERE "${column}" = ? AND "id" NOT IN (${keep.map(() => '?').join(', ')})`,
        [entry.entityId, ...keep],
      );
    }
    await applyRowChanges(tx, cache, entry.rows);
  }
}

export interface ConvergeOutcome {
  readonly planRemoved: boolean;
  readonly ingredientRolledBack: boolean;
  /** 服务端是否给出了权威聚合行（旧版服务端可能没有）。 */
  readonly authoritative: boolean;
}

/**
 * 冲突收敛的本地事务部分：整条被丢操作链的本地副作用回滚与云端权威集合落库，
 * 在同一个写事务内完成（要么全回滚并完整对齐，要么全不生效）。
 */
export async function applyPushConflicts(
  tx: WriteTransaction,
  conflicts: readonly PushConflict[],
): Promise<Map<string, ConvergeOutcome>> {
  const outcomes = new Map<string, ConvergeOutcome>();
  if (conflicts.length === 0) return outcomes;
  const cache = createColumnCache();
  await tx.exec('PRAGMA defer_foreign_keys = ON');
  for (const conflict of conflicts) {
    const ids = collectChainEffects(conflict);
    await rollbackChainEffects(tx, ids);
    // 被拒入库移除的条目先还原，再让权威行覆盖。
    for (const [id, row] of ids.restoredItems) {
      const [existing] = await tx.query<{ id: string }>(
        `SELECT "id" FROM "ShoppingListItem" WHERE "id" = ?`,
        [id],
      );
      if (existing) continue;
      await applyRowChanges(tx, cache, [{ table: 'ShoppingListItem', id, row: row as never }]);
    }
    await applyAuthoritative(tx, cache, conflict.authoritative);
    outcomes.set(conflict.opId, {
      planRemoved: Boolean(ids.planId && ids.planIsNew),
      ingredientRolledBack: ids.batchIds.size > 0 || ids.logIds.size > 0,
      authoritative: conflict.authoritative.length > 0,
    });
  }
  return outcomes;
}

export async function convergePushConflicts(
  database: DatabaseClient,
  conflicts: readonly PushConflict[],
): Promise<Map<string, ConvergeOutcome>> {
  return database.withWriteTransaction((tx) => applyPushConflicts(tx, conflicts));
}

/**
 * 回滚本地未确认的库存扣减：删除被拒操作产生的批次与日志，
 * 并把食材恢复为服务端确认的版本（由随后的强制拉取写入权威行）。
 */
export async function rollbackLocalIngredient(
  database: DatabaseClient,
  conflict: PushConflict,
): Promise<void> {
  const ids = collectChainEffects(conflict);
  await database.withWriteTransaction(async (tx) => {
    for (const id of ids.batchIds) {
      await tx.run(`DELETE FROM "InventoryLog" WHERE "inventoryBatchId" = ?`, [id]);
      await tx.run(`DELETE FROM "InventoryBatch" WHERE "id" = ?`, [id]);
    }
    for (const id of ids.logIds) await tx.run(`DELETE FROM "InventoryLog" WHERE "id" = ?`, [id]);
  });
}
