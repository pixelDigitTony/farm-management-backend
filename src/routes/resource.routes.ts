import { Router } from "express";
import mongoose, { type Model } from "mongoose";
import { HttpError } from "../lib/http-error.js";
import { resourceQuery, resourceUpdates } from "../lib/resource-input.js";
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
import { assertResourceReferences } from "../services/resource-reference.service.js";

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
  "cash-accounts": new Set(["currentBalanceCached", "openingBalance"]),
};

async function findDeleteBlocker(
  resource: string,
  id: string,
  businessId: mongoose.Types.ObjectId,
) {
  const scoped = { businessId };
  const checks: Record<string, Array<[Model<any>, Record<string, unknown>, string]>> = {
    "cash-accounts": [
      [
        CashTransaction,
        { ...scoped, $or: [{ accountId: id }, { fromAccountId: id }, { toAccountId: id }] },
        "cash transactions",
      ],
      [Expense, { ...scoped, paymentAccountIdCached: id }, "expense payments"],
    ],
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
  const fields = new Set(Object.keys(model.schema.paths));
  const { page, limit, filter: inputFilter, sort } = resourceQuery(request.query, fields);
  const filter: Record<string, unknown> = { ...inputFilter, businessId: owner.businessId };
  for (const [key, value] of Object.entries(inputFilter)) {
    if (key.endsWith("Date") && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const from = new Date(`${value}T00:00:00.000Z`);
      const to = new Date(from);
      to.setUTCDate(to.getUTCDate() + 1);
      filter[key] = { $gte: from, $lt: to };
    }
  }
  const [items, total] = await Promise.all([
    model
      .find(filter)
      .sort(sort)
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
  const input = resourceUpdates(request.body);
  if (request.params.resource === "inventory-items") input.currentStockCached = 0;
  if (request.params.resource === "cash-accounts")
    input.currentBalanceCached = input.openingBalance ?? 0;
  await assertResourceReferences(request.params.resource, input, owner.businessId);
  const item = await getModel(request.params.resource).create({
    ...input,
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
  const updates = resourceUpdates(request.body, protectedUpdateFields[request.params.resource]);
  await assertResourceReferences(request.params.resource, updates, owner.businessId);
  const item = await model.findOneAndUpdate(
    { _id: request.params.id, businessId: owner.businessId },
    { $set: updates },
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
