import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../src/db/database.js';
import { registerDomainRoutes } from '../src/local-api/domains.js';
import { createLocalApiRouter } from '../src/local-api/router.js';
import { createSettingsService } from '../src/modules/settings/service.js';
import { createMemoryAppSecurity } from '../src/native/app-security.js';
import { createPinSession } from '../src/native/pin-session.js';
import { createNodeSqliteDriver } from './helpers/node-sqlite-driver.js';

let elapsed: number;
const now = () => new Date(new Date(2026, 10, 21, 9).getTime() + elapsed);
let db: DatabaseHandle;
let router: ReturnType<typeof createLocalApiRouter>;
let settings: ReturnType<typeof createSettingsService>;
let security: ReturnType<typeof createMemoryAppSecurity>;

beforeEach(async () => {
  elapsed = 0;
  db = await openDatabase({ driver: createNodeSqliteDriver({ path: ':memory:' }), now });
  const millis = () => now().getTime();
  security = createMemoryAppSecurity(millis);
  const session = createPinSession(security, millis);
  settings = createSettingsService(async () => db, session, now);
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

async function request(path: string, method = 'GET', body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['x-app-pin-token'] = token;
  const response = await router.handle(
    new Request(`https://localhost/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    retry: response.headers.get('retry-after'),
    ...(await response.json()),
  };
}

it('共享设置只在共享字段变化时推进版本并入队，本机字段和 PIN 在同版本独立提交', async () => {
  expect(await request('/settings')).toMatchObject({ data: { version: 1, pinEnabled: false } });
  expect(
    await request('/settings', 'PUT', {
      version: 1,
      userNickname: '测试昵称',
      onboardingCompleted: true,
    }),
  ).toMatchObject({ data: { version: 1, userNickname: '测试昵称', onboardingCompleted: true } });
  expect(await db.query('SELECT * FROM "sync_outbox"')).toEqual([]);
  expect(
    await request('/settings', 'PUT', {
      version: 1,
      appName: '离线小馆',
      defaultPort: 9090,
      userAvatarPath: '/uploads/local.webp',
    }),
  ).toMatchObject({ data: { version: 2, defaultPort: 9090 } });
  expect(await request('/settings', 'PUT', { version: 1, userNickname: '过期写入' })).toMatchObject(
    { status: 409 },
  );
  expect(
    await request('/settings/pin', 'PUT', { version: 1, enabled: true, pin: '4582' }),
  ).toMatchObject({ status: 409 });
  const enabled = await request('/settings/pin', 'PUT', { version: 2, enabled: true, pin: '4582' });
  expect(enabled).toMatchObject({ data: { version: 2, pinEnabled: true } });
  expect(enabled.data).not.toHaveProperty('pinHash');
  expect(await security.getGateState()).toMatchObject({ pinRequired: true, pinUnlocked: false });
  const queued = await db.query<{ payloadJson: string }>('SELECT "payloadJson" FROM "sync_outbox"');
  expect(queued).toHaveLength(1);
  expect(JSON.parse(queued[0]!.payloadJson)).toEqual({
    id: 1,
    version: 2,
    appName: '离线小馆',
    defaultPort: 9090,
    subtitle: '让每一餐都更美好',
    autoBackupEnabled: true,
    autoDeductInventory: false,
    defaultRepeatDays: 0,
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
  });
});

it('验证和恢复授权共用锁，过期会话下可发一次性恢复授权，恢复锁定后可重解锁', async () => {
  expect(
    (await request('/settings/pin', 'PUT', { version: 1, enabled: true, pin: '4582' })).status,
  ).toBe(200);
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt % 2) {
      expect(
        await request('/settings/high-risk/authorize', 'POST', { action: 'RESTORE', pin: '0911' }),
      ).toMatchObject({ status: 401 });
    } else {
      expect(await request('/settings/pin/verify', 'POST', { pin: '0911' })).toMatchObject({
        data: { valid: false },
      });
    }
  }
  for (const path of ['/settings/pin/verify', '/settings/high-risk/authorize']) {
    expect(await request(path, 'POST', { action: 'RESTORE', pin: '4582' })).toMatchObject({
      status: 429,
      retry: '30',
      error: { code: 'PIN_ATTEMPTS_EXCEEDED' },
    });
  }
  elapsed += 30_001;
  const verified = await request('/settings/pin/verify', 'POST', { pin: '4582' });
  expect(verified).toMatchObject({
    status: 200,
    data: { valid: true, required: true, token: expect.any(String) },
  });
  expect(await security.getGateState()).toMatchObject({ pinRequired: true, pinUnlocked: true });
  expect(
    await request('/settings/pin/session', 'GET', undefined, verified.data.token),
  ).toMatchObject({ status: 200 });
  elapsed += 12 * 60 * 60 * 1000;
  expect(await security.getGateState()).toMatchObject({ pinRequired: true, pinUnlocked: false });
  expect(
    await request('/settings/pin/session', 'GET', undefined, verified.data.token),
  ).toMatchObject({ status: 401 });
  const authorization = await request('/settings/high-risk/authorize', 'POST', {
    action: 'RESTORE',
    pin: '4582',
  });
  expect(authorization).toMatchObject({ status: 200, data: { token: expect.any(String) } });
  settings.consumeHighRiskToken(authorization.data.token);
  expect(() => settings.consumeHighRiskToken(authorization.data.token)).toThrow();
  await settings.lockPin();
  expect(await request('/settings/pin/verify', 'POST', { pin: '4582' })).toMatchObject({
    status: 200,
    data: { valid: true },
  });
});

it('无 PIN 恢复授权需要与一次性 challenge 匹配的明确确认', async () => {
  const challenge = (await request('/settings/high-risk/authorize', 'POST', { action: 'RESTORE' }))
    .data.challenge;
  expect(
    await request('/settings/high-risk/authorize', 'POST', {
      action: 'RESTORE',
      challenge,
      confirmation: 'RESTORE_LOCAL_DATA',
    }),
  ).toMatchObject({ status: 200, data: { token: expect.any(String) } });
  expect(
    await request('/settings/high-risk/authorize', 'POST', {
      action: 'RESTORE',
      challenge,
      confirmation: 'RESTORE_LOCAL_DATA',
    }),
  ).toMatchObject({ status: 401 });
});

it('转盘只返回符合筛选条件的真实结果，读取无需退役表或数据库写入', async () => {
  await request('/recipes', 'POST', { name: '花生饭', category: '主食', mealTypes: ['DINNER'] });
  const safe = (
    await request('/recipes', 'POST', { name: '清蒸鱼', category: '荤菜', mealTypes: ['DINNER'] })
  ).data;
  const diner = (await request('/diners', 'POST', { name: '食用者', allergyText: '花生' })).data;
  const store = (
    await request('/stores', 'POST', {
      name: '外卖店',
      supportsTakeout: true,
      supportsDineIn: false,
    })
  ).data;
  const before = await db.query('SELECT * FROM "sync_outbox" ORDER BY rowid');
  expect(
    await request('/recommendations/random', 'POST', {
      sourceTypes: ['RECIPE'],
      mealType: 'DINNER',
      dinerIds: [diner.id],
    }),
  ).toMatchObject({
    status: 200,
    data: {
      type: 'SINGLE',
      candidateCount: 1,
      results: [{ resultType: 'RECIPE', resultId: safe.id }],
    },
  });
  expect(
    await request('/recommendations/random', 'POST', {
      sourceTypes: ['STORE'],
      acquisitionModes: ['TAKEOUT'],
    }),
  ).toMatchObject({ data: { results: [{ resultType: 'STORE', resultId: store.id }] } });
  expect(
    await request('/recommendations/random', 'POST', {
      sourceTypes: ['STORE'],
      acquisitionModes: ['DINE_IN'],
    }),
  ).toMatchObject({ data: { candidateCount: 0, results: [] } });
  expect(await db.query('SELECT * FROM "sync_outbox" ORDER BY rowid')).toEqual(before);
});

it('首页读取本机昵称、菜谱分类和实测连续记录，统计保留真零、空日与双有价字段', async () => {
  await request('/settings', 'PUT', { version: 1, userNickname: '早班', appName: '离线小馆' });
  await request('/recipes', 'POST', { name: '清蒸鱼', category: '荤菜' });
  await db.withWriteTransaction(async (tx) => {
    for (const row of [
      ['a', '2026-11-20', 'LUNCH', 'TAKEOUT', 'CONFIRMED', 0, 0, 3],
      ['b', '2026-11-20', 'DINNER', 'TAKEOUT', 'CONFIRMED', null, null, 5],
      ['c', '2026-11-21', 'BREAKFAST', 'DINE_IN', 'CONFIRMED', null, 24, 7],
      ['d', '2026-11-19', 'LUNCH', 'HOMEMADE', 'CONFIRMED', null, null, 8],
      ['e', '2026-11-21', 'LUNCH', 'DINE_IN', 'DRAFT', 100, 98, 10],
    ] as const) {
      await tx.run(
        'INSERT INTO "MealRecord" (id, recordDate, mealType, sourceType, status, calories, cost, satiety, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [...row, now().toISOString()],
      );
    }
  });
  expect(await request('/dashboard')).toMatchObject({
    data: {
      branding: { appName: '离线小馆' },
      userNickname: '早班',
      greetingTitle: '早上好，早班',
      recommendedRecipes: [{ name: '清蒸鱼', category: '荤菜' }],
      weeklyStats: { recordedDays: 3, streakDays: 3, totalMeals: 4 },
    },
  });
  const response = await request('/statistics?start=2026-11-19&end=2026-11-22');
  expect(response).toMatchObject({
    status: 200,
    data: {
      totalRecords: 4,
      costSummary: {
        takeoutCost: 0,
        takeoutRecordCount: 2,
        takeoutPricedCount: 1,
        takeoutPricedRecordCount: 1,
        dineInCost: 24,
        dineInPricedCount: 1,
        dineInPricedRecordCount: 1,
      },
      satietySummary: {
        distribution: [
          { satiety: 3, count: 1 },
          { satiety: 5, count: 1 },
          { satiety: 7, count: 1 },
          { satiety: 8, count: 1 },
          { satiety: 10, count: 0 },
        ],
        comfortablePercent: 50,
      },
    },
  });
  expect(
    response.data.calorieTrend.map((row: { calories: number | null }) => row.calories),
  ).toEqual([null, 0, null, null]);
  expect(await request('/statistics?start=2026-02-29')).toMatchObject({ status: 400 });
});
