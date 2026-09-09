import mongoose, { type Types } from "mongoose";
import { HttpError } from "../lib/http-error.js";
import { Contact, InventoryItem, Pig, PigBatch, Recipe } from "../models/index.js";

type ReferenceModel = {
  countDocuments(filter: {
    businessId: Types.ObjectId;
    _id: { $in: string[] };
  }): PromiseLike<number>;
};
type ReferenceRule = { field: string; model: ReferenceModel; label: string; array?: string };

// Only generic-write resources belong here. Posting-operation policies are handled separately.
const rules: Record<string, ReferenceRule[]> = {
  "pig-batches": [{ field: "sourceContactId", model: Contact, label: "Source contact" }],
  pigs: [
    { field: "batchId", model: PigBatch, label: "Pig batch" },
    { field: "sourceContactId", model: Contact, label: "Source contact" },
  ],
  "pig-measurements": [
    { field: "pigId", model: Pig, label: "Pig" },
    { field: "batchId", model: PigBatch, label: "Pig batch" },
  ],
  recipes: [
    { array: "ingredients", field: "inventoryItemId", model: InventoryItem, label: "Ingredient" },
  ],
  "menu-items": [{ field: "recipeId", model: Recipe, label: "Recipe" }],
};

export async function assertResourceReferences(
  resource: string,
  input: Record<string, unknown>,
  businessId: Types.ObjectId,
) {
  for (const rule of rules[resource] ?? []) {
    let values: unknown[];
    if (rule.array) {
      if (!(rule.array in input)) continue;
      const rows = input[rule.array];
      if (!Array.isArray(rows)) throw new HttpError(422, `${rule.array} must be an array`);
      values = rows.map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row))
          throw new HttpError(422, `Invalid ${rule.label.toLowerCase()} reference`);
        return row[rule.field];
      });
    } else {
      if (!(rule.field in input) || input[rule.field] == null) continue;
      values = [input[rule.field]];
    }
    const ids = new Set<string>();
    for (const value of values) {
      if (typeof value !== "string" || !mongoose.isObjectIdOrHexString(value))
        throw new HttpError(422, `Invalid ${rule.label.toLowerCase()} reference`);
      ids.add(value.toLowerCase());
    }
    if (!ids.size) continue;
    const count = await rule.model.countDocuments({ businessId, _id: { $in: [...ids] } });
    if (count !== ids.size)
      throw new HttpError(422, `${rule.label} was not found in this business`);
  }
}
