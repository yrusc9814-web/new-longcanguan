import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../src/db/database.js';
import { registerDomainRoutes } from '../src/local-api/domains.js';
import { createLocalApiRouter } from '../src/local-api/router.js';
import { createSettingsService } from '../src/modules/settings/service.js';
import { createMemoryAppSecurity } from '../src/native/app-security.js';
import { createPinSession } from '../src/native/pin-session.js';
import { createNodeSqliteDriver } from './helpers/node-sqlite-driver.js';

const now = () => new Date(2026, 10, 21, 9);
let db: DatabaseHandle;
let router: ReturnType<typeof createLocalApiRouter>;

beforeEach(async () => {
  db = await openDatabase({ driver: createNodeSqliteDriver({ path: ':memory:' }), now });
  const millis = () => now().getTime();
  const security = createMemoryAppSecurity(millis);
  const session = createPinSession(security, millis);
  const settings = createSettingsService(async () => db, session, now);
  await settings.initialize();
  router = createLocalApiRouter({
    now,
    isPinTokenValid: session.isValid,
    async readGateState() {
      const state = await security.getGateState();
      return { pinRequired: state.pinRequired, pendingWipe: state.lockedPendingWipe };
    },
  });
  registerDomainRoutes(router, async () => db, settings);
});

afterEach(async () => db.close());

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await router.handle(
    new Request(`https://localhost/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, ...(await response.json()) };
}

interface RandomResult {
  type: string;
  candidateCount: number;
  results: Array<{ resultId: string; title: string; score: number }>;
}

async function random(body: Record<string, unknown>): Promise<RandomResult> {
  const response = await request('/recommendations/random', 'POST', {
    sourceTypes: ['RECIPE'],
    ...body,
  });
  expect(response).toMatchObject({ status: 200 });
  return response.data as RandomResult;
}

async function createRecipe(name: string, toolIds?: unknown[]) {
  const response = await request('/recipes', 'POST', { name, ...(toolIds ? { toolIds } : {}) });
  expect(response).toMatchObject({ status: 201 });
  return (response.data as { id: string }).id;
}

async function createTool(name: string, extra: Record<string, unknown> = {}) {
  const response = await request('/tools', 'POST', { name, ...extra });
  expect(response).toMatchObject({ status: 201 });
  return (response.data as { id: string }).id;
}

async function recordMeal(recipeId: string, recordDate: string) {
  await db.withWriteTransaction(async (tx) => {
    const recordId = `record-${recordDate}`;
    await tx.run(
      'INSERT INTO "MealRecord" (id, recordDate, mealType, sourceType, status, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
      [recordId, recordDate, 'DINNER', 'HOMEMADE', 'CONFIRMED', now().toISOString()],
    );
    await tx.run(
      'INSERT INTO "MealRecordItem" (id, mealRecordId, itemType, recipeId, sortOrder, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
      [`item-${recordDate}`, recordId, 'RECIPE', recipeId, 0, now().toISOString()],
    );
  });
}

it('repeatDays 为 0 或默认设置时当日记录不扣分，正窗口命中当日记录扣 40 分', async () => {
  const recipeId = await createRecipe('清蒸鱼');
  await recordMeal(recipeId, '2026-11-21');

  // 无配料、非收藏、库存无需核对：基础分 25；若误判「近期已吃」则为 -15。
  const unlimited = await random({ repeatDays: 0 });
  expect(unlimited.candidateCount).toBe(1);
  expect(unlimited.results[0]).toMatchObject({ resultId: recipeId, score: 25 });

  // Settings.defaultRepeatDays 默认 0，同样不得扣分。
  const defaulted = await random({});
  expect(defaulted.results[0]).toMatchObject({ resultId: recipeId, score: 25 });

  // repeatDays = 1 覆盖当日记录，确认扣分确实生效。
  const windowed = await random({ repeatDays: 1 });
  expect(windowed.candidateCount).toBe(1);
  expect(windowed.results[0]).toMatchObject({ resultId: recipeId, score: -15 });
});

it('必选厨具 BROKEN/MISSING/UNAVAILABLE 忽略大小写拦截，非必选不误拦', async () => {
  const broken = await createTool('炒锅', { status: 'broken' });
  const missing = await createTool('蒸锅', { status: 'Missing' });
  const unavailable = await createTool('烤箱', { status: 'UNAVAILABLE' });
  const available = await createTool('电饭锅', { status: 'AVAILABLE' });
  const empty = await createTool('砂锅', { quantity: 0 });

  const brokenRecipe = await createRecipe('炒锅菜', [
    { toolId: broken, name: '炒锅', required: true },
  ]);
  const missingRecipe = await createRecipe('蒸锅菜', [
    { toolId: missing, name: '蒸锅', required: true },
  ]);
  const unavailableRecipe = await createRecipe('烤箱菜', [
    { toolId: unavailable, name: '烤箱', required: true },
  ]);
  const emptyRecipe = await createRecipe('砂锅菜', [
    { toolId: empty, name: '砂锅', required: true },
  ]);
  const okRecipe = await createRecipe('正常菜', [
    { toolId: available, name: '电饭锅', required: true },
  ]);
  const optionalRecipe = await createRecipe('非必选菜', [
    { toolId: broken, name: '炒锅', required: false },
  ]);

  const spy = vi.spyOn(Math, 'random');
  spy.mockReturnValue(0);
  const first = (await random({ repeatDays: 0 })).results[0]!.resultId;
  spy.mockReturnValue(0.999999);
  const last = (await random({ repeatDays: 0 })).results[0]!.resultId;
  spy.mockRestore();

  // 只有「厨具可用」与「非必选厨具损坏」两个菜谱通过拦截。
  expect(new Set([first, last])).toEqual(new Set([okRecipe, optionalRecipe]));
  for (const blocked of [brokenRecipe, missingRecipe, unavailableRecipe, emptyRecipe]) {
    expect([first, last]).not.toContain(blocked);
  }
});

it('全部候选的必选厨具不可用时返回空结果', async () => {
  const broken = await createTool('炒锅', { status: 'bRoKeN' });
  await createRecipe('炒锅菜', [{ toolId: broken, name: '炒锅', required: true }]);
  expect(await random({ repeatDays: 0 })).toEqual({
    type: 'SINGLE',
    candidateCount: 0,
    results: [],
  });
});
