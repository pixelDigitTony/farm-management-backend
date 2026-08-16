import { decimal, moneyString, quantityString } from "../lib/decimal.js";

export type SlaughterQuoteInput = {
  raisingCost: number;
  liveWeightKg: number;
  carcassWeightKg: number;
  parts: Array<{
    name: string;
    classification: "MEAT" | "BYPRODUCT" | "WASTE";
    weightKg: number;
    pricePerKg?: number;
  }>;
  costs: Array<{ name: string; amount: number }>;
};

export function calculateSlaughter(input: SlaughterQuoteInput) {
  const usableWeight = input.parts
    .filter((part) => part.classification !== "WASTE")
    .reduce((total, part) => total.plus(part.weightKg), decimal(0));
  const wasteWeight = input.parts
    .filter((part) => part.classification === "WASTE")
    .reduce((total, part) => total.plus(part.weightKg), decimal(0));
  const slaughterCost = input.costs.reduce((total, cost) => total.plus(cost.amount), decimal(0));
  const totalCost = decimal(input.raisingCost).plus(slaughterCost);
  const costPerUsableKg = usableWeight.greaterThan(0)
    ? totalCost.dividedBy(usableWeight)
    : decimal(0);
  const expectedRevenue = input.parts.reduce(
    (total, part) => total.plus(decimal(part.weightKg).times(part.pricePerKg ?? 0)),
    decimal(0),
  );
  const accounted = usableWeight.plus(wasteWeight);
  return {
    usableWeightKg: quantityString(usableWeight),
    wasteWeightKg: quantityString(wasteWeight),
    unaccountedWeightKg: quantityString(decimal(input.liveWeightKg).minus(accounted)),
    slaughterCost: moneyString(slaughterCost),
    totalCost: moneyString(totalCost),
    costPerUsableKg: moneyString(costPerUsableKg),
    dressingPercentage: quantityString(
      decimal(input.carcassWeightKg)
        .dividedBy(input.liveWeightKg || 1)
        .times(100),
    ),
    usableYieldPercentage: quantityString(
      usableWeight.dividedBy(input.liveWeightKg || 1).times(100),
    ),
    expectedRevenue: moneyString(expectedRevenue),
    estimatedProfit: moneyString(expectedRevenue.minus(totalCost)),
    parts: input.parts.map((part) => ({
      ...part,
      allocatedCost: moneyString(costPerUsableKg.times(part.weightKg)),
      productionCostPerKg: moneyString(costPerUsableKg),
    })),
  };
}

export function calculateMenuPrice(input: {
  ingredients: Array<{ quantity: number; unitCost: number }>;
  additionalCosts?: number;
  servings: number;
  sellingPrice?: number;
  targetFoodCostPercent?: number;
}) {
  const ingredientCost = input.ingredients.reduce(
    (total, item) => total.plus(decimal(item.quantity).times(item.unitCost)),
    decimal(0),
  );
  const batchCost = ingredientCost.plus(input.additionalCosts ?? 0);
  const costPerServing = batchCost.dividedBy(input.servings || 1);
  const target = decimal(input.targetFoodCostPercent ?? 35).dividedBy(100);
  const suggestedPrice = target.greaterThan(0) ? costPerServing.dividedBy(target) : costPerServing;
  const sellingPrice = decimal(input.sellingPrice ?? 0);
  return {
    ingredientCost: moneyString(ingredientCost),
    batchCost: moneyString(batchCost),
    costPerServing: moneyString(costPerServing),
    suggestedPrice: moneyString(suggestedPrice),
    profitPerServing: moneyString(sellingPrice.minus(costPerServing)),
    foodCostPercent: sellingPrice.greaterThan(0)
      ? quantityString(costPerServing.dividedBy(sellingPrice).times(100))
      : "0.000",
  };
}

export function calculateRecipeIngredientUsage(
  batchQuantity: number | string,
  servingsSold: number,
  recipeYieldServings: number | string,
) {
  const recipeYield = decimal(recipeYieldServings);
  if (!recipeYield.greaterThan(0)) return "0";
  return decimal(batchQuantity).times(servingsSold).dividedBy(recipeYield).toString();
}
