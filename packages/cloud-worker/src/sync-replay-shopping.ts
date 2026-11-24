import type { SyncEntityName, SyncOperation, SyncPayload } from '@dafan/shared/sync';

import {
  ChangeCollector,
  deleteRow,
  insertRow,
  readRow,
  rememberBaseline,
  rememberTombstone,
  ReplayConflict,
  replaceRowValues,
  resolveColumns,
  sameRow,
  shoppingItems,
  type RawRow,
  type ReplayResult,
  rowVersion,
  updateRow,
  mergeFields,
  readBaseline,
  readTombstone,
  assertForeignKeys,
} from './sync-replay-support';
import { REPLAY_TABLES } from './sync-replay-tables';

/** 活跃购物单的 upsert：逐项三方合并，禁止整单覆盖他人新增项。 */

function replaceListItems(
  sql: SqlStorage,
  listId: string,
  items: readonly RawRow[],
  listVersion: number,
  clientBaseVersion: number | null,
  changes: ChangeCollector,
): void {
  const keep = new Set(items.map((item) => String(item.id)));
  for (const existing of shoppingItems(sql, listId)) {
    if (keep.has(String(existing.id))) continue;
    const existingId = String(existing.id);
    deleteRow(sql, 'ShoppingListItem', existingId);
    // 物理删除无软删列：留墓碑，长离线客户端不能把已删条目当新条目重新插回。
    rememberTombstone(sql, 'ShoppingListItem', existingId, listVersion);
    changes.record('ShoppingListItem', existingId, null);
  }
  for (const item of items) {
    const itemId = String(item.id);
    // 墓碑版本 = 该行被删除时的清单版本。客户端基线早于它，说明客户端没看到删除，
    // 该条目只能视为过期事实；基线不早于它，才允许用户重新添加同 ID 条目。
    const tombstone = readTombstone(sql, 'ShoppingListItem', itemId);
    if (tombstone !== null && (clientBaseVersion === null || clientBaseVersion < tombstone)) {
      continue;
    }
    const values = resolveColumns(REPLAY_TABLES.ShoppingListItem, {
      ...item,
      shoppingListId: listId,
    });
    values.id = itemId;
    values.shoppingListId = listId;
    assertForeignKeys(sql, 'ShoppingListItem', values);
    if (readRow(sql, 'ShoppingListItem', itemId)) {
      updateRow(sql, 'ShoppingListItem', itemId, values);
    } else {
      insertRow(sql, 'ShoppingListItem', values);
    }
    changes.capture('ShoppingListItem', itemId);
  }
}

function versionConflict(operationId: string, serverList: RawRow): ReplayConflict {
  return new ReplayConflict({
    operationId,
    code: 'VERSION_CONFLICT',
    serverVersion: Number(serverList.version ?? 1),
    winner: serverList as SyncPayload,
  });
}

function itemFacts(items: unknown): RawRow[] {
  if (!Array.isArray(items)) return [];
  return (items as RawRow[]).map((item) => ({
    ...item,
    completed: typeof item.completed === 'boolean' ? Number(item.completed) : item.completed,
  }));
}

export function upsertShoppingList(
  sql: SqlStorage,
  operation: Extract<SyncOperation, { kind: 'upsert' }>,
  payload: RawRow,
  changes: ChangeCollector,
): ReplayResult {
  const listId = operation.entityId;
  const current = readRow(sql, 'ShoppingList', listId);
  // 每次 upsert 前保存基线，供后续离线合并精确还原「客户端所见版本」。
  rememberBaseline(sql, 'ShoppingList', current);

  const payloadItems = itemFacts(payload.items);
  // 端侧显式携带的「本次操作前完整条目数组」：多次串行本地修改时，
  // 本地 version 会等于云端 version，但真正的基线是这份快照而非服务端历史。
  const explicitBase = Array.isArray(payload.baseItems) ? itemFacts(payload.baseItems) : null;
  const baseVersion = operation.baseVersion;
  const currentVersion = rowVersion(current, 'ShoppingList');

  if (current && baseVersion !== null && (currentVersion > baseVersion || explicitBase)) {
    return mergeShoppingList(sql, operation, payload, payloadItems, explicitBase, current, changes);
  }
  if (baseVersion !== null) {
    if (!current) {
      throw new ReplayConflict({
        operationId: operation.id,
        code: 'VERSION_CONFLICT',
        serverVersion: null,
      });
    }
    if (currentVersion !== baseVersion) throw versionConflict(operation.id, current);
  } else if (current && currentVersion !== Number(payload.version ?? 1)) {
    throw versionConflict(operation.id, current);
  }

  const nextVersion = baseVersion === null ? Number(payload.version ?? 1) : baseVersion + 1;
  const values = resolveColumns(REPLAY_TABLES.ShoppingList, payload);
  values.id = listId;
  values.version = nextVersion;
  values.deletedAt = payload.deletedAt ?? null;
  delete (values as RawRow).items;

  if (current) updateRow(sql, 'ShoppingList', listId, values);
  else insertRow(sql, 'ShoppingList', values);
  replaceListItems(sql, listId, payloadItems, nextVersion, baseVersion, changes);
  changes.capture('ShoppingList', listId);
  rememberBaseline(sql, 'ShoppingList', readRow(sql, 'ShoppingList', listId));
  return { newVersion: nextVersion, changes: changes.list() };
}

function mergeShoppingList(
  sql: SqlStorage,
  operation: Extract<SyncOperation, { kind: 'upsert' }>,
  payload: RawRow,
  payloadItems: readonly RawRow[],
  explicitBase: readonly RawRow[] | null,
  serverList: RawRow,
  changes: ChangeCollector,
): ReplayResult {
  const listId = String(serverList.id);
  const baseVersion = operation.baseVersion as number;
  const baseline = readBaseline(sql, 'ShoppingList', listId, baseVersion);
  const serverItems = shoppingItems(sql, listId);
  // 客户端显式快照就是「本次操作前本地所见」，优先于服务端按版本记录的历史基线。
  const baseSource = explicitBase ?? baseline?.items ?? [];
  const baseItems = new Map(baseSource.map((item) => [String(item.id), item] as const));
  const serverById = new Map(serverItems.map((item) => [String(item.id), item] as const));
  const clientById = new Map(payloadItems.map((item) => [String(item.id), item] as const));

  const finalItems: RawRow[] = [];
  const ids = new Set<string>([...baseItems.keys(), ...serverById.keys(), ...clientById.keys()]);
  for (const id of ids) {
    const base = baseItems.get(id);
    const client = clientById.get(id);
    const server = serverById.get(id);
    if (!client) {
      // 客户端在基线中见过该行却未再提交：视为删除；服务端并发改过的行保留服务端。
      if (!server) continue;
      if (base && sameRow(base, server)) continue;
      finalItems.push(server);
      continue;
    }
    if (!server) {
      finalItems.push(client);
      continue;
    }
    if (base && sameRow(base, client)) {
      finalItems.push(server);
      continue;
    }
    if (base && sameRow(base, server)) {
      finalItems.push(client);
      continue;
    }
    if (!base) {
      const clientAt = String(client.updatedAt ?? '');
      const serverAt = String(server.updatedAt ?? '');
      finalItems.push(clientAt >= serverAt ? client : server);
      continue;
    }
    finalItems.push(mergeFields(client, base, server));
  }

  // 墓碑优先于任何载荷内容：只有客户端基线版本不早于删除版本，才允许条目重新出现。
  // 基线落后（或未带基线）说明客户端没见过这次删除，属于复活已删条目。
  const survivors = finalItems.filter((item) => {
    const tombstone = readTombstone(sql, 'ShoppingListItem', String(item.id));
    return tombstone === null || baseVersion >= tombstone;
  });

  const nextVersion = rowVersion(serverList, 'ShoppingList') + 1;
  const merged = mergeFields(payload, baseline?.row, serverList);
  const updatedAt =
    String(payload.updatedAt ?? '') >= String(serverList.updatedAt ?? '')
      ? (payload.updatedAt ?? serverList.updatedAt)
      : serverList.updatedAt;

  replaceRowValues(sql, 'ShoppingList', listId, {
    name: merged.name ?? serverList.name,
    status: merged.status ?? serverList.status,
    notes: merged.notes ?? null,
    deletedAt: serverList.deletedAt ?? null,
    version: nextVersion,
    updatedAt,
  });
  replaceListItems(sql, listId, survivors, nextVersion, baseVersion, changes);
  changes.capture('ShoppingList', listId);
  rememberBaseline(sql, 'ShoppingList', readRow(sql, 'ShoppingList', listId));
  return { newVersion: nextVersion, changes: changes.list() };
}

export type { SyncEntityName };
