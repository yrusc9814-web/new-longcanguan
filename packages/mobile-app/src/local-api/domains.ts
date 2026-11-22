import type { DatabaseClient } from '../db/database.js';
import { registerBackups } from '../modules/backup/index.js';
import { registerDashboard } from '../modules/dashboard/index.js';
import { registerDiners } from '../modules/diners/index.js';
import { registerIngredients } from '../modules/ingredients/index.js';
import { registerInventory } from '../modules/inventory/index.js';
import { registerMealPlans } from '../modules/meal-plans/index.js';
import { registerMealRecords } from '../modules/meal-records/index.js';
import { registerRecipeCookCheckin } from '../modules/recipes/cook-checkin.js';
import { registerRecipes } from '../modules/recipes/index.js';
import { registerShopping } from '../modules/shopping/index.js';
import { registerRecommendations } from '../modules/recommendations/index.js';
import { registerSettings } from '../modules/settings/index.js';
import { createSettingsService, type SettingsService } from '../modules/settings/service.js';
import { registerStatistics } from '../modules/statistics/index.js';
import { createMemoryAppSecurity } from '../native/app-security.js';
import { createPinSession } from '../native/pin-session.js';
import { registerStores } from '../modules/stores/index.js';
import { registerTools } from '../modules/tools/index.js';
import { registerUploads } from '../modules/uploads/index.js';
import type { SyncEngine } from '../sync/engine.js';
import { readBinding } from '../sync/ledger.js';
import { SyncHttpError } from '../sync/http.js';
import { LocalApiError } from './protocol.js';
import type { LocalApiRouter } from './router.js';

export function registerDomainRoutes(
  router: LocalApiRouter,
  getDatabase: () => Promise<DatabaseClient>,
  settings: SettingsService = createSettingsService(
    getDatabase,
    createPinSession(createMemoryAppSecurity()),
    router.options.now,
  ),
  sync?: SyncEngine,
): void {
  registerRecipes(router, getDatabase);
  registerRecipeCookCheckin(router, getDatabase);
  registerMealPlans(router, getDatabase);
  registerMealRecords(router, getDatabase);
  registerShopping(router, getDatabase);
  registerStores(router, getDatabase);
  registerDiners(router, getDatabase);
  registerIngredients(router, getDatabase);
  registerInventory(router, getDatabase);
  registerTools(router, getDatabase);
  registerRecommendations(router, getDatabase);
  registerDashboard(router, getDatabase);
  registerStatistics(router, getDatabase);
  registerSettings(router, settings);
  registerUploads(router, getDatabase);
  registerBackups(router, getDatabase, {
    consumers: settings,
    async restoreBound(database, request) {
      if (!sync) return undefined;
      const binding = await readBinding(database);
      if (!binding) return undefined;
      if (binding.role !== 'OWNER') {
        throw new LocalApiError(403, 'FORBIDDEN', '只有馆主可以恢复家庭账本');
      }
      try {
        return await sync.restoreOwnerBackup(database, request, settings);
      } catch (error) {
        if (error instanceof SyncHttpError) {
          throw new LocalApiError(error.status, error.code, error.message);
        }
        throw error;
      }
    },
  });
}
