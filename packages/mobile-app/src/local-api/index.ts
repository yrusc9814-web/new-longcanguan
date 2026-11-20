/**
 * 本地 API 层入口。
 *
 * 集成方式（bootstrap 侧）：
 *   const router = createLocalApiRouter({ readGateState, isPinTokenValid, healthDatabaseProbe });
 *   globalThis.fetch = createLocalApiFetch({ router, origin: location.origin });
 *
 * 路由本身不读写数据库、不调用 Native 桥接；门禁状态与 PIN 校验由调用方注入，
 * 未注入时按 fail closed 处理（需 PIN 且所有 token 无效）。
 */
export * from './protocol.js';
export * from './router.js';
