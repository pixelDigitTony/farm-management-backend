import { alwaysAvailable, validTimezone } from "../lib/product-availability.js";
import {
  Business,
  CatalogCategory,
  CatalogProduct,
  LandingOperation,
  LandingPage,
  LandingPageSavedTemplate,
  LandingPageVariant,
} from "../models/index.js";
import { catalogCategories } from "./catalog-category.service.js";

export async function migrateLandingCatalog(apply = false) {
  const pages = await LandingPage.find().sort({ createdAt: 1 }).lean();
  const businesses = await Business.find().select("timezone").lean();
  const slugs = new Set<string>();
  const conflicts: string[] = [];
  for (const page of pages) {
    const slug = String(page.slug).trim().toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slugs.has(slug) || slug !== page.slug)
      conflicts.push(`Page ${page._id}: malformed or colliding slug`);
    slugs.add(slug);
  }
  for (const business of businesses)
    if (!validTimezone(business.timezone ?? "Asia/Manila"))
      conflicts.push(`Business ${business._id}: invalid timezone`);
  const report = {
    version: 1,
    mode: apply ? "apply" : "dry-run",
    businesses: businesses.length,
    pages: pages.length,
    productsWithoutSchedule: await CatalogProduct.countDocuments({
      availabilitySchedule: { $exists: false },
    }),
    conflicts,
  };
  if (!apply) return report;
  if (conflicts.length)
    throw new Error(
      `Resolve migration preflight conflicts before applying: ${conflicts.join("; ")}`,
    );
  for (const business of businesses) {
    await catalogCategories(business._id);
    await CatalogProduct.updateMany(
      { businessId: business._id, availabilitySchedule: { $exists: false } },
      { $set: { availabilitySchedule: alwaysAvailable(business.timezone) } },
    );
    const owned = pages.filter((p) => String(p.businessId) === String(business._id));
    const first = owned[0];
    if (first && !owned.some((p) => p.isLegacyDefault))
      await LandingPage.updateOne({ _id: first._id }, { $set: { isLegacyDefault: true } });
  }
  for (const model of [CatalogProduct, LandingPage, LandingPageVariant, LandingPageSavedTemplate])
    await model.updateMany({ revision: { $exists: false } }, { $set: { revision: 1 } });
  // Deliberate index replacement; syncIndexes could remove unrelated indexes.
  const indexes = await LandingPage.collection.indexes();
  const old = indexes.find(
    (index) => index.unique && Object.keys(index.key).length === 1 && index.key.businessId === 1,
  );
  if (old?.name) await LandingPage.collection.dropIndex(old.name);
  for (const model of [
    LandingPage,
    LandingPageVariant,
    CatalogCategory,
    LandingPageSavedTemplate,
    LandingOperation,
  ])
    await model.createIndexes();
  await Business.updateMany({}, { $set: { landingCatalogMigrationVersion: 1 } });
  return report;
}
