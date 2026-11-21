import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { RETAINED_ENDPOINTS, RETAINED_MODELS } from '@dafan/shared/contracts';
import type {
  DashboardDto,
  HealthData,
  IngredientDto,
  MealPlanDto,
  MealRecordDto,
  ShoppingListDto,
  StatisticsDto,
  UploadAssetDto,
} from '@dafan/shared/types';

const appId = 'com.dafan.xiaoguan';
const serial = process.argv[2] ?? 'emulator-5554';
const user = Number(process.argv[3] ?? '0');
const port = process.argv[4] ?? '9230';

function adb(...args: string[]) {
  return execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 30_000 }).trim();
}

function appShell(command: string) {
  return adb('shell', `run-as ${appId} --user ${user} ${command}`);
}

function sqlite<T>(sql: string): T[] {
  const escaped = `'${sql.replaceAll("'", "'\\''")}'`;
  const output = appShell(`sqlite3 -readonly -json databases/dafanSQLite.db ${escaped}`);
  return output ? (JSON.parse(output) as T[]) : [];
}

async function runBusiness(prefix: string, retained: typeof RETAINED_ENDPOINTS) {
  const exercised = new Set<string>();
  function track(method: string, path: string, response: Response) {
    const pathname = `/api/v1${path.split('?')[0]}`;
    const route = retained.find(
      (candidate) =>
        candidate.method === method &&
        candidate.path.split('/').length === pathname.split('/').length &&
        candidate.path
          .split('/')
          .every((part, index) => part === ':id' || part === pathname.split('/')[index]),
    );
    if (route && response.ok) exercised.add(`${method} ${route.path}`);
  }
  interface Call {
    status: number;
    error?: { code: string; message: string };
  }
  const session: { token?: string } = {};
  async function call(
    path: string,
    method = 'GET',
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    const headers = new Headers(extra);
    if (session.token) headers.set('x-app-pin-token', session.token);
    const form = body instanceof FormData;
    if (body !== undefined && !form) headers.set('content-type', 'application/json');
    const response = await fetch(`/api/v1${path}`, {
      method,
      headers,
      body: form ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    check(
      response.headers.get('content-type')?.includes('application/json'),
      `${method} ${path} returned ${response.status} ${response.headers.get('content-type')}`,
    );
    track(method, path, response);
    return { ...(await response.json()), status: response.status } as Call & { data?: unknown };
  }
  async function ok<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const result = await call(path, method, body);
    check(
      result.status >= 200 && result.status < 300,
      `${method} ${path}: ${result.status} ${result.error?.code ?? ''} ${result.error?.message ?? ''}`,
    );
    return result.data as T;
  }
  function check(condition: unknown, label: string): asserts condition {
    if (!condition) throw new Error(label);
  }
  check(
    (window as unknown as { Capacitor: { getPlatform(): string } }).Capacitor.getPlatform() ===
      'android',
    'Android WebView',
  );
  check((await ok<HealthData>('/health')).database.provider === 'sqlite', 'Native SQLite health');
  type Settings = { version: number; pinEnabled: boolean };
  type Created = { id: string };
  type Versioned = { id: string; version: number };
  type Completed = {
    plan: MealPlanDto;
    record: MealRecordDto;
    inventoryDeductionPromptEnabled: boolean;
  };
  type DraftRemoved = { plan: MealPlanDto; removedRecord: Created };
  let initialSettings = await ok<Settings>('/settings');
  check(!initialSettings.pinEnabled, 'Run in a clean emulator user or with the smoke PIN disabled');
  initialSettings = await ok<Settings>('/settings', 'PUT', {
    version: initialSettings.version,
    autoDeductInventory: true,
  });
  await ok('/settings/pin/session');
  const day = new Date();
  const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const recipe = await ok<Created>('/recipes', 'POST', {
    name: `${prefix}-recipe`,
    category: '热菜',
    calories: 300,
  });
  const diner = await ok<Versioned>('/diners', 'POST', { name: `${prefix}-diner` });
  await ok('/diners');
  await ok(`/diners/${diner.id}`, 'PUT', { version: diner.version, notes: prefix });
  const tool = await ok<Versioned>('/tools', 'POST', { name: `${prefix}-tool` });
  await ok('/tools');
  const updatedTool = await ok<Versioned>(`/tools/${tool.id}`, 'PUT', {
    version: tool.version,
    name: `${prefix}-tool-updated`,
  });
  await ok(`/tools/${tool.id}?version=${updatedTool.version}`, 'DELETE');

  const store = await ok<Versioned>('/stores', 'POST', {
    name: `${prefix}-store`,
    supportsDineIn: true,
  });
  await ok('/stores');
  await ok(`/stores/${store.id}`);
  const updatedStore = await ok<Versioned>(`/stores/${store.id}`, 'PUT', {
    version: store.version,
    notes: prefix,
  });
  const favoredStore = await ok<Versioned>(`/stores/${store.id}/favorite`, 'POST', {
    version: updatedStore.version,
    favorite: true,
  });
  await ok(`/stores/${store.id}?version=${favoredStore.version}`, 'DELETE');

  const disposableRecipe = await ok<Versioned>('/recipes', 'POST', {
    name: `${prefix}-extra-recipe`,
  });
  await ok('/recipes');
  await ok(`/recipes/${recipe.id}`);
  const updatedRecipe = await ok<Versioned>(`/recipes/${disposableRecipe.id}`, 'PUT', {
    version: disposableRecipe.version,
    name: `${prefix}-extra-recipe`,
    notes: prefix,
  });
  const favoredRecipe = await ok<Versioned>(`/recipes/${disposableRecipe.id}/favorite`, 'POST', {
    version: updatedRecipe.version,
    favorite: true,
  });
  await ok(`/recipes/${disposableRecipe.id}?version=${favoredRecipe.version}`, 'DELETE');
  await ok('/kitchen/recommend', 'POST', { mode: 'ALLOW_PURCHASE' });
  await ok('/recommendations/random', 'POST', { sourceTypes: ['RECIPE'] });

  const ingredient = await ok<Versioned>('/ingredients', 'POST', {
    name: `${prefix}-pantry`,
    quantity: 5,
    unit: 'GRAM',
  });
  await ok(`/ingredients/${ingredient.id}`);
  const updatedIngredient = await ok<Versioned>(`/ingredients/${ingredient.id}`, 'PUT', {
    version: ingredient.version,
    name: `${prefix}-pantry`,
    unit: 'GRAM',
    quantity: 6,
  });
  await ok(`/ingredients/${ingredient.id}/consume`, 'POST', {
    mode: 'QUANTITY',
    ingredientVersion: updatedIngredient.version,
    quantity: 1,
    unit: 'GRAM',
  });
  const consumed = await ok<Versioned>(`/ingredients/${ingredient.id}`);
  await ok(`/ingredients/${ingredient.id}?version=${consumed.version}`, 'DELETE');

  const extraPlan = await ok<MealPlanDto>('/plans', 'POST', {
    planDate: date,
    mealType: 'BREAKFAST',
    dinerCount: 1,
    items: [{ itemType: 'RECIPE', recipeId: recipe.id }],
  });
  const editedPlan = await ok<MealPlanDto>(`/plans/${extraPlan.id}`, 'PUT', {
    version: extraPlan.version,
    notes: prefix,
  });
  await ok(`/plans/${extraPlan.id}?version=${editedPlan.version}`, 'DELETE');
  const manual = await ok<MealRecordDto>('/records', 'POST', {
    recordDate: date,
    mealType: 'BREAKFAST',
    sourceType: 'TAKEOUT',
    status: 'DRAFT',
    items: [{ itemType: 'CUSTOM', customName: prefix }],
  });
  await ok('/records');
  await ok(`/records/${manual.id}`);
  const editedRecord = await ok<MealRecordDto>(`/records/${manual.id}`, 'PUT', {
    version: manual.version,
    notes: prefix,
  });
  const confirmed = await ok<MealRecordDto>(`/records/${manual.id}/confirm`, 'POST', {
    version: editedRecord.version,
  });
  check(confirmed.status === 'CONFIRMED', 'Confirm manual record');

  const plan = await ok<MealPlanDto>('/plans', 'POST', {
    planDate: date,
    mealType: 'LUNCH',
    dinerCount: 1,
    title: `${prefix}-plan`,
    items: [{ itemType: 'RECIPE', recipeId: recipe.id, mealRole: 'MAIN' }],
    dinerIds: [diner.id],
  });
  const first = await ok<Completed>(`/plans/${plan.id}/complete`, 'POST', {
    version: plan.version,
  });
  check(
    first.plan.status === 'COMPLETED' &&
      first.record.status === 'DRAFT' &&
      first.inventoryDeductionPromptEnabled,
    'Completion creates draft',
  );
  const reverted = await ok<DraftRemoved>(`/plans/${plan.id}/uncomplete`, 'POST', {
    version: first.plan.version,
  });
  check(
    reverted.plan.status === 'PLANNED' && reverted.removedRecord.id === first.record.id,
    'Uncomplete removes auto draft',
  );
  const revived = await ok<Completed>(`/plans/${plan.id}/complete`, 'POST', {
    version: reverted.plan.version,
  });
  check(
    revived.record.id === first.record.id && revived.record.status === 'DRAFT',
    'Completion revives the same draft',
  );
  await ok(`/records/${revived.record.id}?version=${revived.record.version}`, 'DELETE');
  const plans = await ok<MealPlanDto[] | { items: MealPlanDto[] }>(
    `/plans?from=${date}&to=${date}`,
  );
  check(
    (Array.isArray(plans) ? plans : plans.items).some(
      (row: { id: string; status: string }) => row.id === plan.id && row.status === 'PLANNED',
    ),
    'Deleting linked record reverts plan',
  );

  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 480;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#ce322a';
  context.fillRect(0, 0, 480, 480);
  context.fillStyle = '#236fab';
  context.fillRect(480, 0, 480, 480);
  const jpegBlob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('JPEG encoding'))),
      'image/jpeg',
    ),
  );
  const jpg = new Uint8Array(await jpegBlob.arrayBuffer());
  // APP1/TIFF IFD0 with the camera Orientation tag set to 6 (clockwise 90 degrees).
  const exif = Uint8Array.of(
    255,
    225,
    0,
    34,
    69,
    120,
    105,
    102,
    0,
    0,
    73,
    73,
    42,
    0,
    8,
    0,
    0,
    0,
    1,
    0,
    18,
    1,
    3,
    0,
    1,
    0,
    0,
    0,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  );
  const photos = new FormData();
  photos.append(
    'file',
    new Blob([jpg.slice(0, 2), exif, jpg.slice(2)], { type: 'image/jpeg' }),
    'rotated.jpg',
  );
  const asset = await ok<UploadAssetDto>('/uploads/images', 'POST', photos);
  check(
    asset.mimeType === 'image/webp' &&
      asset.height === 960 &&
      asset.width === 480 &&
      asset.thumbnailUrl,
    'Upload normalizes EXIF portrait and emits thumbnail',
  );
  async function imageDimensions(path: string) {
    const response = await fetch(path, { cache: 'no-store' });
    check(
      response.status === 200 && response.headers.get('content-type')?.startsWith('image/webp'),
      `WebView native image ${response.status}`,
    );
    const src = new Image();
    return new Promise<number[]>((resolve, reject) => {
      src.onload = () => resolve([src.naturalWidth, src.naturalHeight]);
      src.onerror = () => reject(new Error('WebView could not load WebP'));
      src.src = path;
    });
  }
  const main = await imageDimensions(asset.url);
  const thumb = await imageDimensions(asset.thumbnailUrl);
  check(
    main[0] === 480 && main[1] === 960 && thumb[1]! > thumb[0]! && thumb[1]! < main[1]!,
    'Rendered WebP portrait and smaller portrait thumbnail',
  );

  const cookPath = `/recipes/${recipe.id}/cook-checkin`;
  const cookBody = {
    recordDate: date,
    mealType: 'DINNER',
    title: `${prefix}-cook`,
    photos: [asset.url],
    satiety: 7,
    cost: 0,
    dinerIds: [diner.id],
  };
  const cooked = await ok<{ record: MealRecordDto; repeated: boolean }>(cookPath, 'POST', cookBody);
  check(
    cooked.record.status === 'CONFIRMED' && cooked.record.photos?.[0] === asset.url,
    'Cook check-in references a registered upload',
  );
  const repeated = await ok<{ record: MealRecordDto; repeated: boolean }>(
    cookPath,
    'POST',
    cookBody,
  );
  check(repeated.record.id === cooked.record.id && repeated.repeated, 'Cook check-in idempotent');
  check(
    (await call(cookPath, 'POST', { ...cookBody, cost: 3 })).status === 409,
    'Conflicting cook check-in rejected',
  );

  const active = await ok<ShoppingListDto[]>('/shopping-lists?status=ACTIVE');
  let list = active[0]!;
  check(list.id === 'shopping_list_active_default', 'Fixed default shopping list ID');
  const shopPath = `/shopping-lists/${list.id}`;
  const secondaryList = await ok<ShoppingListDto>('/shopping-lists', 'POST', {
    name: `${prefix}-list`,
  });
  const secondaryPath = `/shopping-lists/${secondaryList.id}`;
  await ok(secondaryPath);
  const looseList = await ok<ShoppingListDto>(`${secondaryPath}/items`, 'POST', {
    version: secondaryList.version,
    ingredientName: `${prefix}-salt`,
    amountText: '少许',
  });
  const loose = looseList.items[0]!;
  check(
    (
      await call(`${secondaryPath}/check-in`, 'POST', {
        version: looseList.version,
        operationId: crypto.randomUUID(),
        itemIds: [loose.id],
      })
    ).status === 422,
    'Loose quantity rejects the whole check-in',
  );
  const checkedLoose = await ok<ShoppingListDto>(`/shopping-list-items/${loose.id}`, 'PUT', {
    version: looseList.version,
    completed: true,
  });
  const cleared = await ok<{ list: ShoppingListDto; cleared: number }>(
    `${secondaryPath}/clear-completed`,
    'POST',
    {
      version: checkedLoose.version,
    },
  );
  check(cleared.cleared === 1, 'Clear completed shopping items');
  const removable = await ok<ShoppingListDto>(`${secondaryPath}/items`, 'POST', {
    version: cleared.list.version,
    ingredientName: `${prefix}-remove`,
    quantity: 1,
    unit: 'PIECE',
  });
  await ok(`/shopping-list-items/${removable.items[0]!.id}?version=${removable.version}`, 'DELETE');
  const replenished = await ok<ShoppingListDto | { list: ShoppingListDto }>(
    `${shopPath}/replenish-recipe`,
    'POST',
    {
      version: list.version,
      recipeId: recipe.id,
      items: [{ ingredientName: `${prefix}-rice`, quantity: 100, unit: 'GRAM' }],
    },
  );
  list = 'list' in replenished ? replenished.list : replenished;
  const item = list.items.find(
    (value: { ingredientName: string }) => value.ingredientName === `${prefix}-rice`,
  );
  check(item && !item.completed, 'Recipe shortage is present');
  list = await ok<ShoppingListDto>(`/shopping-list-items/${item.id}`, 'PUT', {
    version: list.version,
    completed: true,
  });
  check(
    (await ok<{ items: IngredientDto[] }>('/ingredients?pageSize=100')).items.every(
      (row) => row.name !== `${prefix}-rice`,
    ),
    'Checking an item does not stock the pantry',
  );
  const operationId = crypto.randomUUID();
  const checkin = await ok<{ imported: { operationId: string } }>(`${shopPath}/check-in`, 'POST', {
    version: list.version,
    operationId,
    itemIds: [item.id],
  });
  check(checkin.imported.operationId === operationId, 'Shopping check-in commits');
  const shoppingIngredient = (
    await ok<{ items: IngredientDto[] }>('/ingredients?pageSize=100')
  ).items.find((value) => value.name === `${prefix}-rice`);
  check(shoppingIngredient?.quantity === 100, 'Shopping check-in stocks pantry');

  const pin = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 900000));
  const settings = await ok<Settings>('/settings', 'PUT', {
    version: initialSettings.version,
    userNickname: `${prefix}-private`,
  });
  await ok('/settings/pin', 'PUT', { version: settings.version, enabled: true, pin });
  check(
    (await fetch(asset.url, { cache: 'no-store' })).status === 401,
    'PIN locks native image access',
  );
  session.token = (await ok<{ token: string }>('/settings/pin/verify', 'POST', { pin })).token;
  check((await imageDimensions(asset.url))[1] === 960, 'Verified PIN unlocks native image access');
  const dashboard = await ok<DashboardDto>('/dashboard');
  check(dashboard.userNickname === `${prefix}-private`, 'Overview reads local nickname');
  const statistics = await ok<StatisticsDto>(`/statistics?start=${date}&end=${date}`);
  check(
    (statistics.calorieTrend[0]?.calories ?? 0) >= 300,
    'Statistics include the confirmed cook check-in',
  );
  const backup = await fetch('/api/v1/backups/export', {
    headers: { 'x-app-pin-token': session.token },
  });
  check(backup.ok, `Backup export ${backup.status}`);
  track('GET', '/backups/export', backup);
  const zip = await backup.blob();
  const zipBytes = new Uint8Array(await zip.arrayBuffer());
  let archive = '';
  for (let offset = 0; offset < zipBytes.length; offset += 8192)
    archive += String.fromCharCode(...zipBytes.subarray(offset, offset + 8192));
  const modified = await ok<Settings>('/settings', 'PUT', {
    version: settings.version,
    userNickname: `${prefix}-after-export`,
    subtitle: `${prefix}-discarded`,
  });
  check(modified.version > settings.version, 'Shared data changed after export');
  const oldNow = Date.now;
  Date.now = () => oldNow() + 12 * 60 * 60 * 1000 + 1;
  try {
    check((await call('/settings/pin/session')).status === 401, 'PIN session expires');
  } finally {
    Date.now = oldNow;
  }
  check(
    (await fetch(asset.url, { cache: 'no-store' })).status === 401,
    'Expired session re-locks native image access',
  );
  const grant = await ok<{ token: string }>('/settings/high-risk/authorize', 'POST', {
    action: 'RESTORE',
    pin,
  });
  const missing = retained.filter(
    ({ method, path }) => path !== '/api/v1/backups/restore' && !exercised.has(`${method} ${path}`),
  );
  check(
    missing.length === 0,
    `Routes without a successful response: ${missing.map(({ method, path }) => `${method} ${path}`).join(', ')}`,
  );
  return {
    archive: btoa(archive),
    ids: {
      plan: plan.id,
      draft: revived.record.id,
      record: cooked.record.id,
      ingredient: shoppingIngredient.id,
      operationId,
    },
    asset,
    pin,
    grant: grant.token,
    dimensions: { main, thumb },
    successfulRoutes: exercised.size,
  };
}

interface BusinessResult {
  archive: string;
  ids: { plan: string; draft: string; record: string; ingredient: string; operationId: string };
  asset: { url: string; thumbnailUrl: string; width: number; height: number };
  pin: string;
  grant: string;
  dimensions: { main: number[]; thumb: number[] };
  successfulRoutes: number;
}

async function finishRestore(input: BusinessResult, prefix: string) {
  function check(condition: unknown, label: string): asserts condition {
    if (!condition) throw new Error(label);
  }
  const archive = new Uint8Array(Array.from(atob(input.archive), (char) => char.charCodeAt(0)));
  const form = new FormData();
  form.append('file', new Blob([archive], { type: 'application/zip' }), 'dafan-offline-smoke.zip');
  const options = { method: 'POST', headers: { 'X-High-Risk-Token': input.grant }, body: form };
  const restore = await fetch('/api/v1/backups/restore', options);
  check(restore.ok, `Restore with expired PIN session: ${restore.status} ${await restore.text()}`);
  const replay = await fetch('/api/v1/backups/restore', options);
  check(replay.status === 401, 'One-time restore authorization cannot be reused');
  check(
    (await fetch(input.asset.url, { cache: 'no-store' })).status === 401,
    'Restore keeps native uploads locked',
  );
  const settings = (await (await fetch('/api/v1/settings')).json()).data;
  check(
    settings.pinEnabled &&
      settings.userNickname === `${prefix}-after-export` &&
      settings.subtitle !== `${prefix}-discarded`,
    'Restore preserves local account/PIN and rolls back shared data',
  );
  const verified = await fetch('/api/v1/settings/pin/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: input.pin }),
  });
  const valid = (await verified.json()).data;
  check(
    verified.ok && valid.valid === true && !!valid.token,
    'Original PIN re-unlocks after restore',
  );
  check(
    (await fetch(input.asset.url, { cache: 'no-store' })).status === 200,
    'Restored image can be read after PIN verification',
  );
  const disabled = await fetch('/api/v1/settings/pin', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-app-pin-token': valid.token },
    body: JSON.stringify({ version: settings.version, enabled: false, pin: null }),
  });
  check(disabled.ok, 'Remove the isolated smoke PIN');
  return true;
}

async function evaluate<T>(debuggerUrl: string, expression: string): Promise<T> {
  const socket = new WebSocket(debuggerUrl);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Android smoke timeout'));
    }, 150_000);
    socket.addEventListener(
      'open',
      () =>
        socket.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        ),
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('WebView connection failed'));
      },
      { once: true },
    );
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      const error =
        message.error?.message ?? message.result?.exceptionDetails?.exception?.description;
      if (error) reject(new Error(error));
      else resolve(message.result.result.value as T);
    });
  });
}

assert.deepEqual(
  [
    adb('shell', 'cmd', 'connectivity', 'airplane-mode'),
    adb('shell', 'settings', 'get', 'global', 'wifi_on'),
    adb('shell', 'settings', 'get', 'global', 'mobile_data'),
  ],
  ['enabled', '0', '0'],
  'Pure airplane mode',
);
const linuxUser = `u${user}_`;
const processLine = adb('shell', 'ps', '-A', '-o', 'USER,PID,NAME')
  .split(/\r?\n/)
  .map((line) => line.trim().split(/\s+/))
  .find(([owner, , name]) => owner?.startsWith(linuxUser) && name === appId);
const pid = processLine?.[1];
assert.ok(pid && /^\d+$/.test(pid), `Launch debug APK for emulator user ${user}`);
adb('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);
try {
  const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
    response.json(),
  )) as Array<{ url: string; webSocketDebuggerUrl: string }>;
  const target = targets.find((page) => page.url === 'https://localhost/');
  assert.ok(target, 'Packaged WebView is open');
  assert.equal(
    await evaluate<boolean>(
      target.webSocketDebuggerUrl,
      `(async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await fetch('/api/v1/health');
      if (response.ok && response.headers.get('content-type')?.includes('application/json')) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  })()`,
    ),
    true,
    'WebView local API is ready',
  );
  const prefix = `T004-${randomUUID().slice(0, 8)}`;
  const result = await evaluate<BusinessResult>(
    target.webSocketDebuggerUrl,
    `(${runBusiness.toString()})(${JSON.stringify(prefix)},${JSON.stringify(RETAINED_ENDPOINTS)})`,
  );
  const ids = result.ids;
  const rows = sqlite<{ commandType: string; payloadJson: string; payloadHash: string }>(
    "SELECT commandType,payloadJson,payloadHash FROM sync_outbox WHERE kind = 'command' ORDER BY rowid",
  );
  const names = rows.map((row) => row.commandType);
  assert.deepEqual(names.slice(-6), [
    'PLAN_COMPLETE',
    'PLAN_UNCOMPLETE',
    'PLAN_COMPLETE',
    'RECORD_DELETE',
    'RECIPE_COOK_CHECKIN',
    'SHOPPING_CHECKIN',
  ]);
  for (const row of rows.slice(-6)) {
    assert.equal(createHash('sha256').update(row.payloadJson).digest('hex'), row.payloadHash);
    assert.ok(Number.isFinite(Date.parse(JSON.parse(row.payloadJson).executedAt)));
  }
  for (const id of Object.values(ids)) assert.match(id, /^[\da-f-]+$/i);
  assert.deepEqual(sqlite(`SELECT status FROM MealPlan WHERE id = '${ids.plan}'`), [
    { status: 'PLANNED' },
  ]);
  assert.deepEqual(
    sqlite(`SELECT sourceMealPlanId,planUncompleteProof FROM MealRecord WHERE id = '${ids.draft}'`),
    [{ sourceMealPlanId: null, planUncompleteProof: null }],
  );
  assert.deepEqual(sqlite(`SELECT status FROM MealRecord WHERE id = '${ids.record}'`), [
    { status: 'CONFIRMED' },
  ]);
  assert.deepEqual(sqlite(`SELECT quantity FROM Ingredient WHERE id = '${ids.ingredient}'`), [
    { quantity: 100 },
  ]);
  assert.deepEqual(
    sqlite(
      `SELECT COUNT(*) AS count FROM ShoppingCheckinOperation WHERE id = '${ids.operationId}'`,
    ),
    [{ count: 1 }],
  );
  const zip = Buffer.from(result.archive, 'base64');
  const archiveFiles = unzipSync(zip);
  for (const value of [zip, ...Object.values(archiveFiles)]) {
    for (const privateName of [
      'device_local_config',
      'sync_outbox',
      'sync_state',
      'pinHash',
      'memberToken',
      'userNickname',
      `${prefix}-private`,
    ]) {
      assert.equal(
        Buffer.from(value).includes(privateName),
        false,
        `Private content excluded: ${privateName}`,
      );
    }
  }
  const businessEntry = Object.keys(archiveFiles).find(
    (name) => name.endsWith('.json') && name !== 'manifest.json',
  );
  if (
    businessEntry &&
    Object.keys(archiveFiles).filter((name) => name.endsWith('.json')).length === 2
  ) {
    const snapshot = JSON.parse(strFromU8(archiveFiles[businessEntry]!));
    assert.deepEqual(Object.keys(snapshot.tables ?? snapshot).sort(), [...RETAINED_MODELS].sort());
  } else {
    assert.equal(
      Object.keys(archiveFiles).filter((name) => name.endsWith('.json') && name !== 'manifest.json')
        .length,
      RETAINED_MODELS.length,
    );
  }
  for (const path of [result.asset.url, result.asset.thumbnailUrl]) {
    assert.match(path, /^\/uploads\/[a-z\d_.-]+\.webp$/i);
    assert.ok(archiveFiles[path.slice(1)]?.length);
    assert.ok(Number(appShell(`stat -c %s 'files${path}'`)) > 0);
  }
  assert.equal(
    await evaluate<boolean>(
      target.webSocketDebuggerUrl,
      `(${finishRestore.toString()})(${JSON.stringify(result)},${JSON.stringify(prefix)})`,
    ),
    true,
  );
  assert.deepEqual(sqlite('PRAGMA foreign_key_check'), []);
  assert.deepEqual(sqlite('SELECT COUNT(*) AS count FROM sync_outbox'), [{ count: 0 }]);
  assert.deepEqual(sqlite(`SELECT status FROM MealRecord WHERE id = '${ids.record}'`), [
    { status: 'CONFIRMED' },
  ]);
  console.log(
    JSON.stringify(
      {
        airplaneMode: true,
        wifi: false,
        mobileData: false,
        user,
        checks: [
          'plan-complete-uncomplete-revive-delete',
          'cook-checkin-replay-conflict',
          'shopping-replenish-checkin',
          'pin-image-gate-expiry',
          'private-zip-binary-scan',
          'restore-relock-and-unlock',
          'native-sqlite-primary-keys-fk-outbox',
        ],
        exif: result.dimensions,
        syncCommands: names.slice(-6),
        businessTables: RETAINED_MODELS.length,
        successfulRoutes: result.successfulRoutes + 1,
      },
      null,
      2,
    ),
  );
} finally {
  adb('forward', '--remove', `tcp:${port}`);
}
