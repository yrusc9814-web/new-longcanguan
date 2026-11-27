/**
 * AC2 回归：购物单长离线连续多步修改不得复活已删/已入库条目。
 *
 * 关键证据是「本次操作前的显式基线」而不是端侧自增的分叉 `baseVersion`：
 * 客户端没 pull 到服务端删除时，连续 2/3 步本地修改会把 `baseVersion` 推到
 * 墓碑版本之上，旧逻辑据此误判「已见过删除」。
 */
import { describe, expect, it } from 'vitest';

import type { SyncOperation } from '@dafan/shared/sync';

import { replayOperation } from '../src/sync-replay';
import { ledger, type Ledger } from './sync-replay-helpers';

const TS = '2026-11-21T08:00:00.000Z';
const LIST = 'shopping_list_active_default';

interface ItemFact extends Record<string, unknown> {
  id: string;
}

function item(id: string, sortOrder: number, overrides: Record<string, unknown> = {}): ItemFact {
  return {
    id,
    shoppingListId: LIST,
    ingredientId: null,
    ingredientNameSnapshot: id,
    quantity: 1,
    unit: 'PIECE',
    amountText: null,
    category: null,
    sourceType: 'MANUAL',
    sourceId: null,
    completed: 0,
    sortOrder,
    notes: null,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function listPayload(
  version: number,
  items: readonly ItemFact[],
  baseItems?: readonly ItemFact[],
): Record<string, unknown> {
  return {
    id: LIST,
    name: '购物清单',
    status: 'ACTIVE',
    notes: null,
    version,
    deletedAt: null,
    createdAt: TS,
    updatedAt: TS,
    items,
    ...(baseItems ? { baseItems } : {}),
  };
}

function replay(
  target: Ledger,
  id: string,
  baseVersion: number,
  version: number,
  items: readonly ItemFact[],
  baseItems?: readonly ItemFact[],
): void {
  replayOperation(target.sql, {
    id,
    entity: 'ShoppingList',
    entityId: LIST,
    kind: 'upsert',
    baseVersion,
    payload: listPayload(version, items, baseItems) as never,
  } as SyncOperation);
}

function itemIds(target: Ledger): string[] {
  return target.sql
    .exec<{ id: string }>(`SELECT "id" FROM "ShoppingListItem" ORDER BY "id"`)
    .toArray()
    .map((row) => row.id);
}

function listVersion(target: Ledger): number {
  return target.sql
    .exec<{ version: number }>(`SELECT "version" FROM "ShoppingList" WHERE "id" = ?`, LIST)
    .one().version;
}

describe('购物单墓碑与长离线连续修改', () => {
  it('服务端删条目后，端侧离线 3 步都不得复活；新增项全部保留', () => {
    const target = ledger();
    try {
      const x = item('item-x', 0);
      const y = item('item-y', 1);
      replay(target, 'seed', null as never, 1, [x, y]);

      // 在线设备先删 X（v2），再删 Y（v3，模拟 SHOPPING_CHECKIN 入库移除）。
      replay(target, 'online-del-x', 1, 2, [y], [x, y]);
      replay(target, 'online-del-y', 2, 3, [], [y]);
      expect(itemIds(target)).toEqual([]);

      // 长离线客户端基于 v1（[X,Y]）连续 3 步：新增 A、改 A、再新增 B。
      const a1 = item('item-a', 2);
      replay(target, 'offline-1', 1, 2, [x, y, a1], [x, y]);
      const a2 = item('item-a', 2, { quantity: 2 });
      replay(target, 'offline-2', 2, 3, [x, y, a2], [x, y, a1]);
      const a3 = item('item-a', 2, { quantity: 3 });
      const b = item('item-b', 3);
      replay(target, 'offline-3', 3, 4, [x, y, a3, b], [x, y, a2]);
      expect(itemIds(target)).toEqual(['item-a', 'item-b']);
      expect(
        target.sql
          .exec<{ quantity: number }>(
            `SELECT "quantity" FROM "ShoppingListItem" WHERE "id" = 'item-a'`,
          )
          .one().quantity,
      ).toBe(3);
      expect(listVersion(target)).toBe(6);
      // 墓碑仍在：仍是过期基线的客户端继续推送也不得把 X/Y 带回来。
      replay(target, 'offline-4', 4, 5, [x, y, a3, b], [x, y, a3, b]);
      expect(itemIds(target)).toEqual(['item-a', 'item-b']);
    } finally {
      target.close();
    }
  });

  it('合法重新写入同 ID 后清理墓碑，后续编辑不再被误伤', () => {
    const target = ledger();
    try {
      const x = item('item-x', 0);
      replay(target, 'seed', null as never, 1, [x]);
      replay(target, 'online-del', 1, 2, [], [x]);
      expect(itemIds(target)).toEqual([]);

      // 已见过删除的客户端（baseVersion 不早于墓碑）重新添加同 ID。
      replay(target, 're-add', 2, 3, [x], []);
      expect(itemIds(target)).toEqual(['item-x']);

      // 后续编辑基于包含该条目的基线，墓碑必须已被清理。
      const edited = item('item-x', 0, { quantity: 9 });
      replay(target, 'edit-after-readd', 3, 4, [edited], [x]);
      expect(
        target.sql
          .exec<{ quantity: number }>(
            `SELECT "quantity" FROM "ShoppingListItem" WHERE "id" = 'item-x'`,
          )
          .one().quantity,
      ).toBe(9);
      expect(
        target.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM "sync_replay_history"
              WHERE "table_name" = 'ShoppingListItem' AND "row_id" = 'item-x' AND "version" = -1`,
          )
          .one().count,
      ).toBe(0);
    } finally {
      target.close();
    }
  });

  it('客户端基线里已有且未改动的条目，服务端物理删除后不得被 !server 分支推回', () => {
    const target = ledger();
    try {
      const x = item('item-x', 0);
      const y = item('item-y', 1);
      replay(target, 'seed', null as never, 1, [x, y]);
      // 模拟云端直接物理删除（不经清单 upsert）后，客户端带着旧完整条目推送。
      target.sql.exec(`DELETE FROM "ShoppingListItem" WHERE "id" = 'item-x'`);
      replay(target, 'stale-complete', 1, 2, [x, y], [x, y]);
      expect(itemIds(target)).toEqual(['item-y']);
    } finally {
      target.close();
    }
  });
});
