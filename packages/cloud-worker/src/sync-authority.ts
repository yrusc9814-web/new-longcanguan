import type {
  SyncAuthoritativeAggregate,
  SyncEntityName,
  SyncOperation,
  SyncRejection,
  SyncRowChange,
} from '@dafan/shared/sync';

import { ENTITY_CHILDREN } from './sync-replay-tables';
import { readRow, rows, type RawRow } from './sync-replay-support';

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
 * - 每个单元携带完整父子行，含软删行（`row` 为整行，不做裁剪）。
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
): SyncRejection {
  const roots: Root[] = [{ entity: operation.entity, id: operation.entityId }];

  const winner = objectOf(rejection.winner);
  if (winner) {
    const root = asRoot(operation.entity, idOf(winner.id));
    if (root) roots.push(root);
  }
  if (rejection.code === 'INSUFFICIENT_STOCK') {
    const root = asRoot('Ingredient', rejection.ingredientId);
    if (root) roots.push(root);
  }
  roots.push(...payloadRoots(operation));
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
  return { ...rejection, authoritative: aggregates };
}
