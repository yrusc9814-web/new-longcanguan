/**
 * 厨房工具（KitchenTool）本地读写。
 *
 * 契约来源：上游 `app/server/src/modules/tools/{routes,service}.ts`
 * （`da-fan-xiao-guan@e778d3bd3354123032e570e03ad85c6b19bd9ea4`）。
 *
 * 端侧差异：
 * - 上游 `GET /tools/:id` 属剔除端点，本模块不实现；
 * - 删除为软删（写 `deletedAt`）并同事务写发件箱；
 * - 读侧只返真实存储的 `icon`，绝不以 imagePath / 🍲 兜底。
 */

import type { KitchenToolDto } from '@dafan/shared/types';

import type { DatabaseClient, WriteTransaction } from '../../db/database.js';
import type { SqlValue } from '../../db/types.js';
import { LocalApiError } from '../../local-api/protocol.js';
import { validationError } from '../common.js';

/** 图标长度上限：与冻结 UI select 的 emoji 原文容量对应，超限快速失败。 */
const TOOL_ICON_LIMIT = 20;

/** 创建允许字段（version 只属于 PUT）。 */
export const TOOL_CREATE_KEYS = [
  'name',
  'imagePath',
  'icon',
  'category',
  'quantity',
  'status',
  'notes',
] as const;

/** 更新允许字段。 */
export const TOOL_UPDATE_KEYS = [...TOOL_CREATE_KEYS, 'version'] as const;

interface ToolRow {
  readonly id: string;
  readonly name: string;
  readonly imagePath: string | null;
  readonly icon: string | null;
  readonly category: string | null;
  readonly quantity: number;
  readonly status: string | null;
  readonly notes: string | null;
  readonly version: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const TOOL_COLUMNS =
  '"id", "name", "imagePath", "icon", "category", "quantity", "status", "notes", "version", "deletedAt", "createdAt", "updatedAt"';

export function mapToolRow(row: ToolRow): KitchenToolDto {
  return {
    id: row.id,
    name: row.name,
    imagePath: row.imagePath ?? null,
    // 只回真实存的 icon；不拿 imagePath 或默认 emoji 冒充。
    icon: row.icon ?? null,
    category: row.category ?? null,
    quantity: row.quantity,
    status: row.status ?? null,
    notes: row.notes ?? null,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function newHexId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 未支持字段 fail-closed 快速失败（上游 preValidation 同一语义）。 */
export function assertToolKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw validationError(`请求包含未支持的字段：${unknown.join(', ')}`);
}

/** 图标：null/undefined/空串 → null；非字符串或超限 → 400。 */
function cleanedIcon(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw validationError('设备图标必须是字符串');
  const cleaned = value.trim();
  if (cleaned.length > TOOL_ICON_LIMIT) {
    throw validationError(`设备图标不能超过 ${TOOL_ICON_LIMIT} 个字符`);
  }
  return cleaned || null;
}

function cleanedName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw validationError('工具名称不能为空');
  return value.trim();
}

/** 可空文本列：null/undefined → null；字符串原样保留（上游 `?? null` 不裁空白）。 */
function nullableText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw validationError(`${field}必须是文本`);
  return value;
}

/** 数量：null/undefined → undefined（由调用方决定默认值）；非负整数。 */
function readQuantity(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw validationError('工具数量必须是非负整数');
  }
  return value;
}

export async function listTools(
  database: DatabaseClient,
  search?: string,
): Promise<KitchenToolDto[]> {
  const term = search?.trim();
  const rows = await database.query<ToolRow>(
    term
      ? `SELECT ${TOOL_COLUMNS} FROM "KitchenTool" WHERE "deletedAt" IS NULL AND "name" LIKE ?
         ORDER BY "updatedAt" DESC, "id" ASC`
      : `SELECT ${TOOL_COLUMNS} FROM "KitchenTool" WHERE "deletedAt" IS NULL
         ORDER BY "updatedAt" DESC, "id" ASC`,
    term ? [`%${term}%`] : [],
  );
  return rows.map(mapToolRow);
}

export async function createTool(
  database: DatabaseClient,
  body: Record<string, unknown>,
  now: Date,
): Promise<KitchenToolDto> {
  assertToolKeys(body, TOOL_CREATE_KEYS);
  const name = cleanedName(body.name);
  const imagePath = nullableText(body.imagePath, '图片路径');
  const icon = cleanedIcon(body.icon);
  const category = nullableText(body.category, '分类');
  const quantity = readQuantity(body.quantity) ?? 1;
  const status = nullableText(body.status, '状态');
  const notes = nullableText(body.notes, '备注');
  const timestamp = now.toISOString();
  const id = newHexId();

  return database.withWriteTransaction(async (tx) => {
    await tx.run(
      `INSERT INTO "KitchenTool"
        ("id", "name", "imagePath", "icon", "category", "quantity", "status", "notes", "version", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, name, imagePath, icon, category, quantity, status, notes, timestamp, timestamp],
    );
    const dto = await readTool(tx, id);
    await tx.enqueue({
      opId: newHexId(),
      entity: 'KitchenTool',
      entityId: id,
      kind: 'upsert',
      baseVersion: null,
      payload: toolPayload(dto),
    });
    return dto;
  });
}

/**
 * 更新：上游是整体覆盖（`?? null` / `?? 1`），但 `icon` 省略时保留库内旧值；
 * 显式 null/空串才清空。
 */
export async function updateTool(
  database: DatabaseClient,
  id: string,
  body: Record<string, unknown>,
  version: number,
): Promise<KitchenToolDto> {
  assertToolKeys(body, TOOL_UPDATE_KEYS);
  const name = cleanedName(body.name);
  const imagePath = nullableText(body.imagePath, '图片路径');
  const category = nullableText(body.category, '分类');
  const quantity = readQuantity(body.quantity) ?? 1;
  const status = nullableText(body.status, '状态');
  const notes = nullableText(body.notes, '备注');
  const icon = body.icon === undefined ? undefined : cleanedIcon(body.icon);

  return database.withWriteTransaction(async (tx) => {
    await requireActiveTool(tx, id);
    const values: Record<string, SqlValue | undefined> = {
      name,
      imagePath,
      category,
      quantity,
      status,
      notes,
    };
    if (icon !== undefined) values.icon = icon;
    await tx.updateVersioned({ table: 'KitchenTool', id, expectedVersion: version, values });
    const dto = await readTool(tx, id);
    await tx.enqueue({
      opId: newHexId(),
      entity: 'KitchenTool',
      entityId: id,
      kind: 'upsert',
      baseVersion: version,
      payload: toolPayload(dto),
    });
    return dto;
  });
}

export async function deleteTool(
  database: DatabaseClient,
  id: string,
  version: number,
  now: Date,
): Promise<{ id: string; deleted: true }> {
  const timestamp = now.toISOString();
  return database.withWriteTransaction(async (tx) => {
    await requireActiveTool(tx, id);
    await tx.updateVersioned({
      table: 'KitchenTool',
      id,
      expectedVersion: version,
      values: { deletedAt: timestamp },
    });
    await tx.enqueue({
      opId: newHexId(),
      entity: 'KitchenTool',
      entityId: id,
      kind: 'delete',
      // delete 的 baseVersion 是"我基于的云端版本"，即删除前的 version。
      baseVersion: version,
      payload: { deletedAt: timestamp },
    });
    return { id, deleted: true };
  });
}

async function requireActiveTool(tx: WriteTransaction, id: string): Promise<ToolRow> {
  const [row] = await tx.query<ToolRow>(
    `SELECT ${TOOL_COLUMNS} FROM "KitchenTool" WHERE "id" = ?`,
    [id],
  );
  if (!row || row.deletedAt !== null) {
    throw new LocalApiError(404, 'NOT_FOUND', '厨房工具不存在');
  }
  return row;
}

async function readTool(tx: WriteTransaction, id: string): Promise<KitchenToolDto> {
  return mapToolRow(await requireActiveTool(tx, id));
}

function toolPayload(dto: KitchenToolDto): Record<string, unknown> {
  return {
    id: dto.id,
    name: dto.name,
    imagePath: dto.imagePath,
    icon: dto.icon,
    category: dto.category,
    quantity: dto.quantity,
    status: dto.status,
    notes: dto.notes,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}
