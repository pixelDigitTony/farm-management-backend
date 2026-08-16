import { Router } from "express";
import mongoose, { type Model } from "mongoose";
import { HttpError } from "../lib/http-error.js";
import { getOwner } from "../middleware/auth.js";
import {
  CashAccount,
  CashTransaction,
  Contact,
  CookingBatch,
  Expense,
  FeedUsageRecord,
  InventoryItem,
  InventoryLot,
  InventoryMovement,
  KarenderiyaSale,
  MenuItem,
  Pig,
  PigBatch,
  PiggerySale,
  PigMeasurement,
  Recipe,
  SlaughterRecord,
  SlaughterSetting,
} from "../models/index.js";

const resources: Record<string, Model<any>> = {
  contacts: Contact,
  "cash-accounts": CashAccount,
  "cash-transactions": CashTransaction,
  expenses: Expense,
  "pig-batches": PigBatch,
  pigs: Pig,
  "pig-measurements": PigMeasurement,
  "feed-usage": FeedUsageRecord,
  "slaughter-settings": SlaughterSetting,
  slaughters: SlaughterRecord,
  "piggery-sales": PiggerySale,
  "inventory-items": InventoryItem,
  "inventory-lots": InventoryLot,
  "inventory-movements": InventoryMovement,
  recipes: Recipe,
  "menu-items": MenuItem,
  "cooking-batches": CookingBatch,
  "karenderiya-sales": KarenderiyaSale,
};

export const resourceRouter = Router();
const getModel = (name: string) => {
  const model = resources[name];
  if (!model) throw new HttpError(404, "Unknown resource");
  return model;
};

const postingManagedResources = new Set([
  "cash-transactions",
  "expenses",
  "inventory-lots",
  "inventory-movements",
  "feed-usage",
  "slaughters",
  "piggery-sales",
  "cooking-batches",
  "karenderiya-sales",
]);
const postingManagedCreateResources = new Set([...postingManagedResources, "pigs"]);
const protectedUpdateFields: Record<string, Set<string>> = {
  pigs: new Set([
    "purchaseCost",
    "accumulatedCostCached",
    "latestWeightKgCached",
    "status",
    "statusDate",
    "statusReason",
  ]),
  "inventory-items": new Set(["currentStockCached"]),
};

async function findDeleteBlocker(
  resource: string,
  id: string,
  businessId: mongoose.Types.ObjectId,
) {
  const scoped = { businessId };
  const checks: Record<string, Array<[Model<any>, Record<string, unknown>, string]>> = {
    pigs: [
      [
        Expense,
        { ...scoped, "allocations.targetType": "PIG", "allocations.targetId": id },
        "purchase expenses",
      ],
      [PigMeasurement, { ...scoped, pigId: id }, "measurements"],
      [FeedUsageRecord, { ...scoped, pigId: id }, "feed usage"],
      [SlaughterRecord, { ...scoped, pigId: id }, "slaughter records"],
      [PiggerySale, { ...scoped, "items.pigId": id }, "sales"],
    ],
    "inventory-items": [
      [Recipe, { ...scoped, "ingredients.inventoryItemId": id }, "recipes"],
      [InventoryLot, { ...scoped, itemId: id }, "inventory lots"],
      [InventoryMovement, { ...scoped, itemId: id }, "inventory movements"],
      [PiggerySale, { ...scoped, "items.inventoryItemId": id }, "sales"],
    ],
    recipes: [
      [MenuItem, { ...scoped, recipeId: id }, "menu items"],
      [CookingBatch, { ...scoped, recipeId: id }, "cooking batches"],
    ],
    "menu-items": [
      [KarenderiyaSale, { ...scoped, "items.menuItemId": id }, "order transactions"],
      [CookingBatch, { ...scoped, menuItemId: id }, "cooking batches"],
    ],
  };
  for (const [model, filter, label] of checks[resource] ?? []) {
    if (await model.exists(filter)) return label;
  }
  return null;
}

resourceRouter.get("/:resource", async (request, response) => {
  const owner = getOwner(request);
  const model = getModel(request.params.resource);
  const page = Math.max(1, Number(request.query.page ?? 1));
  const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 50)));
  const filter: Record<string, unknown> = { businessId: owner.businessId };
  for (const [key, value] of Object.entries(request.query)) {
    if (["page", "limit", "sort"].includes(key) || typeof value !== "string") continue;
    if (key.endsWith("Date") && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const from = new Date(`${value}T00:00:00.000Z`);
      const to = new Date(from);
      to.setUTCDate(to.getUTCDate() + 1);
      filter[key] = { $gte: from, $lt: to };
    } else filter[key] = value;
  }
  const [items, total] = await Promise.all([
    model
      .find(filter)
      .sort((request.query.sort as string) || "-createdAt")
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    model.countDocuments(filter),
  ]);
  response.json({ items, page, limit, total, pages: Math.ceil(total / limit) });
});

resourceRouter.get("/:resource/:id", async (request, response) => {
  const owner = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(400, "Invalid record id");
  const item = await getModel(request.params.resource)
    .findOne({ _id: request.params.id, businessId: owner.businessId })
    .lean();
  if (!item) throw new HttpError(404, "Record not found");
  response.json(item);
});

resourceRouter.post("/:resource", async (request, response) => {
  const owner = getOwner(request);
  if (postingManagedCreateResources.has(request.params.resource))
    throw new HttpError(409, "Use the matching transaction operation to create this record safely");
  const item = await getModel(request.params.resource).create({
    ...request.body,
    businessId: owner.businessId,
  });
  response.status(201).json(item);
});

resourceRouter.patch("/:resource/:id", async (request, response) => {
  const owner = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(400, "Invalid record id");
  const model = getModel(request.params.resource);
  if (postingManagedResources.has(request.params.resource))
    throw new HttpError(409, "Use the matching transaction operation to edit this record safely");
  const before = await model
    .findOne({ _id: request.params.id, businessId: owner.businessId })
    .lean();
  if (!before) throw new HttpError(404, "Record not found");
  const { businessId: _ignored, _id: _ignoredId, ...updates } = request.body;
  const blockedFields = Object.keys(updates).filter((field) =>
    protectedUpdateFields[request.params.resource]?.has(field),
  );
  if (blockedFields.length)
    throw new HttpError(409, `Use the matching operation to change: ${blockedFields.join(", ")}`);
  const item = await model.findOneAndUpdate(
    { _id: request.params.id, businessId: owner.businessId },
    updates,
    { new: true, runValidators: true },
  );
  response.json(item);
});

resourceRouter.delete("/:resource/:id", async (request, response) => {
  const owner = getOwner(request);
  if (!mongoose.isValidObjectId(request.params.id)) throw new HttpError(400, "Invalid record id");
  if (postingManagedResources.has(request.params.resource))
    throw new HttpError(409, "Use the matching transaction operation to delete this record safely");
  const model = getModel(request.params.resource);
  const item = await model.findOne({ _id: request.params.id, businessId: owner.businessId }).lean();
  if (!item) throw new HttpError(404, "Record not found");
  const blocker = await findDeleteBlocker(
    request.params.resource,
    request.params.id,
    owner.businessId,
  );
  if (blocker) throw new HttpError(409, `This record is still used by ${blocker}`);
  await model.deleteOne({ _id: request.params.id, businessId: owner.businessId });
  if (request.params.resource === "menu-items" && item.recipeId) {
    const recipeStillUsed = await Promise.all([
      MenuItem.exists({ businessId: owner.businessId, recipeId: item.recipeId }),
      CookingBatch.exists({ businessId: owner.businessId, recipeId: item.recipeId }),
    ]);
    if (!recipeStillUsed.some(Boolean))
      await Recipe.deleteOne({ _id: item.recipeId, businessId: owner.businessId });
  }
  response.status(204).send();
});
