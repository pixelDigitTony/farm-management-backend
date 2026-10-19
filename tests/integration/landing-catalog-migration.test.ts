import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Business, CatalogCategory, CatalogProduct, LandingPage } from "../../src/models/index.js";
import { migrateLandingCatalog } from "../../src/services/landing-catalog-migration.js";
import { seedBrowserFixtures } from "../support/seed.js";
import { startTestDatabase } from "./database.js";

let stop: (() => Promise<void>) | undefined;
let fixture: Awaited<ReturnType<typeof seedBrowserFixtures>>;
beforeAll(async () => {
  stop = await startTestDatabase();
  fixture = await seedBrowserFixtures();
  await LandingPage.collection.createIndex({ businessId: 1 }, { unique: true });
  await CatalogProduct.updateOne(
    { _id: fixture.products[0]?._id },
    { $set: { isActive: false, isOrderable: false } },
  );
  await CatalogProduct.updateOne(
    { _id: fixture.products[1]?._id },
    {
      $set: {
        availabilitySchedule: {
          mode: "CUSTOM_DATES",
          timezone: "Asia/Manila",
          dates: ["2040-01-01"],
        },
      },
    },
  );
});
afterAll(async () => {
  await stop?.();
});
describe("landing catalog migration rehearsal", () => {
  it("keeps dry runs read-only, safely replaces the old index, and is repeatable", async () => {
    const pageBefore = await LandingPage.findOne().lean();
    const before = await CatalogProduct.countDocuments({
      availabilitySchedule: { $exists: false },
    });
    const dry = await migrateLandingCatalog();
    expect(dry.conflicts).toEqual([]);
    expect(dry.productsWithoutSchedule).toBe(before);
    expect(await CatalogCategory.countDocuments()).toBe(0);
    await migrateLandingCatalog(true);
    const categories = await CatalogCategory.countDocuments();
    await migrateLandingCatalog(true);
    expect(await CatalogCategory.countDocuments()).toBe(categories);
    expect(await CatalogProduct.countDocuments({ availabilitySchedule: { $exists: false } })).toBe(
      0,
    );
    const inactive = await CatalogProduct.findById(fixture.products[0]?._id).lean();
    expect(inactive?.isActive).toBe(false);
    expect(inactive?.isOrderable).toBe(false);
    expect(
      (await CatalogProduct.findById(fixture.products[1]?._id).lean())?.availabilitySchedule.mode,
    ).toBe("CUSTOM_DATES");
    const pageAfter = await LandingPage.findById(pageBefore?._id).lean();
    expect(pageAfter?.slug).toBe(pageBefore?.slug);
    expect(pageAfter?.publishedSnapshot).toEqual(pageBefore?.publishedSnapshot);
    expect(pageAfter?.isLegacyDefault).toBe(true);
    expect(
      (await Business.findById(fixture.business._id).lean())?.landingCatalogMigrationVersion,
    ).toBe(1);
    expect(
      (await LandingPage.collection.indexes()).some(
        (index) => index.unique && Object.keys(index.key).length === 1 && index.key.businessId,
      ),
    ).toBe(false);
    await LandingPage.create({
      businessId: fixture.business._id,
      name: "Second",
      slug: "second-after-migration",
      siteTitle: "Second",
    });
    expect(await LandingPage.countDocuments({ businessId: fixture.business._id })).toBe(2);
  });
});
