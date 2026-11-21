/**
 * 食用者（Diner）本地读写。
 *
 * 契约来源：上游 `app/server/src/modules/diners/{routes,service}.ts`
 * （`da-fan-xiao-guan@e778d3bd3354123032e570e03ad85c6b19bd9ea4`）。
 *
 * 端侧差异（均与离线库 schema / 保留端点清单对齐）：
 * - 上游 `GET /diners/:id`、`DELETE /diners/:id` 属剔除端点，本模块不实现；
 * - 停用走 `PUT` 的 `active=false`，端侧没有硬删；
 * - `Diner` 表没有 `deletedAt`，`updateVersioned` 按 id + version 定位（语义与上游一致）。
 */

import type { DinerDto, PaginationResponse } from '@dafan/shared/types';

import type { DatabaseClient, WriteTransaction } from '../../db/database.js';
import type { SqlValue } from '../../db/types.js';
import { LocalApiError } from '../../local-api/protocol.js';
import { paginated, sqlBoolean, validationError, type PageOptions } from '../common.js';

const NAME_LIMIT = 80;
const TEXT_LIMIT = 2_000;

/** `Diner` 行：SQLite BOOLEAN 可能是 0/1 或布尔。 */
export interface DinerRow {
  readonly id: string;
  readonly name: string;
  readonly avatarPath: string | null;
  readonly active: number | boolean | null;
  readonly likesText: string | null;
  readonly dislikesText: string | null;
  readonly tabooText: string | null;
  readonly allergyText: string | null;
  readonly portionNote: string | null;
  readonly notes: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DinerListQuery extends PageOptions {
  readonly search?: string;
  readonly active?: boolean;
  readonly sortOrder?: 'asc' | 'desc';
}

const DINER_COLUMNS =
  '"id", "name", "avatarPath", "active", "likesText", "dislikesText", "tabooText", "allergyText", "portionNote", "notes", "version", "createdAt", "updatedAt"';

/** 控件文本列：null/undefined → null；去空白后为空同样落 null。 */
function cleanedText(value: unknown, field: string, limit = TEXT_LIMIT): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw validationError(`${field}必须是文本`);
  const result = value.trim();
  if (result.length > limit) throw validationError(`${field}不能超过 ${limit} 个字符`);
  return result || null;
}

function cleanedName(value: unknown): string {
  const name = cleanedText(value, '食用者姓名', NAME_LIMIT);
  if (!name) throw validationError('食用者姓名不能为空');
  return name;
}

function readActive(value: unknown): boolean {
  if (typeof value !== 'boolean') throw validationError('active 必须是布尔值');
  return value;
}

/** 离线主键：32 位小写十六进制，与 schema 中 `lower(hex(randomblob(16)))` 同形。 */
export function newHexId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function mapDinerRow(row: DinerRow): DinerDto {
  return {
    id: row.id,
    name: row.name,
    avatarPath: row.avatarPath ?? null,
    // 布尔列必须显式转换，禁止 0/1 泄漏到 DTO。
    active: sqlBoolean(row.active === null ? 0 : row.active),
    likesText: row.likesText ?? null,
    dislikesText: row.dislikesText ?? null,
    tabooText: row.tabooText ?? null,
    allergyText: row.allergyText ?? null,
    portionNote: row.portionNote ?? null,
    notes: row.notes ?? null,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 发件箱载荷：业务列原样上报；version 由 baseVersion 表达，不重复写入。 */
function dinerPayload(dto: DinerDto): Record<string, unknown> {
  return {
    id: dto.id,
    name: dto.name,
    avatarPath: dto.avatarPath,
    active: dto.active,
    likesText: dto.likesText,
    dislikesText: dto.dislikesText,
    tabooText: dto.tabooText,
    allergyText: dto.allergyText,
    portionNote: dto.portionNote,
    notes: dto.notes,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

function whereClause(query: DinerListQuery): { sql: string; values: SqlValue[] } {
  const conditions: string[] = [];
  const values: SqlValue[] = [];
  if (query.active !== undefined) {
    conditions.push('"active" = ?');
    values.push(query.active ? 1 : 0);
  }
  const search = query.search?.trim();
  if (search) {
    // 与上游 Prisma `contains` 口径一致：只做子串匹配。
    const pattern = `%${search}%`;
    conditions.push(
      '("name" LIKE ? OR "likesText" LIKE ? OR "dislikesText" LIKE ? OR "tabooText" LIKE ? OR "allergyText" LIKE ?)',
    );
    values.push(pattern, pattern, pattern, pattern, pattern);
  }
  return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values };
}

export async function listDiners(
  database: DatabaseClient,
  query: DinerListQuery,
): Promise<PaginationResponse<DinerDto>> {
  const where = whereClause(query);
  const direction = query.sortOrder === 'desc' ? 'DESC' : 'ASC';
  const rows = await database.query<DinerRow>(
    `SELECT ${DINER_COLUMNS} FROM "Diner" ${where.sql}
     ORDER BY "name" ${direction}, "id" ASC LIMIT ? OFFSET ?`,
    [...where.values, query.take, query.skip],
  );
  const [counted] = await database.query<{ total: number }>(
    `SELECT COUNT(*) AS "total" FROM "Diner" ${where.sql}`,
    where.values,
  );
  return paginated(rows.map(mapDinerRow), counted?.total ?? 0, query);
}

async function readDiner(tx: WriteTransaction, id: string): Promise<DinerDto> {
  const [row] = await tx.query<DinerRow>(`SELECT ${DINER_COLUMNS} FROM "Diner" WHERE "id" = ?`, [
    id,
  ]);
  if (!row) throw new LocalApiError(404, 'NOT_FOUND', '食用者不存在');
  return mapDinerRow(row);
}

export async function createDiner(
  database: DatabaseClient,
  body: Record<string, unknown>,
  now: Date,
): Promise<DinerDto> {
  const name = cleanedName(body.name);
  const avatarPath = cleanedText(body.avatarPath, '头像路径');
  const likesText = cleanedText(body.likesText, '喜好');
  const dislikesText = cleanedText(body.dislikesText, '不喜欢');
  const tabooText = cleanedText(body.tabooText, '忌口');
  const allergyText = cleanedText(body.allergyText, '过敏提示');
  const portionNote = cleanedText(body.portionNote, '默认餐量');
  const notes = cleanedText(body.notes, '备注');
  const active = body.active === undefined ? true : readActive(body.active);
  const timestamp = now.toISOString();
  const id = newHexId();

  return database.withWriteTransaction(async (tx) => {
    // 上游 diners schema 未声明 additionalProperties:false，未知字段静默忽略。
    await tx.run(
      `INSERT INTO "Diner"
        ("id", "name", "avatarPath", "active", "likesText", "dislikesText", "tabooText", "allergyText", "portionNote", "notes", "version", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        id,
        name,
        avatarPath,
        active ? 1 : 0,
        likesText,
        dislikesText,
        tabooText,
        allergyText,
        portionNote,
        notes,
        timestamp,
        timestamp,
      ],
    );
    const dto = await readDiner(tx, id);
    await tx.enqueue({
      opId: newHexId(),
      entity: 'Diner',
      entityId: id,
      kind: 'upsert',
      baseVersion: null,
      payload: dinerPayload(dto),
    });
    return dto;
  });
}

/**
 * 局部更新：只写请求中出现的字段。忌口三列（tabooText / allergyText / dislikesText）
 * 由适配器整体回传，显式 null 表示清空，必须真正落库而不是被过滤掉。
 */
export async function updateDiner(
  database: DatabaseClient,
  id: string,
  body: Record<string, unknown>,
  version: number,
): Promise<DinerDto> {
  const values: Record<string, SqlValue | undefined> = {};
  if (body.name !== undefined) values.name = cleanedName(body.name);
  if (body.avatarPath !== undefined) values.avatarPath = cleanedText(body.avatarPath, '头像路径');
  if (body.likesText !== undefined) values.likesText = cleanedText(body.likesText, '喜好');
  if (body.dislikesText !== undefined)
    values.dislikesText = cleanedText(body.dislikesText, '不喜欢');
  if (body.tabooText !== undefined) values.tabooText = cleanedText(body.tabooText, '忌口');
  if (body.allergyText !== undefined)
    values.allergyText = cleanedText(body.allergyText, '过敏提示');
  if (body.portionNote !== undefined)
    values.portionNote = cleanedText(body.portionNote, '默认餐量');
  if (body.notes !== undefined) values.notes = cleanedText(body.notes, '备注');
  if (body.active !== undefined) values.active = readActive(body.active) ? 1 : 0;

  return database.withWriteTransaction(async (tx) => {
    await tx.updateVersioned({
      table: 'Diner',
      id,
      expectedVersion: version,
      values,
    });
    const dto = await readDiner(tx, id);
    await tx.enqueue({
      opId: newHexId(),
      entity: 'Diner',
      entityId: id,
      kind: 'upsert',
      baseVersion: version,
      payload: dinerPayload(dto),
    });
    return dto;
  });
}
