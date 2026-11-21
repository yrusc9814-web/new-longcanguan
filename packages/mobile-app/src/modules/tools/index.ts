import type { DatabaseClient } from '../../db/database.js';
import { dataResult } from '../../local-api/protocol.js';
import type { LocalApiRouter } from '../../local-api/router.js';
import { queryVersion, readObject, requireVersion } from '../common.js';
import { createTool, deleteTool, listTools, updateTool } from './service.js';

export function registerTools(
  router: LocalApiRouter,
  getDatabase: () => Promise<DatabaseClient>,
): void {
  const now = () => router.options.now?.() ?? new Date();

  router.register('GET', '/api/v1/tools', async ({ query }) => {
    const database = await getDatabase();
    const search = query.get('search');
    return listTools(database, search === null ? undefined : search);
  });

  router.register('POST', '/api/v1/tools', async ({ request }) => {
    const body = await readObject(request);
    const database = await getDatabase();
    return dataResult(await createTool(database, body, now()), { status: 201 });
  });

  router.register('PUT', '/api/v1/tools/:id', async ({ request, params }) => {
    const body = await readObject(request);
    const version = requireVersion(body.version);
    const database = await getDatabase();
    return updateTool(database, params.id as string, body, version);
  });

  router.register('DELETE', '/api/v1/tools/:id', async ({ query, params }) => {
    const database = await getDatabase();
    return deleteTool(database, params.id as string, queryVersion(query), now());
  });
}

export * from './service.js';
