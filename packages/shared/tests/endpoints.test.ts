import { expect, it } from 'vitest';
import { RETIRED_ENDPOINTS } from '../src/contracts/endpoints.js';

it('对照任务指定分组中实际注册的 24 条剔除路由', () => {
  const keys = RETIRED_ENDPOINTS.map(({ method, path }) => `${method} ${path}`);
  expect(keys.sort()).toEqual([
    'DELETE /api/v1/diners/:id',
    'DELETE /api/v1/shopping-lists/:id',
    'DELETE /api/v1/uploads/images/:id',
    'GET /api/v1/calendar',
    'GET /api/v1/deleted-items',
    'GET /api/v1/favorites',
    'GET /api/v1/ingredients/:id/logs',
    'GET /api/v1/inventory/logs',
    'GET /api/v1/recommendations/history',
    'GET /api/v1/search',
    'GET /api/v1/settings/access-qr',
    'GET /api/v1/stores/candidates',
    'POST /api/v1/consumption/confirm-from-recipe',
    'POST /api/v1/consumption/preview-from-recipe',
    'POST /api/v1/deleted-items/:id/restore',
    'POST /api/v1/plans/:id/cancel',
    'POST /api/v1/recommendations/:id/accept',
    'POST /api/v1/recommendations/:id/added-to-plan',
    'POST /api/v1/records/:id/confirm-consumption',
    'POST /api/v1/records/:id/consumption-preview',
    'POST /api/v1/records/:id/favorite',
    'POST /api/v1/settings/onboarding',
    'POST /api/v1/shopping-lists/generate',
    'PUT /api/v1/shopping-lists/:id',
  ]);
});
