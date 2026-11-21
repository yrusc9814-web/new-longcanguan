/**
 * 购物清单 9 条保留端点（`RETAINED_ENDPOINTS` 中 domain = 'shopping'）。
 *
 * - GET    /shopping-lists
 * - POST   /shopping-lists
 * - GET    /shopping-lists/:id
 * - POST   /shopping-lists/:id/items
 * - PUT    /shopping-list-items/:id
 * - POST   /shopping-lists/:id/replenish-recipe
 * - DELETE /shopping-list-items/:id
 * - POST   /shopping-lists/:id/check-in
 * - POST   /shopping-lists/:id/clear-completed
 */
import type { QuantityUnit, ShoppingSourceType } from '@dafan/shared/types';

import type { DatabaseClient } from '../../db/database.js';
import { LocalApiError, dataResult } from '../../local-api/protocol.js';
import type { LocalApiRouter } from '../../local-api/router.js';
import { queryVersion, readObject, validationError } from '../common.js';

import {
  addShoppingItem,
  checkInShoppingItems,
  clearCompletedItems,
  createShoppingList,
  deleteShoppingItem,
  getShoppingList,
  listShoppingLists,
  parseQuantityUnit,
  replenishRecipe,
  requireListVersion,
  updateShoppingItem,
  type ItemWriteInput,
  type ReplenishItemInput,
  type ShoppingServiceContext,
} from './service.js';

function optionalText(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw validationError(`${field} 必须是字符串或 null`);
  return value;
}

function requireItemId(params: Readonly<Record<string, string>>, message: string): string {
  const id = params.id ?? '';
  if (!id) throw validationError(message);
  return id;
}

/** PUT 条目：只解析显式字段，其余保持 undefined 由服务层跳过。 */
function parseItemPatch(body: Record<string, unknown>): ItemWriteInput {
  const patch: {
    ingredientName?: string;
    ingredientId?: string | null;
    quantity?: number | null;
    unit?: QuantityUnit | null;
    amountText?: string | null;
    category?: string | null;
    completed?: boolean;
    sortOrder?: number;
    notes?: string | null;
  } = {};
  const name = optionalText(body.ingredientName, 'ingredientName');
  if (name !== undefined) {
    if (name === null) throw validationError('ingredientName 必须是字符串');
    patch.ingredientName = name;
  }
  if (body.ingredientId !== undefined) {
    if (body.ingredientId !== null && typeof body.ingredientId !== 'string') {
      throw validationError('ingredientId 必须是字符串或 null');
    }
    patch.ingredientId = body.ingredientId as string | null;
  }
  if (body.quantity !== undefined) {
    if (
      body.quantity !== null &&
      (typeof body.quantity !== 'number' || !Number.isFinite(body.quantity))
    ) {
      throw validationError('quantity 必须是数字或 null');
    }
    patch.quantity = body.quantity as number | null;
  }
  if (body.unit !== undefined) patch.unit = parseQuantityUnit(body.unit);
  if (body.amountText !== undefined) patch.amountText = optionalText(body.amountText, 'amountText');
  if (body.category !== undefined) patch.category = optionalText(body.category, 'category');
  if (body.completed !== undefined) {
    if (typeof body.completed !== 'boolean') throw validationError('completed 必须是布尔值');
    patch.completed = body.completed;
  }
  if (body.sortOrder !== undefined) {
    if (typeof body.sortOrder !== 'number' || !Number.isInteger(body.sortOrder)) {
      throw validationError('sortOrder 必须是整数');
    }
    patch.sortOrder = body.sortOrder;
  }
  if (body.notes !== undefined) patch.notes = optionalText(body.notes, 'notes');
  return patch;
}

function parseReplenishItems(value: unknown): ReplenishItemInput[] {
  if (!Array.isArray(value)) throw validationError('items 必须是数组');
  return value.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw validationError(`items[${index}] 必须是对象`);
    }
    const item = raw as Record<string, unknown>;
    const name = typeof item.ingredientName === 'string' ? item.ingredientName : '';
    if (!name.trim()) throw validationError(`items[${index}].ingredientName 不能为空`);
    if (item.ingredientId !== undefined && item.ingredientId !== null) {
      if (typeof item.ingredientId !== 'string') {
        throw validationError(`items[${index}].ingredientId 必须是字符串或 null`);
      }
    }
    if (item.quantity !== undefined && item.quantity !== null) {
      if (typeof item.quantity !== 'number' || !Number.isFinite(item.quantity)) {
        throw validationError(`items[${index}].quantity 必须是数字或 null`);
      }
    }
    if (
      item.amountText !== undefined &&
      item.amountText !== null &&
      typeof item.amountText !== 'string'
    ) {
      throw validationError(`items[${index}].amountText 必须是字符串或 null`);
    }
    if (
      item.category !== undefined &&
      item.category !== null &&
      typeof item.category !== 'string'
    ) {
      throw validationError(`items[${index}].category 必须是字符串或 null`);
    }
    return {
      ingredientId: (item.ingredientId ?? null) as string | null,
      ingredientName: name,
      quantity: (item.quantity ?? null) as number | null,
      unit: item.unit === undefined ? null : parseQuantityUnit(item.unit),
      amountText: (item.amountText ?? null) as string | null,
      category: (item.category ?? null) as string | null,
      notes: optionalText(item.notes, `items[${index}].notes`),
    };
  });
}

export function registerShopping(
  router: LocalApiRouter,
  getDatabase: () => Promise<DatabaseClient>,
): void {
  const now = router.options.now ?? (() => new Date());
  const contextFor = async (): Promise<ShoppingServiceContext> => ({
    database: await getDatabase(),
    now,
  });

  router.register('GET', '/api/v1/shopping-lists', async ({ query }) => {
    const service = await contextFor();
    return listShoppingLists(service, { status: query.get('status') ?? undefined });
  });

  router.register('POST', '/api/v1/shopping-lists', async ({ request }) => {
    const body = await readObject(request, true);
    if (body.name !== undefined && typeof body.name !== 'string') {
      throw validationError('name 必须是字符串');
    }
    if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') {
      throw validationError('notes 必须是字符串或 null');
    }
    const service = await contextFor();
    const dto = await createShoppingList(service, {
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(body.notes !== undefined ? { notes: body.notes as string | null } : {}),
    });
    return dataResult(dto, { status: 201 });
  });

  router.register('GET', '/api/v1/shopping-lists/:id', async ({ params }) => {
    const service = await contextFor();
    return getShoppingList(service, requireItemId(params, '购物清单 ID 不能为空'));
  });

  router.register('POST', '/api/v1/shopping-lists/:id/items', async ({ request, params }) => {
    const body = await readObject(request);
    const version = requireListVersion(body.version);
    if (typeof body.ingredientName !== 'string') {
      throw validationError('ingredientName 必须是字符串');
    }
    const service = await contextFor();
    return addShoppingItem(service, requireItemId(params, '购物清单 ID 不能为空'), {
      version,
      ingredientName: body.ingredientName,
      ingredientId: (body.ingredientId ?? null) as string | null,
      quantity: (body.quantity ?? null) as number | null,
      unit: body.unit === undefined ? null : parseQuantityUnit(body.unit),
      amountText: (body.amountText ?? null) as string | null,
      category: (body.category ?? null) as string | null,
      sourceType: (body.sourceType ?? 'MANUAL') as ShoppingSourceType,
      sourceId: (body.sourceId ?? null) as string | null,
      completed: body.completed === true,
      notes: (body.notes ?? null) as string | null,
    });
  });

  router.register('PUT', '/api/v1/shopping-list-items/:id', async ({ request, params }) => {
    const body = await readObject(request);
    const version = requireListVersion(body.version);
    const service = await contextFor();
    return updateShoppingItem(service, requireItemId(params, '购物清单项目 ID 不能为空'), {
      ...parseItemPatch(body),
      version,
    });
  });

  router.register('DELETE', '/api/v1/shopping-list-items/:id', async ({ params, query }) => {
    const version = queryVersion(query);
    const service = await contextFor();
    return deleteShoppingItem(service, requireItemId(params, '购物清单项目 ID 不能为空'), version);
  });

  router.register(
    'POST',
    '/api/v1/shopping-lists/:id/replenish-recipe',
    async ({ request, params }) => {
      const body = await readObject(request);
      const version = requireListVersion(body.version);
      if (typeof body.recipeId !== 'string') {
        throw new LocalApiError(422, 'SHOPPING_RECIPE_REQUIRED', '菜谱 ID 不能为空');
      }
      const service = await contextFor();
      return replenishRecipe(service, requireItemId(params, '购物清单 ID 不能为空'), {
        version,
        recipeId: body.recipeId,
        items: parseReplenishItems(body.items),
      });
    },
  );

  router.register('POST', '/api/v1/shopping-lists/:id/check-in', async ({ request, params }) => {
    const body = await readObject(request);
    const version = requireListVersion(body.version);
    if (typeof body.operationId !== 'string') throw validationError('operationId 必须是字符串');
    if (!Array.isArray(body.itemIds) || body.itemIds.some((id) => typeof id !== 'string')) {
      throw validationError('itemIds 必须是字符串数组');
    }
    const service = await contextFor();
    return checkInShoppingItems(service, requireItemId(params, '购物清单 ID 不能为空'), {
      version,
      operationId: body.operationId,
      itemIds: body.itemIds as string[],
    });
  });

  router.register(
    'POST',
    '/api/v1/shopping-lists/:id/clear-completed',
    async ({ request, params }) => {
      const body = await readObject(request);
      const version = requireListVersion(body.version);
      const service = await contextFor();
      return clearCompletedItems(service, requireItemId(params, '购物清单 ID 不能为空'), version);
    },
  );
}
