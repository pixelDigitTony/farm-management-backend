import mongoose, { type Types } from "mongoose";
import { HttpError } from "../lib/http-error.js";
import { CatalogProduct, MenuItem } from "../models/index.js";

export function landingCatalogReferences(
  value: unknown,
): Array<{ sourceType: "MENU_ITEM" | "PRODUCT"; sourceId: string }> {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const refs: Array<{ sourceType: "MENU_ITEM" | "PRODUCT"; sourceId: string }> = [];
  if (
    (record.sourceType === "MENU_ITEM" || record.sourceType === "PRODUCT") &&
    typeof record.sourceId === "string"
  )
    refs.push({ sourceType: record.sourceType, sourceId: record.sourceId });
  if (record.type === "MENU" && record.content && typeof record.content === "object") {
    const ids = (record.content as Record<string, unknown>).menuItemIds;
    if (Array.isArray(ids))
      for (const id of ids) refs.push({ sourceType: "MENU_ITEM", sourceId: String(id) });
  }
  for (const item of Object.values(record))
    if (item && typeof item === "object") refs.push(...landingCatalogReferences(item));
  return refs;
}
export async function assertLandingCatalogReferences(value: unknown, businessId: Types.ObjectId) {
  const refs = landingCatalogReferences(value);
  if (refs.some((r) => !mongoose.isValidObjectId(r.sourceId)))
    throw new HttpError(422, "Select valid business-owned catalog items");
  for (const type of ["PRODUCT", "MENU_ITEM"] as const) {
    const ids = [...new Set(refs.filter((r) => r.sourceType === type).map((r) => r.sourceId))];
    const model = type === "PRODUCT" ? CatalogProduct : MenuItem;
    if (
      ids.length &&
      (await model.countDocuments({ _id: { $in: ids }, businessId })) !== ids.length
    )
      throw new HttpError(
        422,
        "A catalog item does not belong to this business or has been deleted",
      );
  }
}
