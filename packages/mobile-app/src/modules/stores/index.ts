import type { DatabaseClient } from '../../db/database.js';
import { dataResult } from '../../local-api/protocol.js';
import type { LocalApiRouter } from '../../local-api/router.js';
import { queryVersion, readObject, requireVersion, validationError } from '../common.js';

import {
  createStore,
  deleteStore,
  getStore,
  listStores,
  parseStoreListQuery,
  setStoreFavorite,
  updateStore,
} from './service.js';

function requireId(params: Readonly<Record<string, string>>): string {
  const id = params.id ?? '';
  if (!id) throw validationError('店铺 ID 不能为空');
  return id;
}

/**
 * 店铺业务路由（保留端点 6 条）。
 *
 * `DELETE` 优先读取适配器发送的 JSON Body `{ version }`；
 * 没有 body 时兼容 `?version=`（其他域与脚本调用的既有写法）。
 */
export function registerStores(
  router: LocalApiRouter,
  getDatabase: () => Promise<DatabaseClient>,
): void {
  const now = () => router.options.now?.() ?? new Date();

  router.register('GET', '/api/v1/stores', async ({ query }) => {
    const options = parseStoreListQuery(query);
    const database = await getDatabase();
    return listStores(database, options, now());
  });

  router.register('POST', '/api/v1/stores', async ({ request }) => {
    const body = await readObject(request);
    const database = await getDatabase();
    return dataResult(await createStore(database, body, now()), { status: 201 });
  });

  router.register('GET', '/api/v1/stores/:id', async ({ params }) => {
    const database = await getDatabase();
    return getStore(database, requireId(params));
  });

  router.register('PUT', '/api/v1/stores/:id', async ({ request, params }) => {
    const body = await readObject(request);
    const version = requireVersion(body.version);
    const database = await getDatabase();
    return updateStore(database, requireId(params), body, version, now());
  });

  router.register('DELETE', '/api/v1/stores/:id', async ({ request, params, query }) => {
    const body = await readObject(request, true);
    const version = body.version === undefined ? queryVersion(query) : requireVersion(body.version);
    const database = await getDatabase();
    return deleteStore(database, requireId(params), version, now());
  });

  router.register('POST', '/api/v1/stores/:id/favorite', async ({ request, params }) => {
    const body = await readObject(request);
    const version = requireVersion(body.version);
    const database = await getDatabase();
    return setStoreFavorite(database, requireId(params), body.favorite, version, now());
  });
}

export * from './service.js';
