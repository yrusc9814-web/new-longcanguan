import type { QuantityUnit } from '@dafan/shared/types';

const unitGroups: readonly Partial<Record<QuantityUnit, number>>[] = [
  { GRAM: 1, KILOGRAM: 1000 },
  { MILLILITER: 1, LITER: 1000 },
];

export function convertQuantity(
  quantity: number,
  from: QuantityUnit,
  to: QuantityUnit,
): number | null {
  if (quantity < 0) throw new Error('数量不能为负数');
  if (from === to) return quantity;

  for (const group of unitGroups) {
    const fromFactor = group[from];
    const toFactor = group[to];
    if (fromFactor !== undefined && toFactor !== undefined) {
      return quantity * (fromFactor / toFactor);
    }
  }
  return null;
}

export function canConvertUnit(from: QuantityUnit, to: QuantityUnit): boolean {
  return convertQuantity(1, from, to) !== null;
}
