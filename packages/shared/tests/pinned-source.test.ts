import { describe, expect, it } from 'vitest';
import {
  RETAINED_ENDPOINTS,
  RETIRED_ENDPOINTS,
  UNCLASSIFIED_ENDPOINTS,
  UPSTREAM_COMMIT,
  upstreamEndpoints,
} from '../src/contracts/endpoints.js';
import { RETAINED_MODELS, RETIRED_MODELS } from '../src/contracts/models.js';
import upstream from './fixtures/e778d3b.json';

const routeKey = ({ method, path }: { method: string; path: string }) => `${method} ${path}`;

describe('固定提交基准', () => {
  it('上游 91 个注册端点全部归类，没有重复或遗漏', () => {
    expect(UPSTREAM_COMMIT).toBe(upstream.commit);
    const routes = upstreamEndpoints().map(routeKey);
    expect(RETIRED_ENDPOINTS).toHaveLength(24);
    expect(UNCLASSIFIED_ENDPOINTS).toHaveLength(8);
    expect(routes).toHaveLength(91);
    expect(new Set(routes).size).toBe(routes.length);
    expect(routes.sort()).toEqual([...upstream.routes].sort());
  });

  it('保留侧与 Google2 的 59 个实际调用一致', () => {
    expect(upstream.google2Routes).toHaveLength(59);
    expect(RETAINED_ENDPOINTS.map(routeKey).sort()).toEqual([...upstream.google2Routes].sort());
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
