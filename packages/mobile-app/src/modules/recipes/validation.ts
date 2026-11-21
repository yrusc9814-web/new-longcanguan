import { LocalApiError } from '../../local-api/protocol.js';
import { pageOptions, validationError } from '../common.js';

import {
  MEAL_ROLES,
  MEAL_TYPES,
  QUANTITY_UNITS,
  RECIPE_SORT_FIELDS,
  type MealRole,
  type MealType,
  type QuantityUnit,
  type RecipeIngredientInput,
  type RecipeListQuery,
  type RecipeSortField,
  type RecipeStepInput,
  type RecipeToolInput,
  type RecipeWriteInput,
} from './types.js';

/**
 * 菜谱域写入/查询校验。
 *
 * 与上游 `app/server/src/modules/recipes/routes.ts` 的 JSON Schema 保持同等约束：
 * 标量类型不做静默强转（上游 Fastify 配置 `coerceTypes: false`），布尔只接受 JSON boolean，
 * 数值只接受 JSON number；字符串类字段只接受 string / null，绝不把数字或布尔转成字符串。
 */

function invalid(message: string): LocalApiError {
  return validationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(
  source: Record<string, unknown>,
  key: string,
  field: string,
): string | null | undefined {
  if (!(key in source)) return undefined;
  const value = source[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw invalid(`${field}必须是字符串`);
  return value;
}

function optionalBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  if (!(key in source) || source[key] === undefined) return fallback;
  const value = source[key];
  if (typeof value !== 'boolean') throw invalid(`${key} 必须是布尔值`);
  return value;
}

function optionalNullableInteger(
  source: Record<string, unknown>,
  key: string,
  options: { readonly min: number; readonly max?: number; readonly message: string },
): number | null {
  if (!(key in source) || source[key] === undefined) return null;
  const value = source[key];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw invalid(options.message);
  if (value < options.min || (options.max !== undefined && value > options.max)) {
    throw invalid(options.message);
  }
  return value;
}

function stringArray(
  source: Record<string, unknown>,
  key: string,
  field: string,
  allowed?: readonly string[],
): string[] {
  if (!(key in source) || source[key] === undefined) return [];
  const value = source[key];
  if (!Array.isArray(value)) throw invalid(`${field}必须是数组`);
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') throw invalid(`${field}必须是字符串数组`);
    if (allowed && !allowed.includes(entry)) throw invalid(`${field}包含不支持的值：${entry}`);
    result.push(entry);
  }
  return result;
}

function arrayOf(value: unknown, field: string): readonly unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid(`${field}必须是数组`);
  return value;
}

/** 上游 `(item.name ?? item.ingredientName)!.trim()`：name 为 undefined/null 时回落到 ingredientName。 */
function ingredientName(source: Record<string, unknown>): string {
  const raw = source.name ?? source.ingredientName;
  if (typeof raw !== 'string') throw invalid('食材名称必须是字符串');
  const name = raw.trim();
  if (!name) throw invalid('食材名称不能为空');
  return name;
}

function parseIngredients(value: unknown): RecipeIngredientInput[] {
  return arrayOf(value, '食材列表').map((entry) => {
    if (!isRecord(entry)) throw invalid('食材必须是对象');
    const name = ingredientName(entry);

    let ingredientId: string | null = null;
    if (entry.ingredientId !== undefined && entry.ingredientId !== null) {
      // 不做 trim/空串归一：与上游一致，任何非空校验交给「食材存在性」检查（400）。
      if (typeof entry.ingredientId !== 'string') throw invalid('食材关联 ID 必须是字符串');
      ingredientId = entry.ingredientId;
    }

    let quantity: number | null = null;
    if ('quantity' in entry && entry.quantity !== undefined && entry.quantity !== null) {
      const raw = entry.quantity;
      if (typeof raw !== 'number' || !Number.isFinite(raw)) throw invalid('食材数量必须是数字');
      if (raw < 0) throw invalid('食材数量不能为负数');
      quantity = raw;
    }

    let unit: QuantityUnit | null = null;
    if ('unit' in entry && entry.unit !== undefined && entry.unit !== null) {
      const raw = entry.unit;
      if (typeof raw !== 'string' || !(QUANTITY_UNITS as readonly string[]).includes(raw)) {
        throw invalid(`食材单位不受支持：${String(raw)}`);
      }
      unit = raw as QuantityUnit;
    }

    return {
      ingredientId,
      name,
      quantity,
      unit,
      amountText: nullableString(entry, 'amountText', '食材用量原文') ?? null,
      optional: optionalBoolean(entry, 'optional', false),
      isPrimary: optionalBoolean(entry, 'isPrimary', false),
    } satisfies RecipeIngredientInput;
  });
}

function parseSteps(value: unknown): RecipeStepInput[] {
  return arrayOf(value, '制作步骤').map((entry) => {
    if (!isRecord(entry)) throw invalid('制作步骤必须是对象');
    if (typeof entry.content !== 'string') throw invalid('制作步骤内容必须是字符串');
    const content = entry.content.trim();
    if (!content) throw invalid('制作步骤不能为空');

    return {
      content,
      title: nullableString(entry, 'title', '步骤标题') ?? null,
      timerMinutes: optionalNullableInteger(entry, 'timerMinutes', {
        min: 0,
        max: 180,
        message: '步骤计时必须是 0 到 180 之间的整数',
      }),
      imagePath: nullableString(entry, 'imagePath', '步骤图片') ?? null,
    } satisfies RecipeStepInput;
  });
}

function parseTools(value: unknown): RecipeToolInput[] {
  return arrayOf(value, '厨房工具').map((entry) => {
    if (!isRecord(entry)) throw invalid('厨房工具必须是对象');
    if (typeof entry.name !== 'string') throw invalid('厨房工具名称必须是字符串');

    let toolId: string | null = null;
    if (entry.toolId !== undefined && entry.toolId !== null) {
      if (typeof entry.toolId !== 'string') throw invalid('厨房工具 ID 必须是字符串');
      toolId = entry.toolId;
    }

    return {
      toolId,
      // 上游只要求 name 是 string，随后原样 trim 落库；空串同样接受。
      name: entry.name.trim(),
      required: optionalBoolean(entry, 'required', true),
    } satisfies RecipeToolInput;
  });
}

/** 与上游 `cleanNames` 一致：trim、去空、按首次出现顺序去重。 */
function cleanNames(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const name = value.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function parseRecipeWriteInput(raw: Record<string, unknown>): RecipeWriteInput {
  if (typeof raw.name !== 'string') throw invalid('菜谱名称必须是字符串');
  const name = raw.name.trim();
  if (!name) throw invalid('菜谱名称不能为空');

  return {
    name,
    category: nullableString(raw, 'category', '菜谱分类'),
    imagePath: nullableString(raw, 'imagePath', '菜谱图片') ?? null,
    ingredientsText: nullableString(raw, 'ingredientsText', '食材说明') ?? null,
    cookingTimeMinutes: optionalNullableInteger(raw, 'cookingTimeMinutes', {
      min: 0,
      message: '制作时间必须是非负整数',
    }),
    difficulty: nullableString(raw, 'difficulty', '难度') ?? null,
    spicyLevel: optionalNullableInteger(raw, 'spicyLevel', {
      min: 0,
      max: 5,
      message: '辣度必须是 0 到 5 的整数',
    }),
    servings: optionalNullableInteger(raw, 'servings', {
      min: 0,
      message: '份量必须是非负整数',
    }),
    calories: optionalNullableInteger(raw, 'calories', {
      min: 50,
      max: 2000,
      message: '热量必须是 50 到 2000 之间的整数',
    }),
    sourceNote: nullableString(raw, 'sourceNote', '来源') ?? null,
    notes: nullableString(raw, 'notes', '备注') ?? null,
    favorite: optionalBoolean(raw, 'favorite', false),
    enabledForRecommendation: optionalBoolean(raw, 'enabledForRecommendation', true),
    ingredients: parseIngredients(raw.ingredients),
    steps: parseSteps(raw.steps),
    tools: parseTools(raw.toolIds),
    tags: cleanNames(stringArray(raw, 'tags', '标签')),
    mealTypes: unique(stringArray(raw, 'mealTypes', '餐次', MEAL_TYPES) as MealType[]),
    mealRoles: unique(stringArray(raw, 'mealRoles', '餐位', MEAL_ROLES) as MealRole[]),
  };
}

function queryEnum<T extends string>(
  query: URLSearchParams,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = query.get(key);
  if (raw === null) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw invalid(`${key} 取值不受支持：${raw}`);
  return raw as T;
}

function mealTypeQuery(query: URLSearchParams): MealType | undefined {
  const raw = query.get('mealType');
  if (raw === null) return undefined;
  if (!(MEAL_TYPES as readonly string[]).includes(raw))
    throw invalid(`mealType 取值不受支持：${raw}`);
  return raw as MealType;
}

/**
 * 与上游 `normalizePagination` + JSON Schema 一致：page/pageSize 缺省时回落 1/20，
 * 显式非正整数按 400 拒绝，pageSize 上限 100。
 */
export function parseRecipeListQuery(query: URLSearchParams): RecipeListQuery {
  const { page, pageSize } = pageOptions(query, 100);

  const rawSpicy = query.get('spicyLevel');
  let spicyLevel: number | undefined;
  if (rawSpicy !== null) {
    if (!/^[0-5]$/.test(rawSpicy)) throw invalid('辣度必须是 0 到 5 的整数');
    spicyLevel = Number(rawSpicy);
  }

  const rawFavorite = query.get('favorite');
  let favorite: boolean | undefined;
  if (rawFavorite !== null) {
    if (rawFavorite !== 'true' && rawFavorite !== 'false')
      throw invalid('favorite 必须是 true 或 false');
    favorite = rawFavorite === 'true';
  }

  // 上游只对 search 做 trim；difficulty / tag 原样比较，空串因 falsy 不过滤。
  const search = query.get('search')?.trim();
  const difficulty = query.get('difficulty');
  const tag = query.get('tag');

  return {
    page,
    pageSize,
    ...(search ? { search } : {}),
    ...(difficulty ? { difficulty } : {}),
    ...(tag ? { tag } : {}),
    ...(spicyLevel !== undefined ? { spicyLevel } : {}),
    ...(favorite !== undefined ? { favorite } : {}),
    mealType: mealTypeQuery(query),
    sortBy: queryEnum<RecipeSortField>(query, 'sortBy', RECIPE_SORT_FIELDS, 'updatedAt'),
    sortOrder: queryEnum<'asc' | 'desc'>(query, 'sortOrder', ['asc', 'desc'], 'desc'),
  };
}
