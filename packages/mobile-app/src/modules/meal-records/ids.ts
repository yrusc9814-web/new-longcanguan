/**
 * 聚合关联行的确定性主键。
 *
 * `MealPlanDiner` / `MealRecordDiner` 的载荷只暴露关联实体本身（`DinerDto`），
 * 云端无法从载荷读出行 ID，只能按 `(父行, 关联行)` 派生。端侧写入必须使用
 * 同一规则，否则云端派生行与本地随机行会在拉取后并存。
 */
export function mealPlanDinerId(mealPlanId: string, dinerId: string): string {
  return `mpd:${mealPlanId}:${dinerId}`;
}

export function mealRecordDinerId(mealRecordId: string, dinerId: string): string {
  return `mrd:${mealRecordId}:${dinerId}`;
}

/** 32 位小写十六进制本地主键，与 schema 的 `lower(hex(randomblob(16)))` 同形。 */
let counter = 0;

export function newLocalId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  counter = (counter + 1) % 0x10000;
  bytes[12] = (bytes[12] + (counter >> 8)) & 0xff;
  bytes[13] = (bytes[13] + (counter & 0xff)) & 0xff;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
