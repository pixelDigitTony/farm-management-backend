import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoredImage } from "../src/models/image.models.js";
import {
  Business,
  CatalogProduct,
  LandingPage,
  LandingPageVariant,
  MenuItem,
} from "../src/models/index.js";
import { landingPagePublicRouter, landingPageRouter } from "../src/routes/landing-page.routes.js";
import { filterPublishedCatalogItems } from "../src/services/commerce.service.js";

const fixtures = vi.hoisted(() => ({
  businessId: "507f1f77bcf86cd799439010",
  userId: "507f1f77bcf86cd799439020",
  productId: "507f1f77bcf86cd799439011",
}));
vi.mock("../src/middleware/auth.js", () => ({
  getOwner: () => ({
    businessId: new mongoose.Types.ObjectId(fixtures.businessId),
    userId: new mongoose.Types.ObjectId(fixtures.userId),
  }),
}));
vi.mock("../src/services/catalog-category.service.js", () => ({
  catalogCategories: async () => [],
}));
vi.mock("../src/services/commerce.service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/services/commerce.service.js")>();
  const catalog = [
    {
      key: `PRODUCT:${fixtures.productId}`,
      sourceType: "PRODUCT",
      sourceId: fixtures.productId,
      name: "Merchant product",
      mediaUrls: [],
      price: 100,
      variants: [],
      isAvailable: true,
      isFeatured: true,
    },
  ];
  return {
    ...original,
    getBuilderCatalogItems: async () => catalog,
    getLandingMenuItems: async () => [],
    getPublishedCatalogItems: async (_: unknown, snapshot: unknown) =>
      original.filterPublishedCatalogItems(snapshot, catalog),
  };
});
const app = express();
app.use(express.json());
app.use("/api/landing-page", landingPageRouter);
app.use("/api/public", landingPagePublicRouter);
app.use(
  (
    error: any,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) =>
    response
      .status(error.status ?? (error.name === "ValiError" ? 422 : 500))
      .json({ message: error.message, code: error.code }),
);
let page: any;
let documents: Map<string, any>;
const json = (doc: any) => JSON.parse(JSON.stringify(doc));
const query = (doc: any) => ({
  lean: async () => (doc ? json(doc) : null),
  // biome-ignore lint/suspicious/noThenProperty: Mongoose queries are intentionally awaitable thenables; this adapter reproduces that interface.
  then: (resolve: any, reject: any) => Promise.resolve(doc).then(resolve, reject),
});
function matches(doc: any, filter: any): boolean {
  return Object.entries(filter).every(([key, value]) =>
    key === "$or"
      ? (value as any[]).some((item) => matches(doc, item))
      : key === "schemaVersion" && typeof value === "object"
        ? doc.schemaVersion !== 2
        : value && typeof value === "object" && "$ne" in value
          ? doc[key] !== value.$ne
          : key === "publishedSnapshot"
            ? Boolean(doc.publishedSnapshot)
            : String(doc[key]) === String(value),
  );
}
beforeEach(() => {
  documents = new Map();
  page = new LandingPage({
    _id: "507f1f77bcf86cd799439030",
    businessId: fixtures.businessId,
    slug: "isolated-store",
    siteTitle: "Merchant",
    seoDescription: "",
    isPublished: false,
    isLegacyDefault: true,
  });
  vi.spyOn(LandingPage, "findOne").mockImplementation(
    (filter: any) => query(matches(page, filter) ? page : null) as any,
  );
  vi.spyOn(CatalogProduct, "find").mockReturnValue({
    select: () => ({ lean: async () => [] }),
  } as any);
  vi.spyOn(LandingPage.prototype, "save").mockImplementation(async function (this: any) {
    return this;
  });
  vi.spyOn(Business, "findById").mockReturnValue({
    lean: async () => ({ businessName: "Merchant" }),
  } as any);
  vi.spyOn(Business, "exists").mockResolvedValue({
    _id: new mongoose.Types.ObjectId(fixtures.businessId),
  });
  vi.spyOn(LandingPageVariant, "create").mockImplementation((async (record: any) => {
    const doc = new LandingPageVariant(record);
    documents.set(String(doc._id), doc);
    return doc;
  }) as any);
  vi.spyOn(LandingPageVariant, "findOne").mockImplementation(
    (filter: any) => query([...documents.values()].find((d) => matches(d, filter)) ?? null) as any,
  );
  vi.spyOn(LandingPageVariant, "findOneAndUpdate").mockImplementation((async (
    filter: any,
    update: any,
  ) => {
    const doc = [...documents.values()].find((d) => matches(d, filter));
    if (!doc) return null;
    doc.set(update.$set);
    for (const [key, value] of Object.entries(update.$inc ?? {}))
      doc.set(key, (doc.get(key) ?? 0) + Number(value));
    for (const key of Object.keys(update.$unset ?? {})) doc.set(key, undefined);
    return doc;
  }) as any);
  vi.spyOn(LandingPageVariant.prototype, "save").mockImplementation(async function (this: any) {
    documents.set(String(this._id), this);
    return this;
  });
  vi.spyOn(CatalogProduct, "countDocuments").mockImplementation(
    (filter: any) =>
      query(
        String(filter.businessId) === fixtures.businessId
          ? filter._id.$in.filter((id: string) => id === fixtures.productId).length
          : 0,
      ) as any,
  );
  vi.spyOn(MenuItem, "countDocuments").mockResolvedValue(0);
  vi.spyOn(StoredImage, "countDocuments").mockImplementation(
    (filter: any) =>
      query(
        String(filter.businessId) === fixtures.businessId
          ? filter._id.$in.filter((id: string) => id === "507f1f77bcf86cd799439040").length
          : 0,
      ) as any,
  );
});
afterEach(() => vi.restoreAllMocks());
const create = async (templateId = "farm-and-market", templateRevision?: number) =>
  (
    await request(app)
      .post("/api/landing-page/variants")
      .send({ name: "My storefront", templateId, templateRevision, goal: "SHOP" })
      .expect(201)
  ).body;
describe("V2 HTTP contracts with isolated model adapters (no database)", () => {
  it("round-trips metadata, nested edits and inactive modes through save, duplicate, publish and public read; reset preserves the live snapshot", async () => {
    const created = await create();
    const image = {
      url: "/api/images/507f1f77bcf86cd799439040",
      alt: "Merchant backdrop",
      focalPoint: { x: 0.2, y: 0.8 },
      aspectRatio: "WIDE",
    };
    created.theme.background.image = image;
    created.theme.background.mode = "COLOR";
    created.sections[1].components[0].content.title = "My edited headline";
    const saved = (
      await request(app)
        .patch(`/api/landing-page/variants/${created._id}`)
        .send(created)
        .expect(200)
    ).body;
    expect(saved.schemaVersion).toBe(2);
    expect(saved.template).toEqual({ id: "farm-and-market", revision: 2 });
    expect(saved.goal).toBe("SHOP");
    expect(saved.theme.background.image).toEqual(image);
    expect(saved.theme.background.threeD).toEqual(created.theme.background.threeD);
    expect(saved.sections).toEqual(created.sections);
    const duplicate = (
      await request(app)
        .post("/api/landing-page/variants")
        .send({ name: "A copy", duplicateFromId: saved._id })
        .expect(201)
    ).body;
    expect(duplicate._id).not.toBe(saved._id);
    expect(duplicate.template).toEqual(saved.template);
    expect(duplicate.theme).toEqual(saved.theme);
    expect(duplicate.sections).toEqual(saved.sections);
    await request(app).post(`/api/landing-page/variants/${saved._id}/publish`).expect(200);
    const snapshot = json(page.publishedSnapshot);
    const read = (await request(app).get("/api/public/landing-pages/isolated-store").expect(200))
      .body;
    expect(read.variant.template).toEqual(saved.template);
    expect(read.variant.theme.background).toEqual(saved.theme.background);
    expect(read.variant.sections).toEqual(saved.sections);
    const reset = (
      await request(app).patch(`/api/landing-page/variants/${saved._id}/reset`).expect(200)
    ).body;
    expect(reset._id).toBe(saved._id);
    expect(reset.name).toBe("My storefront");
    expect(reset.template).toEqual(saved.template);
    expect(reset.theme.background.mode).toBe("THREE_D");
    expect(json(page.publishedSnapshot)).toEqual(snapshot);
  });
  it("rejects an old-client downgrade before stripping any V2 fields", async () => {
    const doc = await create("everyday-boutique");
    const before = json(doc);
    delete doc.schemaVersion;
    delete doc.template;
    delete doc.goal;
    await request(app).patch(`/api/landing-page/variants/${doc._id}`).send(doc).expect(409);
    expect(json(documents.get(doc._id)).theme).toEqual(before.theme);
    expect(json(documents.get(doc._id)).sections).toEqual(before.sections);
  });
  it("checks ownership recursively, including inactive background images and story/catalog references", async () => {
    const doc = await create();
    doc.theme.background.image = {
      url: "/api/images/507f1f77bcf86cd799439041",
      alt: "Foreign image",
      focalPoint: { x: 0.5, y: 0.5 },
      aspectRatio: "AUTO",
    };
    await request(app).patch(`/api/landing-page/variants/${doc._id}`).send(doc).expect(422);
    delete doc.theme.background.image;
    const catalog = doc.sections
      .flatMap((s: any) => s.components)
      .find((c: any) => c.type === "CATALOG");
    catalog.content.catalogItemRefs = [
      { sourceType: "PRODUCT", sourceId: "507f1f77bcf86cd799439099" },
    ];
    delete catalog.content.categoryBinding;
    await request(app).patch(`/api/landing-page/variants/${doc._id}`).send(doc).expect(422);
    expect(CatalogProduct.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: new mongoose.Types.ObjectId(fixtures.businessId) }),
    );
  });
  it("restores the recorded historical revision rather than opting a saved variant into 3D", async () => {
    const doc = await create("bold-market", 1);
    const reset = (
      await request(app).patch(`/api/landing-page/variants/${doc._id}/reset`).expect(200)
    ).body;
    expect(reset.template.revision).toBe(1);
    expect(reset.theme.background).toBeUndefined();
  });
  it("limits exposed/orderable references to enabled V2 bindings while retaining legacy behavior", () => {
    const items = [
      { sourceType: "PRODUCT", sourceId: "one" },
      { sourceType: "PRODUCT", sourceId: "two" },
      { sourceType: "MENU_ITEM", sourceId: "meal" },
    ];
    const snapshot = {
      schemaVersion: 2,
      sections: [
        {
          enabled: true,
          components: [
            { type: "CATALOG", enabled: true, content: { catalogItemRefs: [items[0]] } },
            { type: "MENU", enabled: false, content: { menuItemIds: [] } },
          ],
        },
      ],
    };
    expect(filterPublishedCatalogItems(snapshot, items)).toEqual([items[0]]);
    expect(filterPublishedCatalogItems({ ...snapshot, schemaVersion: 1 }, items)).toEqual(items);
    snapshot.sections[0]!.components[0]!.content.catalogItemRefs = [];
    expect(filterPublishedCatalogItems(snapshot, items)).toEqual(items);
  });
});
