/**
 * 食用者忌口规则（与上游 `app/server/src/shared/diner-rules.ts` 同源）。
 *
 * 只放纯函数：不访问数据库、不依赖 Local API。Google2 适配器在候选筛选时
 * 内联过同样的拆分逻辑，端侧业务模块与适配器共享这里即可保持口径一致。
 */

/** 按顿号 / 半角与全角逗号 / 分号 / 空白拆分词条，统一小写并去掉空项。 */
export function tokens(value: string | null | undefined): string[] {
  return value
    ? value
        .split(/[、,，;；\s]+/)
        .map((token) => token.trim().toLocaleLowerCase())
        .filter(Boolean)
    : [];
}

/** `haystack` 是否命中任一 `words`（调用方需保证 `words` 已小写，`tokens` 的输出满足）。 */
export function forbidden(haystack: string, words: readonly string[]): boolean {
  const lower = haystack.toLocaleLowerCase();
  return words.some((word) => lower.includes(word));
}

export interface DinerRestrictionTexts {
  readonly tabooText?: string | null;
  readonly allergyText?: string | null;
  readonly dislikesText?: string | null;
}

/**
 * 合并忌口 / 过敏 / 不喜欢词条，供候选筛选使用。
 *
 * 上游 `loadForbiddenWords` 只取 `active: true` 的食用者；调用方负责过滤，
 * 这里保持纯函数形态，避免把查询条件藏进规则层。
 */
export function forbiddenWordsOf(diners: readonly DinerRestrictionTexts[]): string[] {
  return diners.flatMap((diner) => [
    ...tokens(diner.allergyText),
    ...tokens(diner.tabooText),
    ...tokens(diner.dislikesText),
  ]);
}
