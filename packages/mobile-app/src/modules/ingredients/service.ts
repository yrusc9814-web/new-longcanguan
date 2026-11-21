/**
 * 食材服务的离线实现（对齐上游 `app/server/src/modules/ingredients/service.ts`）。
 *
 * 与上游的差异只来自端侧基础设施：
 * - Prisma 事务 → `DatabaseClient.withWriteTransaction`；
 * - 主键 → 本地 32 位十六进制随机串；
 * - 业务写与发件箱同事务：每次业务操作只入队一条同步操作（命令或 upsert/delete）；
 * - 已剔除 `DeletedItem` / `ConsumptionOperation` 表，删除只做软删 + 批次软删。
 */
import type { DatabaseClient, WriteTransaction } from '../../db/database.js';
import { VersionConflictError } from '../../db/errors.js';
import type { QuantityUnit } from '@dafan/shared/types';

import { LocalApiError } from '../../local-api/protocol.js';
import { pageOptions, paginated, validationError } from '../common.js';
import { convertQuantity } from '../units.js';
import {
  ACTIVE_BATCH_ORDER,
  insertLog,
  loadBatches,
  newBatchId,
  persistImplicitBatch,
  replaceBatches,
  summarizeBatchMeta,
  summarizeQuantity,
  synchronizeBatches,
} from './batches.js';
import { normalizeIngredientCategory } from './categories.js';
import {
  ingredientStatus,
  toIngredientDto,
  type BatchRow,
  type IngredientDto,
  type IngredientRow,
} from './dto.js';
import {
  assertInput,
  conflict,
  findIngredient,
  listActiveBatchesFor,
  notFound,
  optionalBoolean,
  optionalNumber,
  optionalText,
  parseBatches,
  parseUnit,
  sumBatches,
  type IngredientWriteInput,
} from './input.js';
import { roundQuantity } from './numbers.js';

export interface ConsumeInput {
  readonly mode: 'QUANTITY' | 'ALL';
  readonly quantity?: number;
  readonly unit?: QuantityUnit;
  readonly ingredientVersion: number;
  readonly notes?: string | null;
}

export interface ConsumptionAllocation {
  readonly batchId: string;
  readonly batchVersion: number;
  readonly beforeQuantity: number;
  readonly afterQuantity: number;
  readonly unit: QuantityUnit;
  readonly changeQuantity: number;
}

export interface ListQuery {
  readonly search?: string;
  readonly category?: string;
  readonly status?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface IngredientServiceContext {
  readonly database: DatabaseClient;
  readonly now: () => Date;
}

function isAllCategory(value: string | null | undefined): boolean {
  const text = (value ?? '').trim();
  return !text || text === '全部' || text === 'ALL';
}

/** 发件箱 upsert 载荷：可重放的完整聚合（食材 + 活批次）。 */
export function ingredientUpsertPayload(ingredient: IngredientDto): Record<string, unknown> {
  return {
    id: ingredient.id,
    name: ingredient.name,
    imagePath: ingredient.imagePath,
    category: ingredient.category,
    quantity: ingredient.quantity,
    unit: ingredient.unit,
    purchaseDate: ingredient.purchaseDate,
    expiryDate: ingredient.expiryDate,
    location: ingredient.location,
    minStock: ingredient.minStock,
    maxStock: ingredient.maxStock,
    opened: ingredient.opened,
    notes: ingredient.notes,
    version: ingredient.version,
    deletedAt: ingredient.deletedAt,
    batches: ingredient.batches.map((batch) => ({
      id: batch.id,
      ingredientId: batch.ingredientId,
      quantity: batch.quantity,
      unit: batch.unit,
      purchaseDate: batch.purchaseDate,
      expiryDate: batch.expiryDate,
      location: batch.location,
      opened: batch.opened,
      consumePriority: batch.consumePriority,
      notes: batch.notes,
      version: batch.version,
      deletedAt: batch.deletedAt,
    })),
  };
}

async function readIngredientDto(
  client: DatabaseClient | WriteTransaction,
  row: IngredientRow,
  now: Date,
  withStatus: boolean,
): Promise<IngredientDto> {
  const batches = await client.query<BatchRow>(
    `SELECT * FROM "InventoryBatch" WHERE "ingredientId" = ? AND "deletedAt" IS NULL ORDER BY ${ACTIVE_BATCH_ORDER}`,
    [row.id],
  );
  return toIngredientDto(row, batches, withStatus ? ingredientStatus(row, now) : undefined);
}

async function readIngredientDtoById(
  client: DatabaseClient | WriteTransaction,
  id: string,
  now: Date,
  withStatus: boolean,
): Promise<IngredientDto> {
  const row = await findIngredient(client, id);
  if (!row) throw notFound();
  return readIngredientDto(client, row, now, withStatus);
}

export async function listIngredients(
  ctx: IngredientServiceContext,
  query: ListQuery = {},
): Promise<ReturnType<typeof paginated<IngredientDto>>> {
  const options = pageOptions(
    new URLSearchParams({
      ...(query.page != null ? { page: String(query.page) } : {}),
      ...(query.pageSize != null ? { pageSize: String(query.pageSize) } : {}),
    }),
  );
  const search = query.search?.trim() ?? '';
  const rows = await ctx.database.query<IngredientRow>(
    `SELECT * FROM "Ingredient" WHERE "deletedAt" IS NULL${search ? ' AND "name" LIKE ?' : ''} ORDER BY "updatedAt" DESC, "id" DESC`,
    search ? [`%${search}%`] : [],
  );
  const requestedCategory = isAllCategory(query.category)
    ? null
    : normalizeIngredientCategory(query.category, null);
  const now = ctx.now();
  // 归一化历史分类和状态后，仅读取当前页的批次。
  const filtered = rows.filter(
    (row) =>
      (!requestedCategory ||
        normalizeIngredientCategory(row.category, row.name) === requestedCategory) &&
      (!query.status || ingredientStatus(row, now) === query.status),
  );
  const page = filtered.slice(options.skip, options.skip + options.take);
  const batchMap = await listActiveBatchesFor(
    ctx.database,
    page.map((row) => row.id),
  );
  return paginated(
    page.map((row) => toIngredientDto(row, batchMap.get(row.id) ?? [])),
    filtered.length,
    options,
  );
}

export async function getIngredient(
  ctx: IngredientServiceContext,
  id: string,
): Promise<IngredientDto> {
  return readIngredientDtoById(ctx.database, id, ctx.now(), true);
}

export async function createIngredient(
  ctx: IngredientServiceContext,
  input: IngredientWriteInput,
): Promise<IngredientDto> {
  assertInput(input);
  const now = ctx.now();
  return ctx.database.withWriteTransaction(async (tx) => {
    const timestamp = now.toISOString();
    const id = newBatchId();
    const batches = input.batches ?? [];
    // 上游 createIngredient 只按显式批次汇总，忽略顶层 quantity（编辑语义专属）。
    const quantity = sumBatches(batches, input.unit);
    const first = batches[0];
    const name = input.name.trim();
    const category = normalizeIngredientCategory(input.category, input.name);
    await tx.run(
      `INSERT INTO "Ingredient"
        ("id", "name", "imagePath", "category", "quantity", "unit", "purchaseDate", "expiryDate", "location", "minStock", "maxStock", "opened", "notes", "version", "deletedAt", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      [
        id,
        name,
        input.imagePath ?? null,
        category,
        quantity,
        input.unit,
        first?.purchaseDate ?? null,
        first?.expiryDate ?? null,
        first?.location ?? null,
        input.minStock ?? null,
        input.maxStock ?? null,
        first?.opened ? 1 : 0,
        input.notes ?? null,
        timestamp,
        timestamp,
      ],
    );
    for (const batch of batches) {
      const batchId = newBatchId();
      await tx.run(
        `INSERT INTO "InventoryBatch"
          ("id", "ingredientId", "quantity", "unit", "purchaseDate", "expiryDate", "location", "opened", "consumePriority", "notes", "version", "deletedAt", "createdAt", "updatedAt")
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
        [
          batchId,
          id,
          batch.quantity,
          batch.unit,
          batch.purchaseDate ?? null,
          batch.expiryDate ?? null,
          batch.location ?? null,
          batch.opened ? 1 : 0,
          batch.consumePriority ? 1 : 0,
          batch.notes ?? null,
          timestamp,
          timestamp,
        ],
      );
      await insertLog(tx, {
        ingredientId: id,
        ingredientNameSnapshot: name,
        inventoryBatchId: batchId,
        beforeQuantity: 0,
        changeQuantity: batch.quantity,
        afterQuantity: batch.quantity,
        unit: batch.unit,
        changeType: 'PURCHASE',
        notes: batch.notes ?? null,
        now,
      });
    }
    const dto = await readIngredientDtoById(tx, id, now, true);
    await tx.enqueue({
      opId: newBatchId(),
      entity: 'Ingredient',
      entityId: id,
      kind: 'upsert',
      baseVersion: null,
      payload: ingredientUpsertPayload(dto),
    });
    return dto;
  });
}

/** 按顶层库存与元数据重平衡，或用显式批次替换并重新汇总。 */
export async function updateIngredient(
  ctx: IngredientServiceContext,
  id: string,
  version: number,
  input: IngredientWriteInput,
): Promise<IngredientDto> {
  assertInput(input);
  const now = ctx.now();
  return ctx.database.withWriteTransaction(async (tx) => {
    const current = await findIngredient(tx, id);
    if (!current) throw notFound();
    if (current.version !== version) {
      throw new VersionConflictError('Ingredient', id, version, current.version);
    }
    const timestamp = now.toISOString();
    const name = input.name.trim();
    const batches = await loadBatches(tx, id);
    const explicitBatches = input.batches;

    // 显式 batches：替换语义优先于「按数量同步」，旧批次软删保留日志外键。
    let replaced: { quantity: number; opened: boolean } | null = null;
    if (explicitBatches !== undefined) {
      replaced = await replaceBatches(tx, {
        ingredientId: id,
        ingredientName: name,
        baseUnit: input.unit,
        batches: explicitBatches,
        now,
      });
    }

    const converted = batches.map((batch) =>
      convertQuantity(batch.quantity, batch.unit, input.unit),
    );
    if (!replaced && converted.some((quantity) => quantity == null)) {
      throw new LocalApiError(409, 'CONFLICT', '现有库存批次无法换算为新的基础单位');
    }
    let batchTotal = roundQuantity(
      converted.reduce<number>((total, value) => total + (value ?? 0), 0),
    );

    // 无活批次但存量 > 0 的历史食材：先补建等效批次，后续编辑/汇总都走真实批次。
    if (
      !replaced &&
      !batches.some((batch) => batch.quantity > 0) &&
      batchTotal <= 0 &&
      current.quantity > 0
    ) {
      await persistImplicitBatch(
        tx,
        {
          ingredientId: id,
          name: current.name,
          quantity: current.quantity,
          unit: current.unit,
          purchaseDate: current.purchaseDate,
          expiryDate: current.expiryDate,
          location: current.location,
          opened: current.opened === 1 || current.opened === true,
        },
        batches,
        now,
      );
      batchTotal = roundQuantity(convertQuantity(current.quantity, current.unit, input.unit) ?? 0);
    }

    // 食材级编辑语义：显式 batches 以替换汇总为准；否则 quantity 显式提供时以用户输入为准。
    const targetQuantity = replaced
      ? replaced.quantity
      : input.quantity === undefined || input.quantity === null
        ? batchTotal
        : roundQuantity(input.quantity);

    const metaTouched =
      input.purchaseDate !== undefined ||
      input.expiryDate !== undefined ||
      input.location !== undefined ||
      input.opened !== undefined;

    if (!replaced) {
      await synchronizeBatches(tx, {
        ingredientId: id,
        ingredientName: name,
        baseUnit: input.unit,
        targetQuantity,
        meta: {
          purchaseDate: input.purchaseDate,
          expiryDate: input.expiryDate,
          location: input.location,
          opened: input.opened,
        },
        metaTouched,
        fallbackMeta: {
          purchaseDate: current.purchaseDate,
          expiryDate: current.expiryDate,
          location: current.location,
          opened: current.opened === 1 || current.opened === true,
        },
        now,
      });
    }

    const finalBatches = await loadBatches(tx, id);
    const summary = summarizeBatchMeta(finalBatches);
    const category = normalizeIngredientCategory(input.category ?? current.category, input.name);
    const purchaseDate =
      input.purchaseDate !== undefined
        ? input.purchaseDate
        : (summary.purchaseDate ?? (replaced ? null : current.purchaseDate));
    const expiryDate =
      input.expiryDate !== undefined
        ? input.expiryDate
        : (summary.expiryDate ?? (replaced ? null : current.expiryDate));
    const location =
      input.location !== undefined
        ? input.location
        : (summary.location ?? (replaced ? null : current.location));
    // 上游 PUT 不重算汇总 opened：只有显式 batches 替换时由新批次决定；
    // 其余情况 opened 只同步进批次，汇总值保持原样（除非调用方本来就显式改了批次）。
    const opened = replaced
      ? input.opened !== undefined
        ? input.opened
        : replaced.opened
      : current.opened === 1 || current.opened === true;

    const updated = await tx.run(
      `UPDATE "Ingredient" SET
         "name" = ?, "imagePath" = ?, "category" = ?, "unit" = ?, "quantity" = ?,
         "minStock" = ?, "maxStock" = ?, "notes" = ?,
         "purchaseDate" = ?, "expiryDate" = ?, "location" = ?, "opened" = ?,
         "version" = "version" + 1, "updatedAt" = ?
       WHERE "id" = ? AND "version" = ? AND "deletedAt" IS NULL`,
      [
        name,
        input.imagePath ?? null,
        category,
        input.unit,
        targetQuantity,
        input.minStock ?? null,
        input.maxStock ?? null,
        input.notes ?? null,
        purchaseDate,
        expiryDate,
        location,
        opened ? 1 : 0,
        timestamp,
        id,
        version,
      ],
    );
    if (updated.changes !== 1) {
      const [latest] = await tx.query<{ version: number; deletedAt: string | null }>(
        `SELECT "version", "deletedAt" FROM "Ingredient" WHERE "id" = ?`,
        [id],
      );
      if (!latest || latest.deletedAt) throw notFound();
      throw new VersionConflictError('Ingredient', id, version, latest.version);
    }

    const dto = await readIngredientDtoById(tx, id, now, true);
    // 顶层数量/批次元数据已通过 synchronizeBatches 改写批次：命令保留标准化请求供服务端重放。
    await tx.enqueue({
      opId: newBatchId(),
      entity: 'Ingredient',
      entityId: id,
      kind: 'command',
      commandType: 'INGREDIENT_UPDATE_SYNC_BATCHES',
      baseVersion: version,
      payload: {
        id,
        baseVersion: version,
        request: {
          ...input,
          name,
          imagePath: input.imagePath ?? null,
          category,
          minStock: input.minStock ?? null,
          maxStock: input.maxStock ?? null,
          notes: input.notes ?? null,
        },
      },
    });
    return dto;
  });
}

export async function deleteIngredient(
  ctx: IngredientServiceContext,
  id: string,
  version: number,
): Promise<{ id: string; deleted: true }> {
  const now = ctx.now();
  return ctx.database.withWriteTransaction(async (tx) => {
    const timestamp = now.toISOString();
    const result = await tx.run(
      `UPDATE "Ingredient" SET "deletedAt" = ?, "version" = "version" + 1, "updatedAt" = ?
       WHERE "id" = ? AND "version" = ? AND "deletedAt" IS NULL`,
      [timestamp, timestamp, id, version],
    );
    if (result.changes !== 1) {
      const [current] = await tx.query<{ version: number; deletedAt: string | null }>(
        `SELECT "version", "deletedAt" FROM "Ingredient" WHERE "id" = ?`,
        [id],
      );
      if (!current || current.deletedAt) throw notFound();
      throw new VersionConflictError('Ingredient', id, version, current.version);
    }
    await tx.run(
      `UPDATE "InventoryBatch" SET "deletedAt" = ?, "version" = "version" + 1, "updatedAt" = ?
       WHERE "ingredientId" = ? AND "deletedAt" IS NULL`,
      [timestamp, timestamp, id],
    );
    await tx.enqueue({
      opId: newBatchId(),
      entity: 'Ingredient',
      entityId: id,
      kind: 'delete',
      baseVersion: version,
      payload: { id, version, deletedAt: timestamp },
    });
    return { id, deleted: true };
  });
}

/**
 * 聚合食材级消耗：库存详情页固定按钮「消耗 100g / 消耗 250g / 全部用完」的真实语义。
 *
 * - 批次顺序由服务端确定（consumePriority desc → expiryDate asc → createdAt asc → id asc）。
 * - QUANTITY：只从单位可换算到请求单位的活批次按序扣减；不可换算的活批次原样保留并在响应
 *   incompatibleBatchIds 中标出；兼容批次可用量不足 → 409，整单失败无部分扣减。
 * - ALL：把真实存在的全部活批次清零。
 * - 乐观锁：ingredient.version 与各批次 version 均作为条件更新谓词；任一冲突 → 409 整单回滚。
 * - 每个被扣批次写 InventoryLog（MANUAL_DEDUCT），同事务入队一条 INGREDIENT_CONSUME 命令。
 */
export async function consumeIngredient(
  ctx: IngredientServiceContext,
  ingredientId: string,
  input: ConsumeInput,
): Promise<{
  mode: 'QUANTITY' | 'ALL';
  consumedQuantity: number | null;
  consumedUnit: QuantityUnit;
  allocations: ConsumptionAllocation[];
  incompatibleBatchIds: string[];
  inventoryLogIds: string[];
  ingredient: IngredientDto;
}> {
  if (!Number.isInteger(input.ingredientVersion) || input.ingredientVersion < 1)
    throw validationError('ingredientVersion 必须是正整数');
  if (input.mode !== 'QUANTITY' && input.mode !== 'ALL')
    throw validationError('消耗模式必须是 QUANTITY 或 ALL');
  if (input.mode === 'ALL' && (input.quantity != null || input.unit != null))
    throw validationError('“全部用完”不接受数量或单位参数');
  if (input.mode === 'QUANTITY') {
    if (
      typeof input.quantity !== 'number' ||
      !Number.isFinite(input.quantity) ||
      input.quantity <= 0
    )
      throw validationError('消耗数量必须是大于 0 的有限数');
    if (!input.unit) throw validationError('按数量消耗必须提供单位');
  }

  const now = ctx.now();
  return ctx.database.withWriteTransaction(async (tx) => {
    const timestamp = now.toISOString();
    const ingredient = await findIngredient(tx, ingredientId);
    if (!ingredient) throw notFound();
    if (ingredient.version !== input.ingredientVersion) {
      throw new VersionConflictError(
        'Ingredient',
        ingredientId,
        input.ingredientVersion,
        ingredient.version,
      );
    }

    let batches = await loadBatches(tx, ingredientId, { positiveOnly: true });
    if (!batches.length) {
      // 历史存量：quantity > 0 但从未建过活批次。先按汇总补建等效批次再正常扣减，避免 409。
      const healed = await persistImplicitBatch(
        tx,
        {
          ingredientId,
          name: ingredient.name,
          quantity: ingredient.quantity,
          unit: ingredient.unit,
          purchaseDate: ingredient.purchaseDate,
          expiryDate: ingredient.expiryDate,
          location: ingredient.location,
          opened: ingredient.opened === 1 || ingredient.opened === true,
        },
        batches,
        now,
      );
      if (healed) batches = await loadBatches(tx, ingredientId, { positiveOnly: true });
    }
    if (!batches.length) throw conflict('库存数量不足，无法完成本次消耗');

    const planned: Array<{ batch: BatchRow; take: number }> = [];
    const incompatibleBatchIds: string[] = [];
    let consumedQuantity: number | null = null;

    if (input.mode === 'QUANTITY') {
      const unit = input.unit as QuantityUnit;
      const compatible = batches.filter((batch) => convertQuantity(1, batch.unit, unit) !== null);
      for (const batch of batches) {
        if (convertQuantity(1, batch.unit, unit) === null) incompatibleBatchIds.push(batch.id);
      }
      if (!compatible.length) throw conflict('库存单位不可换算，无法按该单位消耗');
      const available = compatible.reduce(
        (total, batch) => total + (convertQuantity(batch.quantity, batch.unit, unit) ?? 0),
        0,
      );
      if (roundQuantity(available) < roundQuantity(input.quantity as number))
        throw conflict('库存数量不足，无法完成本次消耗');
      let remaining = input.quantity as number;
      for (const batch of compatible) {
        if (remaining <= 0) break;
        const availableInUnit = convertQuantity(batch.quantity, batch.unit, unit) ?? 0;
        const takeInUnit = Math.min(remaining, availableInUnit);
        const takeInBatchUnit = roundQuantity(convertQuantity(takeInUnit, unit, batch.unit) ?? 0);
        const take = Math.min(takeInBatchUnit, batch.quantity);
        if (take > 0) planned.push({ batch, take });
        remaining = roundQuantity(remaining - takeInUnit);
      }
      // 数量与 consumedUnit 使用同一请求单位，避免 kg 库存按 g 消耗时返回缩小 1000 倍的数量。
      consumedQuantity = roundQuantity(
        planned.reduce(
          (total, { batch, take }) => total + (convertQuantity(take, batch.unit, unit) ?? 0),
          0,
        ),
      );
    } else {
      for (const batch of batches) planned.push({ batch, take: batch.quantity });
      const totalInIngredientUnit = planned.reduce((total, { batch, take }) => {
        const converted = convertQuantity(take, batch.unit, ingredient.unit);
        return total + (converted ?? Number.NaN);
      }, 0);
      consumedQuantity = Number.isFinite(totalInIngredientUnit)
        ? roundQuantity(totalInIngredientUnit)
        : null;
    }

    const allocations: ConsumptionAllocation[] = [];
    const inventoryLogIds: string[] = [];
    for (const { batch, take } of planned) {
      const after = roundQuantity(batch.quantity - take);
      if (after < 0) throw conflict('库存数量不足，无法完成本次消耗');
      const updatedRow = await tx.run(
        `UPDATE "InventoryBatch" SET "quantity" = ?, "version" = "version" + 1, "updatedAt" = ?
         WHERE "id" = ? AND "version" = ? AND "deletedAt" IS NULL AND "quantity" >= ?`,
        [after, timestamp, batch.id, batch.version, take],
      );
      if (updatedRow.changes !== 1) {
        throw new VersionConflictError(
          'InventoryBatch',
          batch.id,
          batch.version,
          batch.version + 1,
        );
      }
      const logId = await insertLog(tx, {
        ingredientId,
        ingredientNameSnapshot: ingredient.name,
        inventoryBatchId: batch.id,
        beforeQuantity: batch.quantity,
        changeQuantity: -take,
        afterQuantity: after,
        unit: batch.unit,
        changeType: 'MANUAL_DEDUCT',
        notes: input.notes ?? null,
        now,
      });
      inventoryLogIds.push(logId);
      allocations.push({
        batchId: batch.id,
        batchVersion: batch.version,
        beforeQuantity: batch.quantity,
        afterQuantity: after,
        unit: batch.unit,
        changeQuantity: -take,
      });
    }

    const remainingBatches = await tx.query<BatchRow>(
      `SELECT * FROM "InventoryBatch" WHERE "ingredientId" = ? AND "deletedAt" IS NULL
       ORDER BY "createdAt" ASC, "id" ASC`,
      [ingredientId],
    );
    const quantity = summarizeQuantity(remainingBatches, ingredient.unit);
    const earliest = [...remainingBatches]
      .filter((item) => item.quantity > 0)
      .sort((a, b) =>
        (a.expiryDate ?? '9999-12-31').localeCompare(b.expiryDate ?? '9999-12-31'),
      )[0];
    const summary = await tx.run(
      `UPDATE "Ingredient" SET
         "quantity" = ?, "purchaseDate" = ?, "expiryDate" = ?, "location" = ?, "opened" = ?,
         "version" = "version" + 1, "updatedAt" = ?
       WHERE "id" = ? AND "version" = ? AND "deletedAt" IS NULL`,
      [
        quantity,
        earliest?.purchaseDate ?? null,
        earliest?.expiryDate ?? null,
        earliest?.location ?? null,
        remainingBatches.some(
          (item) => item.quantity > 0 && (item.opened === 1 || item.opened === true),
        )
          ? 1
          : 0,
        timestamp,
        ingredientId,
        input.ingredientVersion,
      ],
    );
    if (summary.changes !== 1) {
      const [latest] = await tx.query<{ version: number; deletedAt: string | null }>(
        `SELECT "version", "deletedAt" FROM "Ingredient" WHERE "id" = ?`,
        [ingredientId],
      );
      if (!latest || latest.deletedAt) throw notFound();
      throw new VersionConflictError(
        'Ingredient',
        ingredientId,
        input.ingredientVersion,
        latest.version,
      );
    }

    const dto = await readIngredientDtoById(tx, ingredientId, now, true);
    await tx.enqueue({
      opId: newBatchId(),
      entity: 'Ingredient',
      entityId: ingredientId,
      kind: 'command',
      commandType: 'INGREDIENT_CONSUME',
      baseVersion: input.ingredientVersion,
      payload: {
        id: ingredientId,
        baseVersion: input.ingredientVersion,
        request: {
          mode: input.mode,
          ...(input.mode === 'QUANTITY' ? { quantity: input.quantity, unit: input.unit } : {}),
          ingredientVersion: input.ingredientVersion,
          notes: input.notes ?? null,
        },
      },
    });

    return {
      mode: input.mode,
      consumedQuantity,
      consumedUnit: input.mode === 'QUANTITY' ? (input.unit as QuantityUnit) : ingredient.unit,
      allocations,
      incompatibleBatchIds,
      inventoryLogIds,
      ingredient: dto,
    };
  });
}

/** 解析 POST/PUT 的请求体为 `IngredientWriteInput`（含历史 `storageLocation` 兼容）。 */
export function parseIngredientBody(body: Record<string, unknown>): IngredientWriteInput {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw validationError('食材名称不能为空');
  const unit = parseUnit(body.unit, 'unit');
  return {
    name,
    imagePath: optionalText(body.imagePath, 'imagePath'),
    category: optionalText(body.category, 'category'),
    unit,
    minStock: optionalNumber(body.minStock, 'minStock'),
    maxStock: optionalNumber(body.maxStock, 'maxStock'),
    notes: optionalText(body.notes, 'notes'),
    batches: parseBatches(body.batches),
    quantity: optionalNumber(body.quantity, 'quantity'),
    purchaseDate: optionalText(body.purchaseDate, 'purchaseDate'),
    expiryDate: optionalText(body.expiryDate, 'expiryDate'),
    // 前端历史字段名 storageLocation 与 location 等价，location 优先。
    location:
      body.location !== undefined
        ? optionalText(body.location, 'location')
        : optionalText(body.storageLocation, 'storageLocation'),
    opened: optionalBoolean(body.opened, 'opened'),
  };
}
