/** 数量归一：与上游 `roundQuantity` 一致（保留 6 位小数）。 */
export function roundQuantity(value: number): number {
  return Number(value.toFixed(6));
}

export const QUANTITY_EPSILON = 1e-9;
