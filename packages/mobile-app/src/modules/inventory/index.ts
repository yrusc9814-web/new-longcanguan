/**
 * 厨房库存领域路由（与上游 `app/server/src/modules/inventory/routes.ts` 同源）。
 *
 * 只注册保留端点 `POST /api/v1/kitchen/recommend`；`GET /api/v1/inventory/logs`
 * 已随上游退役清单剔除，由本地路由固定 404，本模块不提供实现。
 *
 * 推荐是纯读操作：只发 SELECT，不开启写事务，也不写发件箱。
 */
import type { DatabaseClient } from '../../db/database.js';
import type { LocalApiRouter } from '../../local-api/router.js';
import { readRecommendationInput, recommendFromInventory } from './recommend.js';

export function registerInventory(
  router: LocalApiRouter,
  getDatabase: () => Promise<DatabaseClient>,
): void {
  const now = router.options.now ?? (() => new Date());

  router.register('POST', '/api/v1/kitchen/recommend', async ({ request }) => {
    const input = await readRecommendationInput(request);
    const database = await getDatabase();
    return recommendFromInventory(database, input, now);
  });
}

export * from './recommend.js';
