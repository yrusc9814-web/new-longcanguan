/**
 * 上游端点基准（固定提交 e778d3bd3354123032e570e03ad85c6b19bd9ea4）。
 *
 * 生成方式：静态扫描 app/server/src/modules 下 register*Routes 的 app.<method>() 声明，
 * 只统计以 /api/v1/ 开头的接口；不计 GET /*（生产静态兜底）与 GET /uploads/*（文件读取）。
 * 结果：91 条 method+path，59 条 Google2 调用、24 条明确剔除、8 条待定。
 */
export const UPSTREAM_COMMIT = 'e778d3bd3354123032e570e03ad85c6b19bd9ea4';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type EndpointDomain =
  | 'backup'
  | 'calendar'
  | 'consumption'
  | 'dashboard'
  | 'diner'
  | 'ingredient'
  | 'kitchen'
  | 'plan'
  | 'recipe'
  | 'recommendation'
  | 'record'
  | 'search'
  | 'settings'
  | 'shopping'
  | 'statistics'
  | 'store'
  | 'system'
  | 'tool'
  | 'trash'
  | 'upload';

export type RetiredReason =
  | 'access-qr'
  | 'calendar'
  | 'consumption'
  | 'diner-delete'
  | 'favorites'
  | 'ingredient-logs'
  | 'inventory-logs'
  | 'onboarding'
  | 'plan-cancel'
  | 'recommendation-history'
  | 'record-favorite'
  | 'search'
  | 'shopping-generate'
  | 'shopping-list-delete'
  | 'shopping-list-update'
  | 'store-candidates'
  | 'trash'
  | 'upload-delete';

export interface EndpointSpec {
  readonly method: HttpMethod;
  readonly path: string;
  readonly domain: EndpointDomain;
}

export interface RetiredEndpointSpec extends EndpointSpec {
  readonly reason: RetiredReason;
}

/** 保留端点：Google2 生产入口或适配器实际调用。 */
export const RETAINED_ENDPOINTS = [
  { method: 'GET', path: '/api/v1/backups/export', domain: 'backup' },
  { method: 'POST', path: '/api/v1/backups/restore', domain: 'backup' },
  { method: 'GET', path: '/api/v1/dashboard', domain: 'dashboard' },
  { method: 'GET', path: '/api/v1/diners', domain: 'diner' },
  { method: 'POST', path: '/api/v1/diners', domain: 'diner' },
  { method: 'PUT', path: '/api/v1/diners/:id', domain: 'diner' },
  { method: 'GET', path: '/api/v1/ingredients', domain: 'ingredient' },
  { method: 'POST', path: '/api/v1/ingredients', domain: 'ingredient' },
  { method: 'GET', path: '/api/v1/ingredients/:id', domain: 'ingredient' },
  { method: 'PUT', path: '/api/v1/ingredients/:id', domain: 'ingredient' },
  { method: 'DELETE', path: '/api/v1/ingredients/:id', domain: 'ingredient' },

  { method: 'POST', path: '/api/v1/ingredients/:id/consume', domain: 'ingredient' },
  { method: 'POST', path: '/api/v1/kitchen/recommend', domain: 'kitchen' },
  { method: 'GET', path: '/api/v1/plans', domain: 'plan' },
  { method: 'POST', path: '/api/v1/plans', domain: 'plan' },
  { method: 'PUT', path: '/api/v1/plans/:id', domain: 'plan' },
  { method: 'DELETE', path: '/api/v1/plans/:id', domain: 'plan' },
  { method: 'POST', path: '/api/v1/plans/:id/complete', domain: 'plan' },
  { method: 'POST', path: '/api/v1/plans/:id/uncomplete', domain: 'plan' },
  { method: 'GET', path: '/api/v1/records', domain: 'record' },
  { method: 'POST', path: '/api/v1/records', domain: 'record' },
  { method: 'GET', path: '/api/v1/records/:id', domain: 'record' },
  { method: 'PUT', path: '/api/v1/records/:id', domain: 'record' },
  { method: 'DELETE', path: '/api/v1/records/:id', domain: 'record' },
  { method: 'POST', path: '/api/v1/records/:id/confirm', domain: 'record' },
  { method: 'GET', path: '/api/v1/recipes', domain: 'recipe' },
  { method: 'POST', path: '/api/v1/recipes', domain: 'recipe' },
  { method: 'GET', path: '/api/v1/recipes/:id', domain: 'recipe' },
  { method: 'PUT', path: '/api/v1/recipes/:id', domain: 'recipe' },
  { method: 'DELETE', path: '/api/v1/recipes/:id', domain: 'recipe' },
  { method: 'POST', path: '/api/v1/recipes/:id/favorite', domain: 'recipe' },
  { method: 'POST', path: '/api/v1/recipes/:id/cook-checkin', domain: 'recipe' },
  { method: 'POST', path: '/api/v1/recommendations/random', domain: 'recommendation' },
  { method: 'GET', path: '/api/v1/settings', domain: 'settings' },
  { method: 'GET', path: '/api/v1/settings/pin/session', domain: 'settings' },
  { method: 'PUT', path: '/api/v1/settings/pin', domain: 'settings' },
  { method: 'POST', path: '/api/v1/settings/pin/verify', domain: 'settings' },
  { method: 'POST', path: '/api/v1/settings/high-risk/authorize', domain: 'settings' },
  { method: 'GET', path: '/api/v1/shopping-lists', domain: 'shopping' },
  { method: 'POST', path: '/api/v1/shopping-lists', domain: 'shopping' },
  { method: 'GET', path: '/api/v1/shopping-lists/:id', domain: 'shopping' },
  { method: 'POST', path: '/api/v1/shopping-lists/:id/items', domain: 'shopping' },
  { method: 'PUT', path: '/api/v1/shopping-list-items/:id', domain: 'shopping' },
  { method: 'POST', path: '/api/v1/shopping-lists/:id/replenish-recipe', domain: 'shopping' },
  { method: 'DELETE', path: '/api/v1/shopping-list-items/:id', domain: 'shopping' },
  { method: 'POST', path: '/api/v1/shopping-lists/:id/check-in', domain: 'shopping' },
  { method: 'POST', path: '/api/v1/shopping-lists/:id/clear-completed', domain: 'shopping' },
  { method: 'GET', path: '/api/v1/statistics', domain: 'statistics' },
  { method: 'GET', path: '/api/v1/stores', domain: 'store' },
  { method: 'POST', path: '/api/v1/stores', domain: 'store' },
  { method: 'GET', path: '/api/v1/stores/:id', domain: 'store' },
  { method: 'PUT', path: '/api/v1/stores/:id', domain: 'store' },
  { method: 'DELETE', path: '/api/v1/stores/:id', domain: 'store' },
  { method: 'POST', path: '/api/v1/stores/:id/favorite', domain: 'store' },
  { method: 'GET', path: '/api/v1/tools', domain: 'tool' },
  { method: 'POST', path: '/api/v1/tools', domain: 'tool' },
  { method: 'PUT', path: '/api/v1/tools/:id', domain: 'tool' },
  { method: 'DELETE', path: '/api/v1/tools/:id', domain: 'tool' },
  { method: 'POST', path: '/api/v1/uploads/images', domain: 'upload' },
] as const satisfies readonly EndpointSpec[];

/** 剔除端点：本仓库不再提供，客户端必须删除对应用途而不是保留死代码。 */
export const RETIRED_ENDPOINTS = [
  { method: 'GET', path: '/api/v1/calendar', domain: 'calendar', reason: 'calendar' },
  {
    method: 'POST',
    path: '/api/v1/records/:id/consumption-preview',
    domain: 'consumption',
    reason: 'consumption',
  },
  {
    method: 'POST',
    path: '/api/v1/records/:id/confirm-consumption',
    domain: 'consumption',
    reason: 'consumption',
  },
  {
    method: 'POST',
    path: '/api/v1/consumption/preview-from-recipe',
    domain: 'consumption',
    reason: 'consumption',
  },
  {
    method: 'POST',
    path: '/api/v1/consumption/confirm-from-recipe',
    domain: 'consumption',
    reason: 'consumption',
  },
  { method: 'GET', path: '/api/v1/deleted-items', domain: 'trash', reason: 'trash' },
  { method: 'POST', path: '/api/v1/deleted-items/:id/restore', domain: 'trash', reason: 'trash' },
  { method: 'DELETE', path: '/api/v1/diners/:id', domain: 'diner', reason: 'diner-delete' },
  {
    method: 'GET',
    path: '/api/v1/ingredients/:id/logs',
    domain: 'ingredient',
    reason: 'ingredient-logs',
  },
  { method: 'GET', path: '/api/v1/inventory/logs', domain: 'kitchen', reason: 'inventory-logs' },
  { method: 'POST', path: '/api/v1/plans/:id/cancel', domain: 'plan', reason: 'plan-cancel' },
  {
    method: 'POST',
    path: '/api/v1/records/:id/favorite',
    domain: 'record',
    reason: 'record-favorite',
  },
  {
    method: 'GET',
    path: '/api/v1/recommendations/history',
    domain: 'recommendation',
    reason: 'recommendation-history',
  },
  {
    method: 'POST',
    path: '/api/v1/recommendations/:id/accept',
    domain: 'recommendation',
    reason: 'recommendation-history',
  },
  {
    method: 'POST',
    path: '/api/v1/recommendations/:id/added-to-plan',
    domain: 'recommendation',
    reason: 'recommendation-history',
  },
  { method: 'GET', path: '/api/v1/search', domain: 'search', reason: 'search' },
  { method: 'GET', path: '/api/v1/favorites', domain: 'search', reason: 'favorites' },
  { method: 'POST', path: '/api/v1/settings/onboarding', domain: 'settings', reason: 'onboarding' },
  { method: 'GET', path: '/api/v1/settings/access-qr', domain: 'settings', reason: 'access-qr' },
  {
    method: 'PUT',
    path: '/api/v1/shopping-lists/:id',
    domain: 'shopping',
    reason: 'shopping-list-update',
  },
  {
    method: 'DELETE',
    path: '/api/v1/shopping-lists/:id',
    domain: 'shopping',
    reason: 'shopping-list-delete',
  },
  {
    method: 'POST',
    path: '/api/v1/shopping-lists/generate',
    domain: 'shopping',
    reason: 'shopping-generate',
  },
  { method: 'GET', path: '/api/v1/stores/candidates', domain: 'store', reason: 'store-candidates' },
  {
    method: 'DELETE',
    path: '/api/v1/uploads/images/:id',
    domain: 'upload',
    reason: 'upload-delete',
  },
] as const satisfies readonly RetiredEndpointSpec[];

/** 其余上游注册路由：Google2 未调用，剔除范围尚待确认。 */
export const UNCLASSIFIED_ENDPOINTS = [
  { method: 'GET', path: '/api/v1/diners/:id', domain: 'diner' },
  { method: 'GET', path: '/api/v1/health', domain: 'system' },
  { method: 'GET', path: '/api/v1/plans/:id', domain: 'plan' },
  { method: 'GET', path: '/api/v1/tools/:id', domain: 'tool' },
  { method: 'POST', path: '/api/v1/ingredients/:id/adjust', domain: 'ingredient' },
  { method: 'POST', path: '/api/v1/recommendations/:id/add-to-plan', domain: 'recommendation' },
  { method: 'POST', path: '/api/v1/recommendations/meal-set', domain: 'recommendation' },
  { method: 'PUT', path: '/api/v1/settings', domain: 'settings' },
] as const satisfies readonly EndpointSpec[];

/** 上游声明的全部 API 端点。 */
export function upstreamEndpoints(): EndpointSpec[] {
  return [...RETAINED_ENDPOINTS, ...RETIRED_ENDPOINTS, ...UNCLASSIFIED_ENDPOINTS];
}
