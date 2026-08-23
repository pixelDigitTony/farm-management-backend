import { Decimal } from "decimal.js";

type DecimalInput = Decimal.Value | { toString(): string } | null | undefined;

export const decimal = (value: DecimalInput) =>
  new Decimal(value !== null && typeof value === "object" ? value.toString() : (value ?? 0));
export const moneyString = (value: DecimalInput) => decimal(value).toDecimalPlaces(2).toFixed(2);
export const quantityString = (value: DecimalInput) => decimal(value).toDecimalPlaces(3).toFixed(3);
