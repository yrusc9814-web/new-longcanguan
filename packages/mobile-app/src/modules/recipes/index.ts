import type { DatabaseClient } from '../../db/database.js';
import { LocalApiDataResult, LocalApiError } from '../../local-api/protocol.js';
import type { LocalApiRouter } from '../../local-api/router.js';
import { queryVersion, readObject, requireVersion } from '../common.js';

import {
  createRecipe,
  deleteRecipe,
  getRecipe,
  listRecipes,
  newLocalId,
  toggleRecipeFavorite,
  updateRecipe,
  type RecipeServiceContext,
} from './service.js';
import { parseRecipeListQuery, parseRecipeWriteInput } from './validation.js';

function createContext(router: LocalApiRouter, database: DatabaseClient): RecipeServiceContext {
  return {
    database,
    now: router.options.now ?? (() => new Date()),
    newId: newLocalId,
  };
}

function requireId(params: Readonly<Record<string, string>>): string {
  const id = params.id ?? '';
  if (!id) throw new LocalApiError(404, 'NOT_FOUND', '菜谱不存在');
  return id;
}

/**
 * 菜谱业务路由。
 *
 * `POST /api/v1/recipes/:id/cook-checkin` 不在本域实现（cook-checkin 排除）。
 */
export function registerRecipes(
  router: LocalApiRouter,
  getDatabase: () => Promise<DatabaseClient>,
): void {
  router.register('GET', '/api/v1/recipes', async ({ query }) => {
    const options = parseRecipeListQuery(query);
    const database = await getDatabase();
    return listRecipes(database, options);
  });

  router.register('POST', '/api/v1/recipes', async ({ request }) => {
    const input = parseRecipeWriteInput(await readObject(request));
    const database = await getDatabase();
    const dto = await createRecipe(createContext(router, database), input);
    return new LocalApiDataResult(dto, 201);
  });

  router.register('GET', '/api/v1/recipes/:id', async ({ params }) => {
    const database = await getDatabase();
    return getRecipe(database, requireId(params));
  });

  router.register('PUT', '/api/v1/recipes/:id', async ({ request, params }) => {
    const body = await readObject(request);
    const version = requireVersion(body.version);
    const input = parseRecipeWriteInput(body);
    const database = await getDatabase();
    return updateRecipe(createContext(router, database), requireId(params), version, input);
  });

  router.register('DELETE', '/api/v1/recipes/:id', async ({ params, query }) => {
    const version = queryVersion(query);
    const database = await getDatabase();
    return deleteRecipe(createContext(router, database), requireId(params), version);
  });

  router.register('POST', '/api/v1/recipes/:id/favorite', async ({ request, params }) => {
    const body = await readObject(request);
    const version = requireVersion(body.version);
    if (typeof body.favorite !== 'boolean') {
      throw new LocalApiError(400, 'VALIDATION_ERROR', 'favorite 必须是布尔值');
    }
    const database = await getDatabase();
    return toggleRecipeFavorite(
      createContext(router, database),
      requireId(params),
      version,
      body.favorite,
    );
  });
}

export * from './service.js';
export * from './types.js';
