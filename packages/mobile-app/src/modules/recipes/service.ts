import type { DatabaseClient, WriteTransaction } from '../../db/database.js';
import { VersionConflictError } from '../../db/errors.js';
import type { SqlValue } from '../../db/types.js';
import { LocalApiError } from '../../local-api/protocol.js';
import { paginated, sqlBoolean } from '../common.js';

import type {
  KitchenToolRow,
  MealRole,
  MealType,
  RecipeDto,
  RecipeIngredientDto,
  RecipeIngredientInput,
  RecipeIngredientRow,
  RecipeListQuery,
  RecipeListResult,
  RecipeMealRoleRow,
  RecipeMealTypeRow,
  RecipeRow,
  RecipeStepDto,
  RecipeStepRow,
  RecipeTagDto,
  RecipeToolDto,
  RecipeToolRow,
  RecipeWriteInput,
  SqlQuery,
  TagRow,
} from './types.js';

/** 与库存/工具域一致：32 位小写十六进制本地主键（上游 cuid 的本地等价物）。 */
let idCounter = 0;

export function newLocalId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  idCounter = (idCounter + 1) % 0x10000;
  bytes[12] = (bytes[12] + (idCounter >> 8)) & 0xff;
  bytes[13] = (bytes[13] + (idCounter & 0xff)) & 0xff;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 上游 `include` 的等价读取：主表 + 六类关联，按同一稳定顺序返回。 */
const INGREDIENTS_SQL = `SELECT * FROM "RecipeIngredient" WHERE "recipeId" = ? ORDER BY "sortOrder" ASC`;
const STEPS_SQL = `SELECT * FROM "RecipeStep" WHERE "recipeId" = ? ORDER BY "stepNo" ASC`;
const TAGS_SQL = `SELECT rt."id" AS "recipeTagId", rt."recipeId", rt."tagId", rt."createdAt" AS "recipeTagCreatedAt",
    rt."updatedAt" AS "recipeTagUpdatedAt",
    t."id" AS "tag_id", t."name" AS "tag_name", t."type" AS "tag_type", t."deletedAt" AS "tag_deletedAt",
    t."createdAt" AS "tag_createdAt", t."updatedAt" AS "tag_updatedAt"
  FROM "RecipeTag" rt JOIN "Tag" t ON t."id" = rt."tagId"
  WHERE rt."recipeId" = ? ORDER BY rt.rowid ASC`;
// 上游 include 不带 orderBy，SQLite 默认按插入顺序返回；显式用 rowid 固化同一语义。
const MEAL_TYPES_SQL = `SELECT * FROM "RecipeMealType" WHERE "recipeId" = ? ORDER BY rowid ASC`;
const MEAL_ROLES_SQL = `SELECT * FROM "RecipeMealRole" WHERE "recipeId" = ? ORDER BY rowid ASC`;
const TOOLS_SQL = `SELECT rt.*, kt."id" AS "tool_id", kt."name" AS "tool_name", kt."imagePath" AS "tool_imagePath",
    kt."icon" AS "tool_icon", kt."category" AS "tool_category", kt."quantity" AS "tool_quantity",
    kt."status" AS "tool_status", kt."notes" AS "tool_notes", kt."version" AS "tool_version",
    kt."deletedAt" AS "tool_deletedAt", kt."createdAt" AS "tool_createdAt", kt."updatedAt" AS "tool_updatedAt"
  FROM "RecipeTool" rt LEFT JOIN "KitchenTool" kt ON kt."id" = rt."toolId"
  WHERE rt."recipeId" = ? ORDER BY rt.rowid ASC`;

interface RecipeTagJoinRow {
  readonly recipeTagId: string;
  readonly recipeId: string;
  readonly tagId: string;
  readonly recipeTagCreatedAt: string;
  readonly recipeTagUpdatedAt: string;
  readonly tag_id: string;
  readonly tag_name: string;
  readonly tag_type: string;
  readonly tag_deletedAt: string | null;
  readonly tag_createdAt: string;
  readonly tag_updatedAt: string;
}

interface RecipeToolJoinRow extends Omit<RecipeToolRow, 'required'> {
  readonly required: number | boolean;
  readonly tool_id: string | null;
  readonly tool_name: string | null;
  readonly tool_imagePath: string | null;
  readonly tool_icon: string | null;
  readonly tool_category: string | null;
  readonly tool_quantity: number | null;
  readonly tool_status: string | null;
  readonly tool_notes: string | null;
  readonly tool_version: number | null;
  readonly tool_deletedAt: string | null;
  readonly tool_createdAt: string | null;
  readonly tool_updatedAt: string | null;
}

export function toBoolean(value: number | boolean | null | undefined): boolean {
  return value === null || value === undefined ? false : sqlBoolean(value);
}

function nullableNumber(value: number | null | undefined): number | null {
  return value === undefined || value === null ? null : Number(value);
}

export function toRecipeDto(
  recipe: RecipeRow,
  ingredients: readonly RecipeIngredientRow[],
  steps: readonly RecipeStepRow[],
  tags: readonly RecipeTagJoinRow[],
  mealTypes: readonly RecipeMealTypeRow[],
  mealRoles: readonly RecipeMealRoleRow[],
  tools: readonly RecipeToolJoinRow[],
): RecipeDto {
  return {
    id: recipe.id,
    name: recipe.name,
    category: recipe.category ?? null,
    imagePath: recipe.imagePath ?? null,
    ingredientsText: recipe.ingredientsText ?? null,
    cookingTimeMinutes: nullableNumber(recipe.cookingTimeMinutes),
    difficulty: recipe.difficulty ?? null,
    spicyLevel: nullableNumber(recipe.spicyLevel),
    servings: nullableNumber(recipe.servings),
    calories: nullableNumber(recipe.calories),
    sourceNote: recipe.sourceNote ?? null,
    notes: recipe.notes ?? null,
    favorite: toBoolean(recipe.favorite),
    enabledForRecommendation: toBoolean(recipe.enabledForRecommendation),
    version: Number(recipe.version),
    deletedAt: recipe.deletedAt ?? null,
    createdAt: recipe.createdAt,
    updatedAt: recipe.updatedAt,
    ingredients: ingredients.map((row): RecipeIngredientDto => ({
      id: row.id,
      recipeId: row.recipeId,
      ingredientId: row.ingredientId ?? null,
      ingredientNameSnapshot: row.ingredientNameSnapshot,
      quantity: nullableNumber(row.quantity),
      unit: row.unit ?? null,
      amountText: row.amountText ?? null,
      optional: toBoolean(row.optional),
      isPrimary: toBoolean(row.isPrimary),
      sortOrder: Number(row.sortOrder),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    steps: steps.map((row): RecipeStepDto => ({
      id: row.id,
      recipeId: row.recipeId,
      stepNo: Number(row.stepNo),
      content: row.content,
      title: row.title ?? null,
      timerMinutes: nullableNumber(row.timerMinutes),
      imagePath: row.imagePath ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    tags: tags.map((row): RecipeTagDto => ({
      id: row.recipeTagId,
      recipeId: row.recipeId,
      tagId: row.tagId,
      createdAt: row.recipeTagCreatedAt,
      updatedAt: row.recipeTagUpdatedAt,
      tag: {
        id: row.tag_id,
        name: row.tag_name,
        type: row.tag_type,
        deletedAt: row.tag_deletedAt ?? null,
        createdAt: row.tag_createdAt,
        updatedAt: row.tag_updatedAt,
      } satisfies TagRow,
    })),
    mealTypes: mealTypes.map((row) => ({ ...row, mealType: row.mealType as MealType })),
    mealRoles: mealRoles.map((row) => ({ ...row, mealRole: row.mealRole as MealRole })),
    tools: tools.map((row): RecipeToolDto => ({
      id: row.id,
      recipeId: row.recipeId,
      toolId: row.toolId ?? null,
      toolNameSnapshot: row.toolNameSnapshot,
      required: toBoolean(row.required),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      tool:
        row.tool_id === null || row.tool_id === undefined
          ? null
          : ({
              id: row.tool_id,
              name: row.tool_name as string,
              imagePath: row.tool_imagePath ?? null,
              icon: row.tool_icon ?? null,
              category: row.tool_category ?? null,
              quantity: Number(row.tool_quantity ?? 0),
              status: row.tool_status ?? null,
              notes: row.tool_notes ?? null,
              version: Number(row.tool_version ?? 1),
              deletedAt: row.tool_deletedAt ?? null,
              createdAt: row.tool_createdAt as string,
              updatedAt: row.tool_updatedAt as string,
            } satisfies KitchenToolRow),
    })),
  };
}

export async function loadRecipeDto(database: SqlQuery, id: string): Promise<RecipeDto | null> {
  const [recipe] = await database.query<RecipeRow>(`SELECT * FROM "Recipe" WHERE "id" = ?`, [id]);
  if (!recipe) return null;
  const [ingredients, steps, tags, mealTypes, mealRoles, tools] = await Promise.all([
    database.query<RecipeIngredientRow>(INGREDIENTS_SQL, [id]),
    database.query<RecipeStepRow>(STEPS_SQL, [id]),
    database.query<RecipeTagJoinRow>(TAGS_SQL, [id]),
    database.query<RecipeMealTypeRow>(MEAL_TYPES_SQL, [id]),
    database.query<RecipeMealRoleRow>(MEAL_ROLES_SQL, [id]),
    database.query<RecipeToolJoinRow>(TOOLS_SQL, [id]),
  ]);
  return toRecipeDto(recipe, ingredients, steps, tags, mealTypes, mealRoles, tools);
}

function whereClause(query: RecipeListQuery): { sql: string; params: SqlValue[] } {
  const clauses = ['r."deletedAt" IS NULL'];
  const params: SqlValue[] = [];
  if (query.mealType) {
    clauses.push(
      'EXISTS (SELECT 1 FROM "RecipeMealType" mt WHERE mt."recipeId" = r."id" AND mt."mealType" = ?)',
    );
    params.push(query.mealType);
  }
  if (query.difficulty) {
    clauses.push('r."difficulty" = ?');
    params.push(query.difficulty);
  }
  if (query.spicyLevel !== undefined) {
    clauses.push('r."spicyLevel" = ?');
    params.push(query.spicyLevel);
  }
  if (query.favorite !== undefined) {
    clauses.push('r."favorite" = ?');
    params.push(query.favorite ? 1 : 0);
  }
  // 与上游一致：tag 过滤排除软删标签，search 的标签匹配不过滤 deletedAt。
  if (query.tag) {
    clauses.push(
      'EXISTS (SELECT 1 FROM "RecipeTag" rt JOIN "Tag" t ON t."id" = rt."tagId" WHERE rt."recipeId" = r."id" AND t."name" = ? AND t."deletedAt" IS NULL)',
    );
    params.push(query.tag);
  }
  if (query.search) {
    // 与 Prisma SQLite `contains` 一致：拼成 %value%，不额外转义通配符。
    const like = `%${query.search}%`;
    clauses.push(
      `(r."name" LIKE ? OR r."notes" LIKE ? OR r."ingredientsText" LIKE ?
        OR EXISTS (SELECT 1 FROM "RecipeIngredient" ri WHERE ri."recipeId" = r."id" AND ri."ingredientNameSnapshot" LIKE ?)
        OR EXISTS (SELECT 1 FROM "RecipeTag" rt JOIN "Tag" t ON t."id" = rt."tagId" WHERE rt."recipeId" = r."id" AND t."name" LIKE ?))`,
    );
    params.push(like, like, like, like, like);
  }
  return { sql: clauses.join(' AND '), params };
}

const SORT_COLUMNS = {
  name: 'name',
  cookingTimeMinutes: 'cookingTimeMinutes',
  favorite: 'favorite',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
} as const;

export async function listRecipes(
  database: SqlQuery,
  query: RecipeListQuery,
): Promise<RecipeListResult> {
  const where = whereClause(query);
  const direction = query.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const column = SORT_COLUMNS[query.sortBy] ?? 'updatedAt';
  const offset = (query.page - 1) * query.pageSize;

  const [totalRow] = await database.query<{ total: number }>(
    `SELECT COUNT(*) AS "total" FROM "Recipe" r WHERE ${where.sql}`,
    where.params,
  );
  const rows = await database.query<RecipeRow>(
    `SELECT r.* FROM "Recipe" r WHERE ${where.sql}
     ORDER BY r."${column}" ${direction}, r."id" ${direction}
     LIMIT ? OFFSET ?`,
    [...where.params, query.pageSize, offset],
  );
  const items = await Promise.all(rows.map((row) => loadRecipeDto(database, row.id)));
  const total = Number(totalRow?.total ?? 0);
  return paginated(
    items.filter((item): item is RecipeDto => item !== null),
    total,
    { page: query.page, pageSize: query.pageSize, skip: offset, take: query.pageSize },
  );
}

export async function getRecipe(database: SqlQuery, id: string): Promise<RecipeDto> {
  const dto = await loadRecipeDto(database, id);
  if (!dto || dto.deletedAt !== null) throw new LocalApiError(404, 'NOT_FOUND', '菜谱不存在');
  return dto;
}

/** 上游 `assertIngredientsExist`：只接受存在且未软删的库存食材，否则 400。 */
async function assertIngredientsExist(
  transaction: WriteTransaction,
  ingredients: readonly RecipeIngredientInput[],
): Promise<readonly RecipeIngredientInput[]> {
  const ids = [
    ...new Set(ingredients.map((item) => item.ingredientId).filter((id): id is string => !!id)),
  ];
  if (!ids.length) return ingredients;
  const placeholders = ids.map(() => '?').join(', ');
  const found = await transaction.query<{ id: string; deletedAt: string | null }>(
    `SELECT "id", "deletedAt" FROM "Ingredient" WHERE "id" IN (${placeholders})`,
    ids,
  );
  const valid = new Set(found.filter((row) => row.deletedAt === null).map((row) => row.id));
  for (const item of ingredients) {
    if (item.ingredientId && !valid.has(item.ingredientId)) {
      throw new LocalApiError(
        400,
        'VALIDATION_ERROR',
        `食材「${item.name}」不存在或已删除，无法关联到菜谱`,
      );
    }
  }
  return ingredients;
}

/**
 * 配料行可以在编辑时重排。按关联 ID 匹配原名称快照，名称改动时清除旧关联。
 */
function clearStaleIngredientIds(
  ingredients: readonly RecipeIngredientInput[],
  previous: readonly RecipeIngredientRow[],
): RecipeIngredientInput[] {
  const namesById = new Map<string, Set<string>>();
  for (const row of previous) {
    if (!row.ingredientId) continue;
    const names = namesById.get(row.ingredientId) ?? new Set<string>();
    names.add(row.ingredientNameSnapshot);
    namesById.set(row.ingredientId, names);
  }
  return ingredients.map((item) => {
    const names = item.ingredientId ? namesById.get(item.ingredientId) : undefined;
    return names && !names.has(item.name) ? { ...item, ingredientId: null } : item;
  });
}

/** Tag 按 (name, type='GENERAL') 唯一：软删则复活并复用原 id，新建/复活都进发件箱。 */
async function ensureTag(
  transaction: WriteTransaction,
  name: string,
  now: string,
  newId: () => string,
): Promise<string> {
  const [existing] = await transaction.query<{
    id: string;
    deletedAt: string | null;
    createdAt: string;
  }>(`SELECT "id", "deletedAt", "createdAt" FROM "Tag" WHERE "name" = ? AND "type" = 'GENERAL'`, [
    name,
  ]);
  if (existing) {
    if (existing.deletedAt === null) return existing.id;
    await transaction.run(`UPDATE "Tag" SET "deletedAt" = NULL, "updatedAt" = ? WHERE "id" = ?`, [
      now,
      existing.id,
    ]);
    await transaction.enqueue({
      opId: newId(),
      entity: 'Tag',
      entityId: existing.id,
      kind: 'upsert',
      baseVersion: null,
      payload: {
        id: existing.id,
        name,
        type: 'GENERAL',
        deletedAt: null,
        createdAt: existing.createdAt,
        updatedAt: now,
      },
    });
    return existing.id;
  }
  const tagId = newId();
  await transaction.run(
    `INSERT INTO "Tag" ("id", "name", "type", "deletedAt", "createdAt", "updatedAt")
     VALUES (?, ?, 'GENERAL', NULL, ?, ?)`,
    [tagId, name, now, now],
  );
  await transaction.enqueue({
    opId: newId(),
    entity: 'Tag',
    entityId: tagId,
    kind: 'upsert',
    baseVersion: null,
    payload: { id: tagId, name, type: 'GENERAL', deletedAt: null, createdAt: now, updatedAt: now },
  });
  return tagId;
}

async function replaceRelations(
  transaction: WriteTransaction,
  recipeId: string,
  input: RecipeWriteInput,
  now: string,
  newId: () => string,
): Promise<void> {
  const ingredients = input.ingredients;
  for (let index = 0; index < ingredients.length; index += 1) {
    const item = ingredients[index];
    await transaction.run(
      `INSERT INTO "RecipeIngredient"
        ("id", "recipeId", "ingredientId", "ingredientNameSnapshot", "quantity", "unit", "amountText",
         "optional", "isPrimary", "sortOrder", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        recipeId,
        item.ingredientId,
        item.name,
        item.quantity,
        item.unit,
        item.amountText,
        item.optional,
        item.isPrimary,
        index,
        now,
        now,
      ],
    );
  }

  for (let index = 0; index < input.steps.length; index += 1) {
    const step = input.steps[index];
    await transaction.run(
      `INSERT INTO "RecipeStep"
        ("id", "recipeId", "stepNo", "content", "title", "timerMinutes", "imagePath", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        recipeId,
        index + 1,
        step.content,
        step.title,
        step.timerMinutes,
        step.imagePath,
        now,
        now,
      ],
    );
  }

  for (const mealType of input.mealTypes) {
    await transaction.run(
      `INSERT INTO "RecipeMealType" ("id", "recipeId", "mealType", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?)`,
      [newId(), recipeId, mealType, now, now],
    );
  }

  for (const mealRole of input.mealRoles) {
    await transaction.run(
      `INSERT INTO "RecipeMealRole" ("id", "recipeId", "mealRole", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?)`,
      [newId(), recipeId, mealRole, now, now],
    );
  }

  for (const name of input.tags) {
    const tagId = await ensureTag(transaction, name, now, newId);
    await transaction.run(
      `INSERT INTO "RecipeTag" ("id", "recipeId", "tagId", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?)`,
      [newId(), recipeId, tagId, now, now],
    );
  }

  for (const tool of input.tools) {
    await transaction.run(
      `INSERT INTO "RecipeTool"
        ("id", "recipeId", "toolId", "toolNameSnapshot", "required", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId(), recipeId, tool.toolId, tool.name, tool.required, now, now],
    );
  }
}

/** PUT 继承 Prisma 的 `undefined` 语义：category 未携带即不修改，其余标量全量替换。 */
function scalarValues(
  input: RecipeWriteInput,
  options: { readonly forUpdate: boolean },
): Record<string, SqlValue | undefined> {
  return {
    name: input.name,
    category:
      options.forUpdate && input.category === undefined ? undefined : (input.category ?? null),
    imagePath: input.imagePath ?? null,
    ingredientsText: input.ingredientsText ?? null,
    cookingTimeMinutes: input.cookingTimeMinutes,
    difficulty: input.difficulty,
    spicyLevel: input.spicyLevel,
    servings: input.servings,
    calories: input.calories,
    sourceNote: input.sourceNote ?? null,
    notes: input.notes ?? null,
    favorite: input.favorite,
    enabledForRecommendation: input.enabledForRecommendation,
  };
}

export interface RecipeServiceContext {
  readonly database: DatabaseClient;
  readonly now: () => Date;
  readonly newId: () => string;
}

export async function createRecipe(
  context: RecipeServiceContext,
  input: RecipeWriteInput,
): Promise<RecipeDto> {
  const { database, newId } = context;
  const now = context.now().toISOString();
  const recipeId = newId();
  return database.withWriteTransaction(async (transaction) => {
    const ingredients = await assertIngredientsExist(transaction, input.ingredients);
    await transaction.run(
      `INSERT INTO "Recipe"
        ("id", "name", "category", "imagePath", "ingredientsText", "cookingTimeMinutes", "difficulty",
         "spicyLevel", "servings", "calories", "sourceNote", "notes", "favorite",
         "enabledForRecommendation", "version", "deletedAt", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      [
        recipeId,
        input.name,
        input.category ?? null,
        input.imagePath,
        input.ingredientsText,
        input.cookingTimeMinutes,
        input.difficulty,
        input.spicyLevel,
        input.servings,
        input.calories,
        input.sourceNote,
        input.notes,
        input.favorite,
        input.enabledForRecommendation,
        now,
        now,
      ],
    );
    await replaceRelations(transaction, recipeId, { ...input, ingredients }, now, newId);
    const dto = await loadRecipeDto(transaction, recipeId);
    if (!dto) throw new LocalApiError(500, 'INTERNAL_ERROR', '菜谱创建后读取失败');
    await transaction.enqueue({
      opId: newId(),
      entity: 'Recipe',
      entityId: recipeId,
      kind: 'upsert',
      baseVersion: null,
      payload: dto as unknown as Record<string, unknown>,
    });
    return dto;
  });
}

export async function updateRecipe(
  context: RecipeServiceContext,
  id: string,
  version: number,
  input: RecipeWriteInput,
): Promise<RecipeDto> {
  const { database, newId } = context;
  const now = context.now().toISOString();
  return database.withWriteTransaction(async (transaction) => {
    const previous = await transaction.query<RecipeIngredientRow>(INGREDIENTS_SQL, [id]);
    const nextIngredients = clearStaleIngredientIds(input.ingredients, previous);
    await assertIngredientsExist(transaction, nextIngredients);

    try {
      await transaction.updateVersioned({
        table: 'Recipe',
        id,
        expectedVersion: version,
        values: scalarValues(input, { forUpdate: true }),
      });
    } catch (error) {
      // updateVersioned 对已软删/不存在的行抛 NOT_FOUND，与上游 404 对齐。
      if (error instanceof VersionConflictError) throw error;
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code?: string }).code === 'NOT_FOUND'
      ) {
        throw new LocalApiError(404, 'NOT_FOUND', '菜谱不存在');
      }
      throw error;
    }

    await transaction.run(`DELETE FROM "RecipeIngredient" WHERE "recipeId" = ?`, [id]);
    await transaction.run(`DELETE FROM "RecipeStep" WHERE "recipeId" = ?`, [id]);
    await transaction.run(`DELETE FROM "RecipeTag" WHERE "recipeId" = ?`, [id]);
    await transaction.run(`DELETE FROM "RecipeMealType" WHERE "recipeId" = ?`, [id]);
    await transaction.run(`DELETE FROM "RecipeMealRole" WHERE "recipeId" = ?`, [id]);
    await transaction.run(`DELETE FROM "RecipeTool" WHERE "recipeId" = ?`, [id]);

    await replaceRelations(transaction, id, { ...input, ingredients: nextIngredients }, now, newId);

    const dto = await loadRecipeDto(transaction, id);
    if (!dto) throw new LocalApiError(404, 'NOT_FOUND', '菜谱不存在');
    await transaction.enqueue({
      opId: newId(),
      entity: 'Recipe',
      entityId: id,
      kind: 'upsert',
      baseVersion: version,
      payload: dto as unknown as Record<string, unknown>,
    });
    return dto;
  });
}

export async function deleteRecipe(
  context: RecipeServiceContext,
  id: string,
  version: number,
): Promise<{ id: string; deleted: true }> {
  const { database, newId } = context;
  const now = context.now().toISOString();
  return database.withWriteTransaction(async (transaction) => {
    try {
      await transaction.updateVersioned({
        table: 'Recipe',
        id,
        expectedVersion: version,
        values: { deletedAt: now },
      });
    } catch (error) {
      if (error instanceof VersionConflictError) throw error;
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code?: string }).code === 'NOT_FOUND'
      ) {
        throw new LocalApiError(404, 'NOT_FOUND', '菜谱不存在');
      }
      throw error;
    }

    await transaction.enqueue({
      opId: newId(),
      entity: 'Recipe',
      entityId: id,
      kind: 'delete',
      baseVersion: version,
      payload: { deletedAt: now },
    });
    return { id, deleted: true };
  });
}

export async function toggleRecipeFavorite(
  context: RecipeServiceContext,
  id: string,
  version: number,
  favorite: boolean,
): Promise<RecipeRow> {
  const { database, newId } = context;
  return database.withWriteTransaction(async (transaction) => {
    try {
      await transaction.updateVersioned({
        table: 'Recipe',
        id,
        expectedVersion: version,
        values: { favorite },
      });
    } catch (error) {
      if (error instanceof VersionConflictError) throw error;
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code?: string }).code === 'NOT_FOUND'
      ) {
        throw new LocalApiError(404, 'NOT_FOUND', '菜谱不存在');
      }
      throw error;
    }

    const [row] = await transaction.query<RecipeRow>(`SELECT * FROM "Recipe" WHERE "id" = ?`, [id]);
    if (!row) throw new LocalApiError(404, 'NOT_FOUND', '菜谱不存在');
    const dto = await loadRecipeDto(transaction, id);
    if (dto) {
      await transaction.enqueue({
        opId: newId(),
        entity: 'Recipe',
        entityId: id,
        kind: 'upsert',
        baseVersion: version,
        payload: dto as unknown as Record<string, unknown>,
      });
    }
    // 上游 favorite 返回主表行（无 include）；SQLite 的 0/1 在这里归一成布尔，与 Prisma 输出一致。
    return {
      ...row,
      favorite: toBoolean(row.favorite),
      enabledForRecommendation: toBoolean(row.enabledForRecommendation),
    };
  });
}
