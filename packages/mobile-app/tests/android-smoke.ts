import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const packageName = 'com.dafan.xiaoguan';
const serial = process.argv[2] ?? 'emulator-5554';
const port = process.argv[3] ?? '9229';

function adb(...args: string[]): string {
  return execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 30_000 }).trim();
}

interface SmokeItem {
  id: string;
  version: number;
  name: string;
  stock?: number;
}

interface SmokeService {
  data: SmokeItem[];
  save(values: Record<string, unknown>): Promise<SmokeItem>;
  delete(id: string): Promise<void>;
  consume(id: string, amount: { quantity: number; unit: string }): Promise<SmokeItem>;
}

interface SmokeWindow {
  Capacitor: { getPlatform(): string };
  DafanApiClient: {
    get<T>(path: string): Promise<T>;
    post<T>(path: string, values: unknown): Promise<T>;
    put<T>(path: string, values: unknown): Promise<T>;
  };
  DafanDomainAdapter: Record<string, (service: { data: SmokeItem[] }) => unknown>;
}

async function exerciseWebView(prefix: string) {
  const app = window as unknown as SmokeWindow;
  function check(condition: unknown, label: string): asserts condition {
    if (!condition) throw new Error(label);
  }
  if (document.readyState !== 'complete') {
    await new Promise<void>((resolve) =>
      window.addEventListener('load', () => resolve(), { once: true }),
    );
  }
  const api = app.DafanApiClient;
  const adapter = app.DafanDomainAdapter;
  check(app.Capacitor && api && adapter, 'Packaged Capacitor adapter failed to load');
  function service(method: string): SmokeService {
    const state: { data: SmokeItem[] } = { data: [] };
    adapter[method](state);
    return state as SmokeService;
  }
  const checks: string[] = [];
  const platform = app.Capacitor.getPlatform();
  check(platform === 'android', 'Capacitor did not report Android');
  const health = await api.get<{ database: { status: string; provider: string } }>('/health');
  check(health.database.provider === 'sqlite' && health.database.status === 'ok', 'SQLite health');
  checks.push('android-sqlite-health');

  const tools = service('replaceToolService');
  const rawTool = await tools.save({ name: `${prefix} 厨具` });
  const tool = await tools.save({ id: rawTool.id, name: `${prefix} 厨具更新`, icon: '锅' });
  const toolList = await api.get<SmokeItem[]>('/tools');
  check(
    tool.version === 2 && toolList.some((item) => item.id === tool.id && item.name === tool.name),
    'tool CRUD',
  );
  checks.push('tool-create-update-read');

  const stores = service('replaceStoreService');
  const rawStore = await stores.save({
    name: `${prefix} 店铺`,
    supportsDineIn: true,
    mealTypes: ['DINNER'],
    menuItems: [{ name: '原菜单' }],
  });
  const store = await stores.save({
    id: rawStore.id,
    name: `${prefix} 店铺更新`,
    mealTypes: ['LUNCH'],
    menuItems: [{ name: '新菜单', isSignature: true }],
  });
  const storeDetail = await api.get<{
    version: number;
    supportsDineIn: boolean;
    menuItems: Array<{ isSignature: boolean; name: string }>;
  }>(`/stores/${store.id}`);
  check(
    storeDetail.version === 2 &&
      storeDetail.supportsDineIn === true &&
      storeDetail.menuItems[0]?.name === '新菜单' &&
      storeDetail.menuItems[0]?.isSignature === true,
    'store CRUD and menu',
  );
  checks.push('store-create-update-read');

  const rawDiner = await api.post<SmokeItem>('/diners', { name: `${prefix} 食用者`, active: true });
  const diner = await api.put<SmokeItem & { active: boolean; tabooText: string }>(
    `/diners/${rawDiner.id}`,
    { version: rawDiner.version, name: `${prefix} 食用者更新`, tabooText: '花生' },
  );
  const diners = await api.get<{ items: Array<SmokeItem & { tabooText: string }> }>(
    `/diners?active=true&search=${prefix}`,
  );
  check(
    diner.version === 2 &&
      diner.active === true &&
      diners.items.some((item) => item.id === diner.id && item.tabooText === '花生'),
    'diner CRUD',
  );
  checks.push('diner-create-update-read');

  const pantry = service('replacePantryService');
  const rawIngredient = await pantry.save({
    name: `${prefix} 米`,
    unitKey: 'KILOGRAM',
    stock: 1,
    opened: false,
  });
  const ingredient = await pantry.save({
    id: rawIngredient.id,
    version: rawIngredient.version,
    name: rawIngredient.name,
    unitKey: 'KILOGRAM',
    stock: 1.5,
  });
  check(ingredient.version === 2 && ingredient.stock === 1.5, 'ingredient batch rebalance');
  const consumed = await pantry.consume(ingredient.id, { quantity: 100, unit: 'GRAM' });
  const ingredientDetail = await api.get<{ quantity: number; opened: boolean; version: number }>(
    `/ingredients/${ingredient.id}`,
  );
  check(
    consumed.version === 3 &&
      ingredientDetail.version === 3 &&
      ingredientDetail.quantity === 1.4 &&
      ingredientDetail.opened === false,
    'ingredient native consume',
  );
  try {
    await api.post(`/ingredients/${ingredient.id}/consume`, {
      ingredientVersion: 3,
      mode: 'QUANTITY',
      unit: 'GRAM',
      quantity: 1500,
    });
    throw new Error('Overdraw succeeded');
  } catch (error) {
    check((error as { status?: number }).status === 409, 'Overdraw did not return 409');
  }
  checks.push('ingredient-create-rebalance-consume-overdraw');

  const recipes = service('replaceRecipeService');
  const definition = {
    name: `${prefix} 菜谱 <"&>`,
    ingredients: [
      {
        name: ingredient.name,
        ingredientId: ingredient.id,
        quantity: 100,
        unit: 'GRAM',
        optional: false,
        isPrimary: true,
      },
    ],
    steps: [{ content: '第一步' }],
    toolIds: [{ name: tool.name, toolId: tool.id, required: true }],
  };
  const rawRecipe = await recipes.save(definition);
  const edited = await recipes.save({
    ...definition,
    id: rawRecipe.id,
    version: rawRecipe.version,
    steps: [{ content: '第二步' }],
  });
  const recipe = await recipes.save({
    ...definition,
    id: rawRecipe.id,
    version: edited.version,
    steps: [{ content: '第三步 <"&>' }],
  });
  const recipeDetail = await api.get<{
    name: string;
    version: number;
    enabledForRecommendation: boolean;
    steps: Array<{ content: string }>;
  }>(`/recipes/${recipe.id}`);
  check(
    recipeDetail.name === definition.name &&
      recipeDetail.version === 3 &&
      recipeDetail.enabledForRecommendation === true &&
      recipeDetail.steps[0]?.content === '第三步 <"&>',
    'recipe CRUD',
  );
  checks.push('recipe-create-update-update-read');

  const recommend = await api.post<{
    items: Array<{ recipe: { id: string }; completion: number; inventoryCheckable: boolean }>;
  }>('/kitchen/recommend', { mode: 'ONLY_INVENTORY', dinerIds: [diner.id], limit: 100 });
  check(
    recommend.items.some(
      (item) =>
        item.recipe.id === recipe.id && item.completion === 100 && item.inventoryCheckable === true,
    ),
    'kitchen recommendation',
  );
  checks.push('kitchen-recommend');

  await recipes.delete(recipe.id);
  await pantry.delete(ingredient.id);
  await stores.delete(store.id);
  await tools.delete(tool.id);
  await api.put(`/diners/${diner.id}`, { version: diner.version, active: false });
  const activeDiners = await api.get<{ total: number }>(`/diners?active=true&search=${prefix}`);
  check(activeDiners.total === 0, 'diner deactivation');
  checks.push('adapter-delete-and-diner-deactivate');
  return {
    platform,
    health,
    checks,
    ids: {
      Recipe: recipe.id,
      Ingredient: ingredient.id,
      Store: store.id,
      KitchenTool: tool.id,
      Diner: diner.id,
    },
  };
}

type SmokeResult = Awaited<ReturnType<typeof exerciseWebView>>;

async function evaluate(debugUrl: string, prefix: string): Promise<SmokeResult> {
  const socket = new WebSocket(debugUrl);
  return new Promise<SmokeResult>((resolve, reject) => {
    const deadline = setTimeout(() => {
      socket.close();
      reject(new Error('Android WebView smoke timed out'));
    }, 120_000);
    socket.addEventListener(
      'open',
      () => {
        socket.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression: `(${exerciseWebView.toString()})(${JSON.stringify(prefix)})`,
              awaitPromise: true,
              returnByValue: true,
            },
          }),
        );
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(deadline);
        reject(new Error('Android WebView debugger connection failed'));
      },
      { once: true },
    );
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(deadline);
      socket.close();
      if (message.error || message.result?.exceptionDetails) {
        const exception = message.result?.exceptionDetails;
        reject(
          new Error(
            exception?.exception?.description ?? exception?.text ?? JSON.stringify(message.error),
          ),
        );
      } else {
        resolve(message.result.result.value as SmokeResult);
      }
    });
  });
}

function sqlite<T>(sql: string): T[] {
  const escaped = `'${sql.replaceAll("'", "'\\''")}'`;
  const result = adb(
    'shell',
    `run-as ${packageName} sqlite3 -readonly -json databases/dafanSQLite.db ${escaped}`,
  );
  return result ? (JSON.parse(result) as T[]) : [];
}

interface OutboxRow {
  rowid: number;
  kind: string;
  commandType: string | null;
  baseVersion: number | null;
  payloadJson: string;
  payloadHash: string;
}

function verifyNativeDatabase(ids: SmokeResult['ids']) {
  assert.deepEqual(sqlite('PRAGMA user_version'), [{ user_version: 2 }]);
  assert.deepEqual(sqlite('PRAGMA foreign_key_check'), []);
  const expectedVersions = { Recipe: 4, Ingredient: 4, Store: 3, KitchenTool: 3, Diner: 3 };
  const outbox = {} as Record<keyof typeof ids, OutboxRow[]>;
  for (const [entity, id] of Object.entries(ids) as Array<[keyof typeof ids, string]>) {
    assert.match(id, /^[\da-f-]+$/i);
    const rows = sqlite<OutboxRow>(
      `SELECT rowid, kind, commandType, baseVersion, payloadJson, payloadHash FROM sync_outbox WHERE entity = '${entity}' AND entityId = '${id}' ORDER BY rowid`,
    );
    assert.deepEqual(
      rows.map((row) => row.baseVersion),
      Array.from({ length: expectedVersions[entity] }, (_, index) => index || null),
      `${entity} FIFO versions`,
    );
    for (const row of rows)
      assert.equal(row.payloadHash, createHash('sha256').update(row.payloadJson).digest('hex'));
    const [terminal] = sqlite<{ version: number; deletedAt?: string; active?: number }>(
      `SELECT version, ${entity === 'Diner' ? 'active' : 'deletedAt'} FROM "${entity}" WHERE id = '${id}'`,
    );
    assert.equal(terminal.version, expectedVersions[entity]);
    if (entity === 'Diner') {
      assert.equal(terminal.active, 0);
    } else {
      assert.ok(terminal.deletedAt);
      assert.equal(rows.at(-1)?.kind, 'delete');
      assert.deepEqual(JSON.parse(rows.at(-1)!.payloadJson), { deletedAt: terminal.deletedAt });
    }
    outbox[entity] = rows;
  }
  const ingredientRows = outbox.Ingredient;
  assert.deepEqual(
    ingredientRows.map((row) => row.commandType),
    [null, 'INGREDIENT_UPDATE_SYNC_BATCHES', 'INGREDIENT_CONSUME', null],
  );
  const batches = sqlite<{ id: string }>(
    `SELECT id FROM InventoryBatch WHERE ingredientId = '${ids.Ingredient}'`,
  );
  const logs = sqlite<{
    id: string;
    inventoryBatchId: string;
    createdAt: string;
    changeType: string;
  }>(
    `SELECT id, inventoryBatchId, createdAt, changeType FROM InventoryLog WHERE ingredientId = '${ids.Ingredient}' ORDER BY rowid`,
  );
  const create = JSON.parse(ingredientRows[0].payloadJson);
  const update = JSON.parse(ingredientRows[1].payloadJson);
  const consume = JSON.parse(ingredientRows[2].payloadJson);
  assert.deepEqual(
    logs.map(({ changeType }) => changeType),
    ['PURCHASE', 'ADJUST', 'MANUAL_DEDUCT'],
  );
  assert.equal(create.inventoryLogs[0].id, logs[0].id);
  assert.equal(create.inventoryLogs[0].inventoryBatchId, logs[0].inventoryBatchId);
  assert.equal(create.inventoryLogs[0].createdAt, logs[0].createdAt);
  assert.deepEqual(update.addedBatch, { batchId: logs[1].inventoryBatchId, logId: logs[1].id });
  assert.equal(update.executedAt, logs[1].createdAt);
  assert.deepEqual(consume.inventoryLogIds, [logs[2].id]);
  assert.equal(consume.executedAt, logs[2].createdAt);
  assert.deepEqual(
    batches.map(({ id }) => id).sort(),
    [create.batches[0].id, update.addedBatch.batchId].sort(),
  );
  return Object.fromEntries(
    Object.entries(outbox).map(([entity, rows]) => [
      entity,
      rows.map(({ kind, baseVersion, commandType }) => ({
        kind,
        baseVersion,
        ...(commandType ? { commandType } : {}),
      })),
    ]),
  );
}

const network = {
  airplaneMode: adb('shell', 'cmd', 'connectivity', 'airplane-mode'),
  wifi: adb('shell', 'settings', 'get', 'global', 'wifi_on'),
  mobileData: adb('shell', 'settings', 'get', 'global', 'mobile_data'),
};
assert.deepEqual(network, { airplaneMode: 'enabled', wifi: '0', mobileData: '0' });
const [pid] = adb('shell', 'pidof', packageName).split(/\s+/);
assert.match(pid, /^\d+$/, 'Launch the installed Debug APK first');
adb('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);
try {
  const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
    response.json(),
  )) as Array<{ url: string; webSocketDebuggerUrl: string }>;
  const page = targets.find(({ url }) => url === 'https://localhost/');
  assert.ok(page, 'Capacitor WebView target was not present');
  const prefix = `T003b-${randomUUID().slice(0, 8)}`;
  const webview = await evaluate(page.webSocketDebuggerUrl, prefix);
  const outbox = verifyNativeDatabase(webview.ids);
  console.log(
    JSON.stringify(
      {
        serial,
        platform: webview.platform,
        apiLevel: adb('shell', 'getprop', 'ro.build.version.sdk'),
        network,
        sqlite: webview.health.database,
        fixture: prefix,
        checks: webview.checks,
        outbox,
        verified: [
          'schema-v2',
          'foreign-key-check',
          'exact-delete-timestamps',
          'payload-sha256',
          'batch-and-log-primary-keys',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  adb('forward', '--remove', `tcp:${port}`);
}
