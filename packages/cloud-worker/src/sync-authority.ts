import type {
  SyncAuthoritativeAggregate,
  SyncEntityName,
  SyncOperation,
  SyncRejection,
  SyncRowChange,
} from '@dafan/shared/sync';

import { ENTITY_CHILDREN } from './sync-replay-tables';
import { FOREIGN_KEYS, readRow, rows, type RawRow } from './sync-replay-support';

/**
 * 冲突拒绝时随响应下发的权威聚合行。
 *
 * 必须在 push 批事务回滚之后调用：此时库内就是「被拒操作从未发生过」的权威状态。
 * 端侧据此在同一写事务里完整替换本地父子表，而不用猜测哪些本地副作用需要清理。
 *
 * 约定：
 * - 每个被拒操作的根各成一个单元；本来就不存在（如新建计划撞槽）时 `rows = []`；
 * - 冲突 `winner` 的根单独成单元；
 * - 关联实体（`PLAN_COMPLETE` 自动产生的 `MealRecord`、`SHOPPING_CHECKIN` 入库的
 *   `Ingredient` 等）各成单元；
 * - 同批被连带丢弃的后继操作（`chain`）触及的根与副根同样成单元，避免只回滚
 *   `Op1` 而把 `Op2..` 造成的本地脏状态留在端侧；
 * - 每个单元携带完整父子行，含软删行（`row` 为整行，不做裁剪）；
 * - 权威子行引用的其它聚合根（对端新建的 Recipe/Tag/Diner/Ingredient/...）以
 *   `dependency` 单元补齐。端侧尚未 pull 时这些外键目标在本地不存在，若不下发，
 *   收敛事务会在 COMMIT 时触发 `SQLITE_CONSTRAINT_FOREIGNKEY`。
 */

interface Root {
  readonly entity: SyncEntityName;
  readonly id: string;
}

function asRoot(entity: unknown, id: unknown): Root | null {
  if (typeof entity !== 'string' || typeof id !== 'string' || id.length === 0) return null;
  return { entity: entity as SyncEntityName, id };
}

function idOf(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function objectOf(value: unknown): RawRow | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RawRow) : null;
}

function payloadRoots(operation: SyncOperation): Root[] {
  if (operation.kind !== 'command') return [];
  const payload = objectOf(operation.payload) ?? {};
  const roots: Root[] = [];
  const push = (entity: unknown, id: unknown) => {
    const root = asRoot(entity, id);
    if (root) roots.push(root);
  };

  switch (operation.commandType) {
    case 'PLAN_COMPLETE':
      // 自动落库的饮食记录与计划同属一次被拒业务，本地草稿/子行都要一起收敛。
      push('MealRecord', idOf(objectOf(payload.record)?.id));
      break;
    case 'PLAN_UNCOMPLETE':
      push('MealRecord', idOf(objectOf(payload.removedRecord)?.id));
      break;
    case 'RECORD_DELETE':
      push('MealPlan', idOf(objectOf(payload.revertedPlan)?.id));
      break;
    case 'RECIPE_COOK_CHECKIN':
      push('MealRecord', idOf(objectOf(payload.record)?.id));
      break;
    case 'SHOPPING_CHECKIN':
      for (const fact of Array.isArray(payload.inventory) ? payload.inventory : []) {
        push('Ingredient', idOf(objectOf(fact)?.ingredientId));
      }
      break;
    default:
      break;
  }
  return roots;
}

function collect(sql: SqlStorage, root: Root): SyncAuthoritativeAggregate | null {
  const parent = readRow(sql, root.entity, root.id);
  const changes: SyncRowChange[] = [];
  if (parent) {
    changes.push({ table: root.entity, id: parent.id as string | number, row: parent as never });
  }
  for (const [table, column] of ENTITY_CHILDREN[root.entity] ?? []) {
    for (const child of rows(
      sql,
      `SELECT * FROM "${table}" WHERE "${column}" = ? ORDER BY "id"`,
      root.id,
    )) {
      changes.push({ table, id: child.id as string | number, row: child as never });
    }
  }
  return { entity: root.entity, entityId: root.id, rows: changes };
}

/**
 * 外键闭包：为所有已下发行中被引用、但尚未包含的目标行追加 `dependency` 单元。
 *
 * 只补父行、不展开目标的子行：端侧只需要外键目标存在即可提交，随后增量拉取会把
 * 目标聚合的其余事实补齐。目标行本身若也引用别行，递归补齐。
 */
function collectDependencies(
  sql: SqlStorage,
  aggregates: readonly SyncAuthoritativeAggregate[],
): SyncAuthoritativeAggregate[] {
  const known = new Set<string>();
  const queue: { table: SyncEntityName; row: RawRow }[] = [];
  for (const unit of aggregates) {
    for (const change of unit.rows) {
      known.add(`${change.table}\u0000${String(change.id)}`);
      if (change.row) queue.push({ table: change.table, row: change.row as RawRow });
    }
  }

  const dependencies: SyncAuthoritativeAggregate[] = [];
  while (queue.length > 0) {
    const { table, row } = queue.shift()!;
    for (const [column, target] of FOREIGN_KEYS[table] ?? []) {
      const value = row[column];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      const key = `${target}\u0000${String(value)}`;
      if (known.has(key)) continue;
      const parent = readRow(sql, target, value);
      // 云端账本自身受外键约束，正常不会出现悬空引用；真出现时不让拒绝响应失败，
      // 端侧仍有后续增量拉取兜底。
      if (!parent) continue;
      const id = idOf(parent.id);
      if (!id) continue;
      known.add(key);
      queue.push({ table: target, row: parent });
      dependencies.push({
        entity: target,
        entityId: id,
        rows: [{ table: target, id: parent.id as string | number, row: parent as never }],
        dependency: true,
      });
    }
  }
  return dependencies;
}

/** 自然键（`Tag(name,type)`）在云端已有同键行时，把既有行也算作被拒根。 */
function naturalKeyRoot(sql: SqlStorage, operation: SyncOperation): Root | null {
  if (operation.kind !== 'upsert' || operation.entity !== 'Tag') return null;
  const payload = objectOf(operation.payload) ?? {};
  if (typeof payload.name !== 'string') return null;
  const type = typeof payload.type === 'string' ? payload.type : 'GENERAL';
  const existing = rows(
    sql,
    `SELECT "id" FROM "Tag" WHERE "name" = ? AND "type" = ?`,
    payload.name,
    type,
  )[0];
  const id = existing ? idOf(existing.id) : null;
  return id && id !== operation.entityId ? { entity: 'Tag', id } : null;
}

export function authoritativeRejection(
  sql: SqlStorage,
  operation: SyncOperation,
  rejection: SyncRejection,
  chain: readonly SyncOperation[] = [],
): SyncRejection {
  const roots: Root[] = [
    { entity: operation.entity, id: operation.entityId },
    ...payloadRoots(operation),
  ];
  // 整条被丢操作链：同聚合根的后续命令/写入同样从未在云端发生，
  // 它们改过的副根（记录、食材、清单条目…）必须随权威集合一起回滚。
  for (const successor of chain) {
    roots.push({ entity: successor.entity, id: successor.entityId });
    roots.push(...payloadRoots(successor));
  }

  const winner = objectOf(rejection.winner);
  if (winner) {
    const root = asRoot(operation.entity, idOf(winner.id));
    if (root) roots.push(root);
  }
  if (rejection.code === 'INSUFFICIENT_STOCK') {
    const root = asRoot('Ingredient', rejection.ingredientId);
    if (root) roots.push(root);
  }
  const natural = naturalKeyRoot(sql, operation);
  if (natural) roots.push(natural);

  const seen = new Set<string>();
  const aggregates: SyncAuthoritativeAggregate[] = [];
  for (const root of roots) {
    const key = `${root.entity}\u0000${root.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const aggregate = collect(sql, root);
    if (aggregate) aggregates.push(aggregate);
  }
  return {
    ...rejection,
    authoritative: [...aggregates, ...collectDependencies(sql, aggregates)],
  };
}
