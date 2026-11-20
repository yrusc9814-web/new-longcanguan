import { DurableObject } from 'cloudflare:workers';

/**
 * Cloudflare Workers 入口：仅包含健康检查骨架，不含任何业务同步逻辑。
 */

export interface Env {
  /** HouseholdHub Durable Object 命名空间（占位）。 */
  HOUSEHOLD_HUB: DurableObjectNamespace<HouseholdHub>;
  /** 私有 R2 存储桶（占位）。 */
  PRIVATE_BUCKET: R2Bucket;
}

const SERVICE_NAME = 'cloud-worker';
const HEALTH_PATH = '/api/cloud/health';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === HEALTH_PATH) {
      if (request.method !== 'GET') {
        return json(
          {
            error: 'method_not_allowed',
            message: `Method ${request.method} is not allowed on ${HEALTH_PATH}`,
          },
          405,
          { allow: 'GET' },
        );
      }

      return json({
        status: 'ok',
        service: SERVICE_NAME,
        bindings: {
          householdHub: env.HOUSEHOLD_HUB != null,
          privateBucket: env.PRIVATE_BUCKET != null,
        },
      });
    }

    return json(
      { error: 'not_found', message: `No route for ${request.method} ${url.pathname}` },
      404,
    );
  },
} satisfies ExportedHandler<Env>;

/**
 * HouseholdHub Durable Object 占位实现。
 * 仅提供服务级探针，不承载任何同步或持久化业务。
 */
export class HouseholdHub extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return json({ ok: true, object: 'household-hub' });
  }
}
