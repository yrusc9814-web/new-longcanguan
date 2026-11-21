import type { LocalApiRouter } from '../../local-api/router.js';
import { PIN_TOKEN_HEADER } from '../../local-api/router.js';
import { readObject } from '../common.js';
import type { SettingsService } from './service.js';

export function registerSettings(router: LocalApiRouter, service: SettingsService) {
  router.register('GET', '/api/v1/settings', () => service.read());
  router.register('PUT', '/api/v1/settings', async ({ request }) =>
    service.update(await readObject(request)),
  );
  router.register('GET', '/api/v1/settings/pin/session', ({ request }) =>
    service.sessionState(request.headers.get(PIN_TOKEN_HEADER)),
  );
  router.register('PUT', '/api/v1/settings/pin', async ({ request }) =>
    service.updatePin(await readObject(request), request.headers.get(PIN_TOKEN_HEADER)),
  );
  router.register('POST', '/api/v1/settings/pin/verify', async ({ request }) =>
    service.verify((await readObject(request)).pin),
  );
  router.register('POST', '/api/v1/settings/high-risk/authorize', async ({ request }) =>
    service.authorize(await readObject(request)),
  );
}
