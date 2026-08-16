import { Router } from "express";
import * as v from "valibot";
import { calculateMenuPrice, calculateSlaughter } from "../services/calculation.service.js";
import { coercedNumber } from "../validation/helpers.js";

export const calculationRouter = Router();
const nonnegative = coercedNumber(0);

calculationRouter.post("/slaughter", (request, response) => {
  const input = v.parse(
    v.object({
      raisingCost: nonnegative,
      liveWeightKg: nonnegative,
      carcassWeightKg: nonnegative,
      parts: v.array(
        v.object({
          name: v.string(),
          classification: v.picklist(["MEAT", "BYPRODUCT", "WASTE"]),
          weightKg: nonnegative,
          pricePerKg: v.optional(nonnegative),
        }),
      ),
      costs: v.array(v.object({ name: v.string(), amount: nonnegative })),
    }),
    request.body,
  );
  response.json(calculateSlaughter(input));
});

calculationRouter.post("/menu-price", (request, response) => {
  const input = v.parse(
    v.object({
      ingredients: v.array(v.object({ quantity: nonnegative, unitCost: nonnegative })),
      additionalCosts: v.optional(nonnegative),
      servings: coercedNumber(0, false),
      sellingPrice: v.optional(nonnegative),
      targetFoodCostPercent: v.optional(v.pipe(coercedNumber(0, false), v.maxValue(100))),
    }),
    request.body,
  );
  response.json(calculateMenuPrice(input));
});
