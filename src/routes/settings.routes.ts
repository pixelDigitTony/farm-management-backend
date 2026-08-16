import { Router } from "express";
import * as v from "valibot";
import { getOwner } from "../middleware/auth.js";
import { Business, SlaughterSetting, User } from "../models/index.js";

const optionalText = v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200)));
const settingsSchema = v.object({
  ownerName: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(100)),
  businessName: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(120)),
  piggeryName: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(120)),
  piggeryAddress: optionalText,
  karenderiyaName: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(120)),
  karenderiyaAddress: optionalText,
  inventoryValuationMethod: v.picklist(["FIFO", "WEIGHTED_AVERAGE"]),
  generalExpenseAllocation: v.picklist(["GENERAL_ONLY", "EQUAL_PER_ACTIVE_PIG", "MANUAL"]),
  defaultTargetFoodCostPercent: v.pipe(
    v.unknown(),
    v.toNumber(),
    v.number(),
    v.gtValue(0),
    v.maxValue(100),
  ),
  meatTransferPricingMethod: v.picklist(["PRODUCTION_COST", "OWNER_SET_PRICE"]),
});

const slaughterSettingsSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(120)),
  costItems: v.array(
    v.object({
      code: v.string(),
      name: v.pipe(v.string(), v.trim(), v.minLength(1)),
      calculationMethod: v.picklist(["FLAT", "PER_LIVE_KG", "PER_CARCASS_KG", "MANUAL"]),
      defaultRate: v.pipe(v.unknown(), v.toNumber(), v.number(), v.minValue(0)),
      isActive: v.optional(v.boolean(), true),
    }),
  ),
  meatParts: v.array(
    v.object({
      code: v.string(),
      name: v.pipe(v.string(), v.trim(), v.minLength(1)),
      classification: v.picklist(["MEAT", "BYPRODUCT", "WASTE"]),
      defaultExternalPricePerKg: v.pipe(v.unknown(), v.toNumber(), v.number(), v.minValue(0)),
      defaultKarenderiyaPricePerKg: v.pipe(v.unknown(), v.toNumber(), v.number(), v.minValue(0)),
      isUsableForCooking: v.optional(v.boolean(), true),
      isActive: v.optional(v.boolean(), true),
    }),
  ),
});

export const settingsRouter = Router();

settingsRouter.get("/", async (request, response) => {
  const owner = getOwner(request);
  const [business, user, slaughter] = await Promise.all([
    Business.findById(owner.businessId).lean(),
    User.findById(owner.userId).lean(),
    SlaughterSetting.findOne({ businessId: owner.businessId, isDefault: true }).lean(),
  ]);
  response.json({ business, user, slaughter });
});

settingsRouter.patch("/business", async (request, response) => {
  const owner = getOwner(request);
  const input = v.parse(settingsSchema, request.body);
  const [business, user] = await Promise.all([
    Business.findByIdAndUpdate(
      owner.businessId,
      {
        businessName: input.businessName,
        "piggery.name": input.piggeryName,
        "piggery.address": input.piggeryAddress,
        "karenderiya.name": input.karenderiyaName,
        "karenderiya.address": input.karenderiyaAddress,
        "settings.inventoryValuationMethod": input.inventoryValuationMethod,
        "settings.generalExpenseAllocation": input.generalExpenseAllocation,
        "settings.defaultTargetFoodCostPercent": input.defaultTargetFoodCostPercent,
        "settings.meatTransferPricingMethod": input.meatTransferPricingMethod,
      },
      { new: true, runValidators: true },
    ),
    User.findByIdAndUpdate(owner.userId, { name: input.ownerName }, { new: true }),
  ]);
  response.json({ business, user });
});

settingsRouter.put("/slaughter", async (request, response) => {
  const owner = getOwner(request);
  const input = v.parse(slaughterSettingsSchema, request.body);
  const setting = await SlaughterSetting.findOneAndUpdate(
    { businessId: owner.businessId, isDefault: true },
    { ...input, businessId: owner.businessId, isDefault: true },
    { new: true, upsert: true, runValidators: true },
  );
  response.json(setting);
});
