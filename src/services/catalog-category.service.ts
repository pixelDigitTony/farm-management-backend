import type { Types } from "mongoose";
import { effectiveActive } from "../lib/product-availability.js";
import { CatalogCategory, CatalogProduct, MenuItem } from "../models/index.js";

export const normalizeCategoryName = (name: string) =>
  name.normalize("NFKC").trim().toLocaleLowerCase("en-US");
export async function resolveCategory(
  businessId: Types.ObjectId,
  sourceType: "PRODUCT" | "MENU_ITEM",
  label = "",
) {
  const name = label.normalize("NFKC").trim();
  const normalizedName = name ? `label:${normalizeCategoryName(name)}` : "__uncategorized__";
  const filter = { businessId, sourceType, normalizedName };
  try {
    return await CatalogCategory.findOneAndUpdate(
      filter,
      { $setOnInsert: { ...filter, name: name || "Uncategorized", isUncategorized: !name } },
      { upsert: true, new: true },
    ).lean();
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    return CatalogCategory.findOne(filter).lean();
  }
}
// Also adapts legacy menu writes that still store only the category label.
export async function catalogCategories(businessId: Types.ObjectId, now = new Date()) {
  const [products, menus] = await Promise.all([
    CatalogProduct.find({ businessId })
      .select("category categoryId isActive availabilitySchedule")
      .lean(),
    MenuItem.find({ businessId }).select("category categoryId isActive showOnLandingPage").lean(),
  ]);
  const entries = [
    ...products.map((item) => ({ item, sourceType: "PRODUCT" as const })),
    ...menus.map((item) => ({ item, sourceType: "MENU_ITEM" as const })),
  ];
  const resolved = new Map<string, any>();
  const counts = new Map<string, { total: number; activeNow: number }>();
  for (const { item, sourceType } of entries) {
    const key = `${sourceType}:${normalizeCategoryName(item.category ?? "")}`;
    if (!resolved.has(key))
      resolved.set(key, await resolveCategory(businessId, sourceType, item.category ?? ""));
    const category = resolved.get(key);
    if (!category) continue;
    const id = String(category._id);
    const count = counts.get(id) ?? { total: 0, activeNow: 0 };
    count.total++;
    if (
      sourceType === "PRODUCT"
        ? effectiveActive(item, now)
        : item.isActive !== false && item.showOnLandingPage !== false
    )
      count.activeNow++;
    counts.set(id, count);
    if (String(item.categoryId ?? "") !== id) {
      const model = sourceType === "PRODUCT" ? CatalogProduct : MenuItem;
      await model.updateOne(
        { _id: item._id, businessId, category: item.category },
        { $set: { categoryId: category._id } },
      );
    }
  }
  const categories = await CatalogCategory.find({ businessId, isArchived: false })
    .sort({ sourceType: 1, name: 1 })
    .lean();
  return categories.map((category) => ({
    ...category,
    ...(counts.get(String(category._id)) ?? { total: 0, activeNow: 0 }),
  }));
}
