import type { DatabaseClient } from '../../db/database.js';
import { dataResult } from '../../local-api/protocol.js';
import type { LocalApiRouter } from '../../local-api/router.js';
import { pageOptions, readObject, requireVersion, validationError } from '../common.js';
import { createDiner, listDiners, updateDiner } from './service.js';

/** 上游 `booleanQuerySchema`：query 只接受字面量 true/false；空串按未提供处理。 */
function readActiveQuery(value: string | null): boolean | undefined {
  if (value === null || value === '') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw validationError('启用状态必须是 true 或 false');
}

/** 上游在路由层显式校验 sortOrder，非法值直接 400；空串按未提供处理。 */
function readSortOrder(value: string | null): 'asc' | 'desc' | undefined {
  if (value === null || value === '') return undefined;
  if (value === 'asc' || value === 'desc') return value;
  throw validationError('排序方向无效');
}

/** 上游 `numberValue` 把空串当作未提供；`pageOptions` 会对此报错，先剔除。 */
function withoutBlankPaging(query: URLSearchParams): URLSearchParams {
  const filtered = new URLSearchParams(query);
  for (const key of ['page', 'pageSize']) {
    if (filtered.get(key) === '') filtered.delete(key);
  }
  return filtered;
}

export function registerDiners(
  router: LocalApiRouter,
  getDatabase: () => Promise<DatabaseClient>,
): void {
  const now = () => router.options.now?.() ?? new Date();

  router.register('GET', '/api/v1/diners', async ({ query }) => {
    const database = await getDatabase();
    return listDiners(database, {
      ...pageOptions(withoutBlankPaging(query)),
      search: query.get('search') ?? undefined,
      active: readActiveQuery(query.get('active')),
      sortOrder: readSortOrder(query.get('sortOrder')),
    });
  });

  router.register('POST', '/api/v1/diners', async ({ request }) => {
    const body = await readObject(request);
    const database = await getDatabase();
    return dataResult(await createDiner(database, body, now()), { status: 201 });
  });

  router.register('PUT', '/api/v1/diners/:id', async ({ request, params }) => {
    const body = await readObject(request);
    const version = requireVersion(body.version);
    const database = await getDatabase();
    return updateDiner(database, params.id, body, version);
  });
}

export * from './service.js';
