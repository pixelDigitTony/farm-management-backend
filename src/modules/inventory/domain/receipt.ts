import { decimal } from "../../../lib/decimal.js";
import { DomainValidationError } from "../../../lib/domain-error.js";

export function calculateInventoryReceipt(input: {
  quantity?: number;
  unitCost?: number;
  purchaseQuantity?: number;
  measurementPerPurchaseUnit?: number;
  totalPurchaseCost?: number;
}) {
  const usesSeparatedInputs =
    input.purchaseQuantity !== undefined ||
    input.measurementPerPurchaseUnit !== undefined ||
    input.totalPurchaseCost !== undefined;
  if (
    usesSeparatedInputs &&
    (input.purchaseQuantity === undefined ||
      input.measurementPerPurchaseUnit === undefined ||
      input.totalPurchaseCost === undefined)
  )
    throw new DomainValidationError(
      "Enter the purchased quantity, measurement per purchased unit, and total purchase cost",
    );
  if (!usesSeparatedInputs && (input.quantity === undefined || input.unitCost === undefined))
    throw new DomainValidationError("Enter the receipt quantity and unit cost");

  const purchaseQuantity = decimal(input.purchaseQuantity ?? input.quantity ?? 0);
  const measurementPerPurchaseUnit = decimal(input.measurementPerPurchaseUnit ?? 1);
  const baseQuantity = purchaseQuantity.times(measurementPerPurchaseUnit);
  const totalCost = usesSeparatedInputs
    ? decimal(input.totalPurchaseCost ?? 0)
    : purchaseQuantity.times(input.unitCost ?? 0);
  if (
    !baseQuantity.isFinite() ||
    !baseQuantity.greaterThan(0) ||
    !totalCost.isFinite() ||
    totalCost.lessThan(0)
  )
    throw new DomainValidationError(
      "Receipt quantity must be positive and cost must be nonnegative",
    );
  const baseUnitCost = totalCost.dividedBy(baseQuantity);
  return {
    usesSeparatedInputs,
    purchaseQuantity,
    measurementPerPurchaseUnit,
    baseQuantity,
    baseUnitCost,
    totalCost,
  };
}

export function calculateReceiptCorrection(
  oldInitialValue: Parameters<typeof decimal>[0],
  oldRemainingValue: Parameters<typeof decimal>[0],
  newQuantityValue: Parameters<typeof decimal>[0],
  itemChanged: boolean,
) {
  const oldInitial = decimal(oldInitialValue);
  const oldRemaining = decimal(oldRemainingValue);
  const consumed = oldInitial.minus(oldRemaining);
  const newQuantity = decimal(newQuantityValue);
  if (newQuantity.lessThan(consumed))
    throw new DomainValidationError(
      `Quantity cannot be less than ${consumed.toString()} because that stock has already been used`,
    );
  if (itemChanged && !consumed.isZero())
    throw new DomainValidationError(
      "The inventory item cannot be changed after stock from this lot was used",
    );
  return {
    consumed,
    newRemaining: newQuantity.minus(consumed),
    stockDelta: newQuantity.minus(oldInitial),
  };
}
