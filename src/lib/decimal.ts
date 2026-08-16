import { Decimal } from "decimal.js";

export const decimal = (value: Decimal.Value | null | undefined) => new Decimal(value ?? 0);
export const moneyString = (value: Decimal.Value | null | undefined) =>
  decimal(value).toDecimalPlaces(2).toFixed(2);
export const quantityString = (value: Decimal.Value | null | undefined) =>
  decimal(value).toDecimalPlaces(3).toFixed(3);
