import fc from "fast-check";
import { expect, it } from "vitest";
import {
  calculateInventoryReceipt,
  calculateReceiptCorrection,
} from "../src/modules/inventory/domain/receipt.js";

it("preserves purchased quantity and total cost across unit conversions", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 10000 }),
      fc.integer({ min: 1, max: 1000 }),
      fc.integer({ min: 0, max: 10000000 }),
      (quantity, unitSize, cents) => {
        const result = calculateInventoryReceipt({
          purchaseQuantity: quantity,
          measurementPerPurchaseUnit: unitSize,
          totalPurchaseCost: cents / 100,
        });
        expect(result.baseQuantity.toNumber()).toBe(quantity * unitSize);
        expect(result.totalCost.toNumber()).toBe(cents / 100);
        expect(result.baseUnitCost.isFinite()).toBe(true);
      },
    ),
    { seed: 20260906, numRuns: 300 },
  );
});

it("a valid receipt correction never recreates already-consumed stock", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 10000 }),
      fc.integer({ min: 0, max: 10000 }),
      fc.integer({ min: 0, max: 10000 }),
      (consumed, remaining, replacement) => {
        const result = calculateReceiptCorrection(
          consumed + remaining,
          remaining,
          consumed + replacement,
          false,
        );
        expect(result.consumed.toNumber()).toBe(consumed);
        expect(result.newRemaining.toNumber()).toBe(replacement);
      },
    ),
    { seed: 20260906, numRuns: 300 },
  );
});
