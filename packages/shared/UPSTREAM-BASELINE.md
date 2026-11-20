# Google2 裁剪基准

来源为 `da-fan-xiao-guan@e778d3bd3354123032e570e03ad85c6b19bd9ea4`。AC2 要求的 38 条保留和 62 条总数与该提交不符。

| 核对项                                  | 实际数量 | 取证位置                                                          |
| --------------------------------------- | -------: | ----------------------------------------------------------------- |
| 显式注册的 `/api/v1/*` 路由             |       91 | `app/server/src/app.ts:52` 至 `:71` 调用的模块路由注册器          |
| Google2 生产源码发出的不同请求          |       59 | `app/client/index.html` 和 `app/client/public/google2-adapter.js` |
| 指定剔除组在上游的对应路由              |       24 | 已注册且未发现 Google2 调用                                       |
| 未见 Google2 调用且不在指定剔除组的路由 |        8 | 保持待定                                                          |
| 上游 Prisma 模型                        |       30 | `app/server/prisma/schema.prisma` 中的 `model` 声明               |

路由按 HTTP 方法与路径去重，查询参数不参与计数，动态实体 ID 归一为 `:id`。不计生产静态兜底、`GET /uploads/*`、框架自动生成的 HEAD 和 CORS 预检。Google2 除了字面请求，还包含 `loadAll()` 分页、记录确认失败回读、购物补货和 `index.html:7511` 的厨房推荐调用。

任务中的四条消费接口实际分布在 `/consumption` 和 `/records/:id`。任务中的 `/recommendations/meal` 和 `/recommendations/by-inventory` 未在固定提交中注册。推荐模块的五条非随机路由里，`POST /recommendations/meal-set` 与 `POST /recommendations/:id/add-to-plan` 是多出来的两个真实路径，保留为待定，等待确认是否纳入剔除组。

`RecommendationHistory`、`ConsumptionOperation` 和 `DeletedItem` 按目标架构列为剔除表。上游 `POST /api/v1/recommendations/random` 仍调用 `save()` 写入 `RecommendationHistory`，见 `app/server/src/modules/recommendations/service.ts:203`、`:239`。后续实现随机推荐时，需处理这项依赖，不能直接复制上游服务逻辑。

测试基准由固定提交的路由声明、页面和 schema 独立提取。测试以完整集合对照分类常量，校验生产调用覆盖、剔除组和模型的数量及互斥关系。 [固定提交清单](tests/fixtures/e778d3b.json)
