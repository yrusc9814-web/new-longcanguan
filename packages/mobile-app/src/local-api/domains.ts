import type { DatabaseClient } from '../db/database.js';
import { registerDiners } from '../modules/diners/index.js';
import { registerIngredients } from '../modules/ingredients/index.js';
import { registerInventory } from '../modules/inventory/index.js';
import { registerRecipes } from '../modules/recipes/index.js';
import { registerStores } from '../modules/stores/index.js';
import { registerTools } from '../modules/tools/index.js';
import type { LocalApiRouter } from './router.js';

export function registerDomainRoutes(
  router: LocalApiRouter,
  getDatabase: () => Promise<DatabaseClient>,
): void {
  registerRecipes(router, getDatabase);
  registerStores(router, getDatabase);
  registerDiners(router, getDatabase);
  registerIngredients(router, getDatabase);
  registerInventory(router, getDatabase);
  registerTools(router, getDatabase);
}
