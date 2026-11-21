import type { DatabaseClient } from '../../db/database.js';
import { dataResult } from '../../local-api/protocol.js';
import type { LocalApiRouter } from '../../local-api/router.js';
import { queryVersion, readObject, requireVersion, validationError } from '../common.js';
import { newLocalId } from '../meal-records/ids.js';

import {
  completePlan,
  createPlan,
  deletePlan,
  isPlanStatus,
  listPlans,
  parsePlanBody,
  uncompletePlan,
  updatePlan,
  type MealPlanServiceContext,
} from './service.js';
import type { MealPlanStatus, PlanInput } from './types.js';

function createContext(router: LocalApiRouter, database: DatabaseClient): MealPlanServiceContext {
  return {
    database,
    now: router.options.now ?? (() => new Date()),
    newId: newLocalId,
  };
}

function requireId(params: Readonly<Record<string, string>>): string {
  const id = params.id ?? '';
  if (!id) throw validationError('缺少计划 ID');
  return id;
}

/**
 * 排餐业务路由。
 *
 * `GET /api/v1/plans/:id` 与 `POST /api/v1/plans/:id/cancel` 属剔除端点，此处不注册。
 */
export function registerMealPlans(
  router: LocalApiRouter,
  getDatabase: () => Promise<DatabaseClient>,
): void {
  const contextFor = async (): Promise<MealPlanServiceContext> =>
    createContext(router, await getDatabase());

  router.register('GET', '/api/v1/plans', async ({ query }) => {
    const status = query.get('status');
    if (status !== null && status !== '' && !isPlanStatus(status))
      throw validationError('status 不受支持');
    for (const key of ['from', 'to'] as const) {
      const value = query.get(key);
      if (value !== null && value !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(value))
        throw validationError(`${key} 必须是 YYYY-MM-DD 格式`);
    }
    const database = await getDatabase();
    return listPlans(database, {
      from: query.get('from') ?? undefined,
      to: query.get('to') ?? undefined,
      status: (status as MealPlanStatus | null | undefined) || undefined,
    });
  });

  router.register('POST', '/api/v1/plans', async ({ request }) => {
    const { input } = parsePlanBody(await readObject(request), { forUpdate: false });
    const service = await contextFor();
    return dataResult(
      await createPlan(service, {
        planDate: input.planDate as string,
        mealType: input.mealType as PlanInput['mealType'],
        dinerCount: input.dinerCount as number,
        status: input.status ?? 'PLANNED',
        notes: input.notes ?? null,
        time: input.time ?? null,
        title: input.title ?? null,
        subtext: input.subtext ?? null,
        icon: input.icon ?? null,
        items: input.items ?? [],
        dinerIds: input.dinerIds ?? [],
      }),
      { status: 201 },
    );
  });

  router.register('PUT', '/api/v1/plans/:id', async ({ request, params }) => {
    const body = await readObject(request);
    const version = requireVersion(body.version);
    const { input } = parsePlanBody(body, { forUpdate: true });
    const service = await contextFor();
    return updatePlan(service, requireId(params), version, input);
  });

  router.register('DELETE', '/api/v1/plans/:id', async ({ params, query }) => {
    const service = await contextFor();
    return deletePlan(service, requireId(params), queryVersion(query));
  });

  router.register('POST', '/api/v1/plans/:id/complete', async ({ request, params }) => {
    const body = await readObject(request);
    const service = await contextFor();
    return completePlan(service, requireId(params), requireVersion(body.version));
  });

  router.register('POST', '/api/v1/plans/:id/uncomplete', async ({ request, params }) => {
    const body = await readObject(request);
    // 撤销完成只允许 version：未知字段 fail-closed（与上游 preValidation 一致）。
    const unknown = Object.keys(body).filter((key) => key !== 'version');
    if (unknown.length) throw validationError(`请求包含未支持的字段：${unknown.join(', ')}`);
    const service = await contextFor();
    return uncompletePlan(service, requireId(params), requireVersion(body.version));
  });
}

export * from './service.js';
export * from './types.js';
