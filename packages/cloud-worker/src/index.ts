import { HouseholdHub } from './household-hub';

export { HouseholdHub };

export interface Env {
  HOUSEHOLD_HUB: DurableObjectNamespace<HouseholdHub>;
  PRIVATE_BUCKET: R2Bucket;
  OWNER_BOOTSTRAP_SECRET?: string;
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
        return methodNotAllowed(request.method, url.pathname, ['GET']);
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

    const { pathname } = url;
    if (pathname.startsWith('/api/household/') || pathname.startsWith('/api/sync/')) {
      return defaultHub(env).fetch(request);
    }

    return json({ error: 'not_found', message: `No route for ${request.method} ${pathname}` }, 404);
  },
} satisfies ExportedHandler<Env>;

function defaultHub(env: Env): DurableObjectStub<HouseholdHub> {
  const namespace = env.HOUSEHOLD_HUB;
  return namespace.get(namespace.idFromName('default'));
}

function methodNotAllowed(method: string, pathname: string, allowed: string[]): Response {
  return json(
    { error: 'method_not_allowed', message: `Method ${method} is not allowed on ${pathname}` },
    405,
    { allow: allowed.join(', ') },
  );
}
