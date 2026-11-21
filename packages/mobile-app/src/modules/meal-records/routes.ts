import type { DatabaseClient } from '../../db/database.js';
import { dataResult } from '../../local-api/protocol.js';
import type { LocalApiRouter } from '../../local-api/router.js';
import { pageOptions, queryVersion, readObject, validationError } from '../common.js';

import { newLocalId } from './ids.js';
import {
  confirmRecord,
  createRecord,
  deleteRecord,
  getRecord,
  isMealType,
  isRecordStatus,
  isSourceType,
  listRecords,
  parseRecordBody,
  parseRecordPatch,
  updateRecord,
  requireRecordVersion,
  type MealRecordServiceContext,
} from './service.js';

function createContext(router: LocalApiRouter, database: DatabaseClient): MealRecordServiceContext {
  return {
    database,
    now: router.options.now ?? (() => new Date()),
    newId: newLocalId,
  };
}

function requireId(params: Readonly<Record<string, string>>): string {
  const id = params.id ?? '';
  if (!id) throw validationError('缺少记录 ID');
  return id;
}

function optionalEnum<T extends string>(
  value: string | null,
  guard: (input: unknown) => input is T,
  field: string,
): T | undefined {
  if (value === null || value === '') return undefined;
  if (!guard(value)) throw validationError(`${field} 不受支持`);
  return value;
}

const MIN_RATING_PATTERN = /^(?:[0-4](?:\.[0-9]+)?|5(?:\.0+)?)$/;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export function registerMealRecords(
  router: LocalApiRouter,
  getDatabase: () => Promise<DatabaseClient>,
): void {
  const contextFor = async (): Promise<MealRecordServiceContext> =>
    createContext(router, await getDatabase());

  router.register('GET', '/api/v1/records', async ({ query }) => {
    const database = await getDatabase();
    const minRating = query.get('minRating');
    if (minRating !== null && minRating !== '' && !MIN_RATING_PATTERN.test(minRating))
      throw validationError('minRating 必须是 0 到 5 之间的数字');
    for (const key of ['from', 'to'] as const) {
      const value = query.get(key);
      if (value !== null && value !== '' && !DATE_SHAPE.test(value))
        throw validationError(`${key} 必须是 YYYY-MM-DD 格式`);
    }
    return listRecords(database, {
      ...pageOptions(query),
      from: query.get('from') ?? undefined,
      to: query.get('to') ?? undefined,
      sourceType: optionalEnum(query.get('sourceType'), isSourceType, 'sourceType'),
      mealType: optionalEnum(query.get('mealType'), isMealType, 'mealType'),
      status: optionalEnum(query.get('status'), isRecordStatus, 'status'),
      minRating: minRating || undefined,
      dinerId: query.get('dinerId') ?? undefined,
      q: query.get('q') ?? undefined,
    });
  });

  router.register('POST', '/api/v1/records', async ({ request }) => {
    const { input } = parseRecordBody(await readObject(request), { forUpdate: false });
    const service = await contextFor();
    return dataResult(await createRecord(service, input), { status: 201 });
  });

  router.register('GET', '/api/v1/records/:id', async ({ params }) => {
    const database = await getDatabase();
    return getRecord(database, requireId(params));
  });

  router.register('PUT', '/api/v1/records/:id', async ({ request, params }) => {
    const body = await readObject(request);
    const version = requireRecordVersion(body.version);
    const service = await contextFor();
    return updateRecord(service, requireId(params), version, parseRecordPatch(body));
  });

  router.register('DELETE', '/api/v1/records/:id', async ({ params, query }) => {
    const service = await contextFor();
    return deleteRecord(service, requireId(params), queryVersion(query));
  });

  router.register('POST', '/api/v1/records/:id/confirm', async ({ request, params }) => {
    const body = await readObject(request);
    const service = await contextFor();
    return confirmRecord(service, requireId(params), requireRecordVersion(body.version));
  });
}

export * from './service.js';
export * from './types.js';
