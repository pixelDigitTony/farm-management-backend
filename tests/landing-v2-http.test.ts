import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoredImage } from "../src/models/image.models.js";
import {
  Business,
  CatalogMyDayCampaign,
  CatalogProduct,
  LandingOperation,
  LandingPage,
  LandingPageSavedTemplate,
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
vi.mock("../src/lib/transaction.js", () => ({ inTransaction: (work: () => unknown) => work() }));
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
  const operations = new Map<string, any>();
  vi.spyOn(LandingOperation, "findOne").mockImplementation(
    (filter: any) => ({ lean: async () => operations.get(filter.key) ?? null }) as any,
  );
  vi.spyOn(LandingOperation, "create").mockImplementation((async (record: any) => {
    operations.set(record.key, record);
    return record;
  }) as any);
  vi.spyOn(LandingPage, "findOneAndUpdate").mockImplementation((async (
    filter: any,
    update: any,
  ) => {
    if (!matches(page, filter)) return null;
    page.set(update.$set);
    page.revision += update.$inc?.revision ?? 0;
    return page;
  }) as any);
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
  vi.spyOn(Business, "findOne").mockReturnValue({
    select: () => ({ lean: async () => ({ timezone: "Asia/Manila" }) }),
  } as any);
  vi.spyOn(CatalogMyDayCampaign, "find").mockReturnValue({ lean: async () => [] } as any);
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
    const hero = created.sections[1].components[0];
    hero.content.title = "My edited headline";
    hero.appearance.typography = {
      heading: { fontFamily: "PLAYFAIR_DISPLAY", fontWeight: 600, fontStyle: "italic" },
      label: { fontFamily: "INTER" },
    };
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
    vi.spyOn(LandingPageVariant, "find").mockImplementation(
      (filter: any) =>
        ({
          sort: () => ({
            lean: async () =>
              [...documents.values()].filter((d) => matches(d, filter)).map((d) => d.toObject()),
          }),
        }) as any,
    );
    vi.spyOn(Business, "findById").mockReturnValue({
      lean: async () => ({ businessName: "Merchant" }),
      select: () => ({ lean: async () => ({ timezone: "Asia/Manila" }) }),
    } as any);
    const reloaded = (await request(app).get("/api/landing-page").expect(200)).body;
    expect(reloaded.variants.find((doc: any) => doc._id === saved._id).sections).toEqual(
      saved.sections,
    );
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
    let storedTemplate: InstanceType<typeof LandingPageSavedTemplate> | undefined;
    vi.spyOn(LandingPageSavedTemplate, "create").mockImplementation((async (record: any) => {
      storedTemplate = new LandingPageSavedTemplate(record);
      return storedTemplate;
    }) as any);
    vi.spyOn(LandingPageSavedTemplate, "findOne").mockImplementation(
      (filter: any) =>
        query(
          storedTemplate && matches(storedTemplate, filter) ? storedTemplate.toObject() : null,
        ) as any,
    );
    vi.spyOn(LandingPageVariant, "updateOne").mockResolvedValue({ matchedCount: 1 } as any);
    const template = (
      await request(app)
        .post("/api/landing-page/saved-templates")
        .set("Idempotency-Key", "test-typography-template")
        .send({
          name: "Reusable typography",
          sourceVariantId: saved._id,
          expectedVariantRevision: saved.revision,
        })
        .expect(201)
    ).body;
    expect(template.document.sections).toEqual(saved.sections);
    const applied = (
      await request(app)
        .post("/api/landing-page/variants")
        .send({ name: "From template", savedTemplateId: template._id })
        .expect(201)
    ).body;
    expect(applied.sections).toEqual(saved.sections);
    await request(app).post(`/api/landing-page/variants/${saved._id}/publish`).expect(200);
    // Publication prepares content; activation is an independent owner action.
    expect(page.publicAccess.mode).toBe("INACTIVE");
    await request(app).get("/api/public/landing-pages/isolated-store").expect(404);
    page.publicAccess = {
      mode: "IMMEDIATE",
      startsAt: null,
      endsAt: null,
      timezone: "Asia/Manila",
    };
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

describe("owned public access HTTP contract", () => {
  const path = "/api/landing-page/pages/507f1f77bcf86cd799439030/access";
  it("activates independently, checks revision, preserves snapshot, and replays a retry", async () => {
    const variant = await create();
    await request(app).post(`/api/landing-page/variants/${variant._id}/publish`).expect(200);
    const snapshot = json(page.publishedSnapshot);
    const input = {
      mode: "IMMEDIATE",
      timezone: "Asia/Manila",
      expectedPageRevision: page.revision,
    };
    const first = await request(app)
      .patch(path)
      .set("Idempotency-Key", "access_operation_12345")
      .send(input)
      .expect(200);
    expect(first.body.isAccessible).toBe(true);
    expect(json(page.publishedSnapshot)).toEqual(snapshot);
    const revision = page.revision;
    await request(app)
      .patch(path)
      .set("Idempotency-Key", "access_operation_12345")
      .send(input)
      .expect(200);
    expect(page.revision).toBe(revision);
    await request(app)
      .patch(path)
      .set("Idempotency-Key", "different_operation_123")
      .send(input)
      .expect(409);
    await request(app).get("/api/public/landing-pages/isolated-store").expect(200);
    await request(app)
      .patch(path)
      .set("Idempotency-Key", "disable_operation_1234")
      .send({ ...input, mode: "INACTIVE", expectedPageRevision: revision })
      .expect(200);
    await request(app).get("/api/public/landing-pages/isolated-store").expect(404);
    expect(json(page.publishedSnapshot)).toEqual(snapshot);
  });
  it("denies activation without publication and a different owner's page", async () => {
    await request(app)
      .patch(path)
      .set("Idempotency-Key", "access_operation_12345")
      .send({ mode: "IMMEDIATE", timezone: "UTC", expectedPageRevision: 1 })
      .expect(422);
    await request(app)
      .patch(path.replace("507f1f77bcf86cd799439030", "507f1f77bcf86cd799439031"))
      .set("Idempotency-Key", "access_operation_23456")
      .send({ mode: "INACTIVE", timezone: "UTC", expectedPageRevision: 1 })
      .expect(404);
  });
});
