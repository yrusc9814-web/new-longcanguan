# Google2 裁剪基准

以 `da-fan-xiao-guan@e778d3bd3354123032e570e03ad85c6b19bd9ea4` 为准。T-001b 将 91 条上游路由划分为 61 条保留和 30 条剔除，待定 0 条。

- 保留 Google2 的 59 条生产调用，以及 `GET /api/v1/health` 和 `PUT /api/v1/settings`。
- 剔除原有 24 条遗留路由，以及 6 条 Google2 未调用的路由。
  - `POST /api/v1/recommendations/meal-set`
  - `POST /api/v1/recommendations/:id/add-to-plan`
  - `POST /api/v1/ingredients/:id/adjust`
  - `GET /api/v1/diners/:id`
  - `GET /api/v1/plans/:id`
  - `GET /api/v1/tools/:id`
- 30 个上游 Prisma 模型分为 27 张保留表和 3 张剔除表。剔除表为 `ConsumptionOperation`、`RecommendationHistory` 和 `DeletedItem`。

路由声明来自 `app/server/src/app.ts:52` 至 `:71` 调用的模块路由注册器。按 HTTP 方法和路径去重，忽略查询参数，动态实体 ID 归一为 `:id`。统计范围为显式注册的 `/api/v1/*`，排除生产静态兜底、`GET /uploads/*`、框架自动生成的 HEAD 和 CORS 预检。生产调用来自 `app/client/index.html` 和 `app/client/public/google2-adapter.js`，包括分页、记录确认失败后的回读、购物补货和厨房推荐。

上游 `POST /api/v1/recommendations/random` 调用 `save()` 写入 `RecommendationHistory`。实现随机推荐时需解除这项表依赖。参见 `app/server/src/modules/recommendations/service.ts:203` 和 `:239`。

单测将路由和模型分类与独立提取的固定提交清单对照，验证完整性、互斥性和 Google2 调用覆盖。[固定提交清单](tests/fixtures/e778d3b.json)
