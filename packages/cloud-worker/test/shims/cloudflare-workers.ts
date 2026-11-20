/**
 * 仅用于 Node/Vitest 的 `cloudflare:workers` 运行时替身。
 *
 * 生产代码从 `cloudflare:workers` 导入 `DurableObject`；该模块只存在于 Workers 运行时
 * （类型由 @cloudflare/workers-types 提供）。测试通过 vitest alias 指向本文件，
 * 从而无需在 Node 下引入 Workerd。
 */
export abstract class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
