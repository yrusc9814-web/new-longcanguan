import type { LocalApiRouter } from '../../local-api/router.js';
import { dataResult } from '../../local-api/protocol.js';
import type { DatabaseClient } from '../../db/database.js';
import {
  readObject,
  requireVersion,
  queryVersion,
  pageOptions,
  validationError,
} from '../common.js';
import {
  consumeIngredient,
  createIngredient,
  deleteIngredient,
  getIngredient,
  listIngredients,
  parseIngredientBody,
  updateIngredient,
  type ConsumeInput,
  type IngredientServiceContext,
} from './service.js';
import { isQuantityUnit } from './dto.js';

const ALLOWED_STATUS = new Set(['DEPLETED', 'EXPIRED', 'EXPIRING_SOON', 'LOW_STOCK', 'NORMAL']);
const CONSUME_KEYS = new Set(['mode', 'quantity', 'unit', 'ingredientVersion', 'notes']);

/** 聚合消耗 body 的固定契约：未知字段 fail-closed，不做静默丢弃。 */
function assertExactKeys(body: Record<string, unknown>): void {
  const unknown = Object.keys(body).filter((key) => !CONSUME_KEYS.has(key));
  if (unknown.length) throw validationError(`请求包含未支持的字段：${unknown.join(', ')}`);
}

function statusFilter(value: string | null): string | undefined {
  if (value === null || value === '') return undefined;
  if (!ALLOWED_STATUS.has(value)) throw validationError('status 必须是支持的库存状态');
  return value;
}

function parseConsumeBody(body: Record<string, unknown>): ConsumeInput {
  assertExactKeys(body);
  const mode = body.mode;
  if (mode !== 'QUANTITY' && mode !== 'ALL')
    throw validationError('消耗模式必须是 QUANTITY 或 ALL');
  const ingredientVersion = requireVersion(body.ingredientVersion);
  let quantity: number | undefined;
  let unit: ConsumeInput['unit'];
  if (mode === 'QUANTITY') {
    const rawQuantity = body.quantity;
    if (typeof rawQuantity !== 'number' || !Number.isFinite(rawQuantity) || rawQuantity <= 0)
      throw validationError('消耗数量必须是大于 0 的有限数');
    if (!isQuantityUnit(body.unit)) throw validationError('按数量消耗必须提供受支持的计量单位');
    quantity = rawQuantity;
    unit = body.unit;
  } else if (body.quantity !== undefined || body.unit !== undefined) {
    throw validationError('“全部用完”不接受数量或单位参数');
  }
  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string')
    throw validationError('notes 必须是字符串或 null');
  return {
    mode,
    ...(quantity !== undefined ? { quantity } : {}),
    ...(unit !== undefined ? { unit } : {}),
    ingredientVersion,
    notes: body.notes === undefined ? undefined : (body.notes as string | null),
  };
}

export function registerIngredients(
  router: LocalApiRouter,
  getDatabase: () => Promise<DatabaseClient>,
): void {
  const now = router.options.now ?? (() => new Date());
  const contextFor = async (): Promise<IngredientServiceContext> => ({
    database: await getDatabase(),
    now,
  });

  router.register('GET', '/api/v1/ingredients', async (context) => {
    const options = pageOptions(context.query);
    const status = statusFilter(context.query.get('status'));
    const service = await contextFor();
    return listIngredients(service, {
      search: context.query.get('search') ?? undefined,
      category: context.query.get('category') ?? undefined,
      status,
      page: options.page,
      pageSize: options.pageSize,
    });
  });

  router.register('POST', '/api/v1/ingredients', async (context) => {
    const body = await readObject(context.request);
    const input = parseIngredientBody(body);
    const service = await contextFor();
    return dataResult(await createIngredient(service, input), { status: 201 });
  });

  router.register('GET', '/api/v1/ingredients/:id', async (context) => {
    const service = await contextFor();
    return getIngredient(service, context.params.id as string);
  });

  router.register('PUT', '/api/v1/ingredients/:id', async (context) => {
    const body = await readObject(context.request);
    const version = requireVersion(body.version);
    const input = parseIngredientBody(body);
    const service = await contextFor();
    return updateIngredient(service, context.params.id as string, version, input);
  });

  router.register('DELETE', '/api/v1/ingredients/:id', async (context) => {
    const version = queryVersion(context.query);
    const service = await contextFor();
    return deleteIngredient(service, context.params.id as string, version);
  });

  router.register('POST', '/api/v1/ingredients/:id/consume', async (context) => {
    const body = await readObject(context.request);
    const input = parseConsumeBody(body);
    const service = await contextFor();
    return consumeIngredient(service, context.params.id as string, input);
  });
}
