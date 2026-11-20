import { describe, expect, it } from 'vitest';
import {
  RETAINED_ENDPOINTS,
  RETIRED_ENDPOINTS,
  UPSTREAM_COMMIT,
  upstreamEndpoints,
} from '../src/contracts/endpoints.js';
import { RETAINED_MODELS, RETIRED_MODELS } from '../src/contracts/models.js';
import upstream from './fixtures/e778d3b.json';

const routeKey = ({ method, path }: { method: string; path: string }) => `${method} ${path}`;

describe('固定提交基准', () => {
  it('上游 91 个注册端点分为 61 个保留和 30 个剔除', () => {
    expect(UPSTREAM_COMMIT).toBe(upstream.commit);
    expect(RETAINED_ENDPOINTS).toHaveLength(61);
    expect(RETIRED_ENDPOINTS).toHaveLength(30);
    const routes = upstreamEndpoints().map(routeKey);
    expect(routes).toEqual([...RETAINED_ENDPOINTS, ...RETIRED_ENDPOINTS].map(routeKey));
    expect(routes).toHaveLength(91);
    expect(new Set(routes).size).toBe(routes.length);
    expect(routes.sort()).toEqual([...upstream.routes].sort());
  });

  it('保留 Google2 的 59 个实际调用以及健康检查和设置更新', () => {
    expect(upstream.google2Routes).toHaveLength(59);
    expect(RETAINED_ENDPOINTS.map(routeKey).sort()).toEqual(
      [...upstream.google2Routes, 'GET /api/v1/health', 'PUT /api/v1/settings'].sort(),
    );
  });

  it('保留和剔除名单覆盖 30 个上游模型，没有重复或遗漏', () => {
    expect(RETAINED_MODELS).toHaveLength(27);
    expect([...RETIRED_MODELS].sort()).toEqual([
      'ConsumptionOperation',
      'DeletedItem',
      'RecommendationHistory',
    ]);
    const models = [...RETAINED_MODELS, ...RETIRED_MODELS];
    expect(models).toHaveLength(30);
    expect(new Set(models).size).toBe(models.length);
    expect(models.sort()).toEqual([...upstream.models].sort());
  });
});
