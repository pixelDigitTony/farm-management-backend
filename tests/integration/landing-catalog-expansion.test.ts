import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import {
  Business,
  CatalogCategory,
  CatalogProduct,
  LandingPage,
  LandingPageSavedTemplate,
  LandingPageVariant,
  User,
} from "../../src/models/index.js";
import { seedBrowserFixtures, testCredentials } from "../support/seed.js";
import { startTestDatabase } from "./database.js";

let stop: (() => Promise<void>) | undefined;
let token: string, otherToken: string;
let fixture: Awaited<ReturnType<typeof seedBrowserFixtures>>;
let first: any, second: any, saved: any;
const key = () => randomUUID();
const auth = (
  method: "get" | "post" | "patch" | "put" | "delete",
  path: string,
  body?: Record<string, unknown>,
  authToken = token,
  idempotencyKey = key(),
) =>
  request(app)
    [method](`/api${path}`)
    .auth(authToken, { type: "bearer" })
    .set("Idempotency-Key", idempotencyKey)
    .send(body);
async function create(name: string, slug: string) {
  return (
    await auth("post", "/landing-page/pages", { name, slug, templateId: "farm-and-market" }).expect(
      201,
    )
  ).body;
}
async function publish(data: any, idempotencyKey = key()) {
  return (
    await auth(
      "post",
      `/landing-page/pages/${data.page._id}/publish`,
      {
        variantId: data.variant._id,
        expectedVariantRevision: data.variant.revision ?? 1,
        expectedPageRevision: data.page.revision ?? 1,
      },
      token,
      idempotencyKey,
    ).expect(200)
  ).body;
}
beforeAll(async () => {
  stop = await startTestDatabase();
  fixture = await seedBrowserFixtures();
  token = (
    await request(app)
      .post("/api/auth/login")
      .send({ method: "EMAIL_PASSWORD", ...testCredentials })
      .expect(200)
  ).body.token;
  const business = await Business.create({
    businessName: "Other business",
    businessNameNormalized: "other business",
  });
  await User.create({
    businessId: business._id,
    name: "Other Owner",
    email: "other@example.test",
    emailNormalized: "other@example.test",
    phone: "+639171234599",
    phoneNormalized: "+639171234599",
    passwordHash: fixture.user.passwordHash,
    mpinHash: fixture.user.mpinHash,
    emailVerifiedAt: new Date(),
    isApproved: true,
    status: "ACTIVE",
    role: 0,
  });
  otherToken = (
    await request(app)
      .post("/api/auth/login")
      .send({
        method: "EMAIL_PASSWORD",
        email: "other@example.test",
        password: testCredentials.password,
      })
      .expect(200)
  ).body.token;
});
afterAll(async () => {
  await stop?.();
});

describe("landing catalog expansion: real persistence and tenant boundaries", () => {
  it("atomically creates two pages and replays page creation without duplicates", async () => {
    const operationKey = key();
    const input = { name: "Farm shop", slug: "farm-shop", templateId: "farm-and-market" };
    first = (await auth("post", "/landing-page/pages", input, token, operationKey).expect(201))
      .body;
    const replay = (
      await auth("post", "/landing-page/pages", input, token, operationKey).expect(201)
    ).body;
    expect(replay.page._id).toBe(first.page._id);
    expect(await LandingPage.countDocuments({ slug: "farm-shop" })).toBe(1);
    second = await create("Holiday shop", "holiday-shop");
    expect(second.variant.landingPageId).toBe(second.page._id);
    expect(second.page._id).not.toBe(first.page._id);
  });
  it("checks global availability and prevents another account or a racing request from claiming the name", async () => {
    expect(
      (
        await auth(
          "get",
          "/landing-page/subdomains/availability?slug=FARM-SHOP",
          undefined,
          otherToken,
        ).expect(200)
      ).body.status,
    ).toBe("TAKEN");
    expect(
      (
        await auth(
          "get",
          `/landing-page/subdomains/availability?slug=farm-shop&pageId=${first.page._id}`,
        ).expect(200)
      ).body.status,
    ).toBe("CURRENT_PAGE");
    await auth(
      "get",
      `/landing-page/subdomains/availability?slug=farm-shop&pageId=${first.page._id}`,
      undefined,
      otherToken,
    ).expect(404);
    await auth(
      "post",
      "/landing-page/pages",
      { name: "Taken", slug: "farm-shop" },
      otherToken,
    ).expect(409);
    const racing = await Promise.all(
      [token, otherToken].map((t) =>
        auth("post", "/landing-page/pages", { name: "Race", slug: "racing-shop" }, t),
      ),
    );
    expect(racing.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      (await auth("get", "/landing-page/subdomains/availability?slug=api").expect(200)).body.status,
    ).toBe("RESERVED");
  });
  it("publishes both pages independently and replays a publish operation safely", async () => {
    const operationKey = key();
    const result = await publish(first, operationKey);
    const replay = await publish(first, operationKey);
    expect(result.revision).toBe(replay.revision);
    first.page = result;
    second.page = await publish(second);
    await request(app).get("/api/public/landing-pages/farm-shop").expect(200);
    await request(app).get("/api/public/landing-pages/holiday-shop").expect(200);
    await auth("post", `/landing-page/pages/${second.page._id}/publish`, {
      variantId: first.variant._id,
      expectedVariantRevision: 1,
      expectedPageRevision: second.page.revision,
    }).expect(404);
    await auth("get", `/landing-page/pages/${first.page._id}`, undefined, otherToken).expect(404);
  });
  it("resolves whole categories, including new products, and preserves an intentional empty selection", async () => {
    const categories = (await auth("get", "/landing-page/categories").expect(200)).body.items;
    const category = categories.find(
      (c: any) => c.sourceType === "PRODUCT" && c.name === "Farm products",
    );
    expect(category).toBeTruthy();
    const design = structuredClone(first.variant);
    const catalog = design.sections
      .flatMap((s: any) => s.components)
      .find((c: any) => c.type === "CATALOG");
    catalog.content.categoryBinding = { mode: "SELECTED_CATEGORIES", categoryIds: [category._id] };
    catalog.content.catalogItemRefs = [];
    const savedDraft = (
      await auth("patch", `/landing-page/pages/${first.page._id}/variants/${design._id}`, {
        ...design,
        categoryBindingVersion: 1,
        expectedRevision: design.revision,
      }).expect(200)
    ).body;
    await auth("patch", `/landing-page/pages/${first.page._id}/variants/${design._id}`, {
      ...design,
      categoryBindingVersion: 1,
      expectedRevision: design.revision,
    }).expect(409);
    first.variant = savedDraft;
    first.page = await publish(first);
    const product = await auth("post", "/catalog/products", {
      name: "New produce",
      category: "Farm products",
      basePrice: 99,
    }).expect(201);
    const result = (await request(app).get("/api/public/landing-pages/farm-shop").expect(200)).body;
    expect(result.catalogItems.some((p: any) => p.sourceId === product.body.id)).toBe(true);
    catalog.content.categoryBinding.categoryIds = [];
    first.variant = (
      await auth("patch", `/landing-page/pages/${first.page._id}/variants/${design._id}`, {
        ...design,
        categoryBindingVersion: 1,
        expectedRevision: savedDraft.revision,
      }).expect(200)
    ).body;
    first.page = await publish(first);
    expect(
      (await request(app).get("/api/public/landing-pages/farm-shop")).body.catalogItems,
    ).toEqual([]);
  });
  it("saves and overwrites the same private template, with revision conflicts and immutable live snapshots", async () => {
    const input = {
      sourceVariantId: second.variant._id,
      expectedVariantRevision: second.variant.revision,
      name: "My storefront",
    };
    saved = (await auth("post", "/landing-page/saved-templates", input).expect(201)).body;
    const pageBefore = await LandingPage.findById(second.page._id).lean();
    const overwrite = {
      sourceVariantId: second.variant._id,
      expectedVariantRevision: second.variant.revision,
      expectedTemplateRevision: saved.revision,
    };
    const operationKey = key();
    const updated = (
      await auth(
        "put",
        `/landing-page/saved-templates/${saved._id}`,
        overwrite,
        token,
        operationKey,
      ).expect(200)
    ).body;
    expect(updated._id).toBe(saved._id);
    expect(updated.name).toBe("My storefront");
    expect(updated.revision).toBe(2);
    expect(
      (
        await auth(
          "put",
          `/landing-page/saved-templates/${saved._id}`,
          overwrite,
          token,
          operationKey,
        ).expect(200)
      ).body.revision,
    ).toBe(2);
    await auth("put", `/landing-page/saved-templates/${saved._id}`, overwrite).expect(409);
    await auth("put", `/landing-page/saved-templates/${saved._id}`, overwrite, otherToken).expect(
      404,
    );
    expect(
      await LandingPageSavedTemplate.countDocuments({ businessId: fixture.business._id }),
    ).toBe(1);
    expect((await LandingPage.findById(second.page._id).lean())?.publishedSnapshot).toEqual(
      pageBefore?.publishedSnapshot,
    );
    const applied = (
      await auth("post", `/landing-page/pages/${second.page._id}/variants`, {
        name: "Reusable design",
        savedTemplateId: saved._id,
      }).expect(201)
    ).body;
    expect(applied.sourceSavedTemplateId).toBe(saved._id);
  });
  it("persists schedules with manual precedence and rejects stale or foreign availability edits", async () => {
    const product = await CatalogProduct.findById(fixture.products[0]!._id).lean();
    const payload = {
      isActive: true,
      expectedRevision: product?.revision ?? 1,
      availabilitySchedule: {
        mode: "CUSTOM_DATES",
        timezone: "Asia/Manila",
        dates: ["2040-01-01"],
      },
    };
    const updated = (
      await auth("patch", `/catalog/products/${product!._id}/availability`, payload).expect(200)
    ).body;
    expect(updated.availabilityStatus).toBe("SCHEDULED");
    const rejected = await request(app)
      .post("/api/public/landing-pages/holiday-shop/orders")
      .send({
        idempotencyKey: key(),
        customer: { name: "Customer", phone: "+639171111111", email: "" },
        fulfillmentMethod: "PICKUP",
        paymentMethod: "PAY_ON_PICKUP",
        items: [{ sourceType: "PRODUCT", sourceId: String(product!._id), quantity: 1 }],
      })
      .expect(409);
    expect(rejected.body.code).toBe("PRODUCT_NOT_ACTIVE_NOW");
    expect(
      (await request(app).get("/api/public/landing-pages/holiday-shop")).body.catalogItems.some(
        (p: any) => p.sourceId === String(product!._id),
      ),
    ).toBe(false);
    await auth("patch", `/catalog/products/${product!._id}/availability`, payload).expect(409);
    await auth(
      "patch",
      `/catalog/products/${product!._id}/availability`,
      { ...payload, expectedRevision: updated.revision },
      otherToken,
    ).expect(404);
    const fullEdit = (
      await auth("put", `/catalog/products/${product!._id}`, {
        name: product!.name,
        category: product!.category,
        basePrice: Number(product!.basePrice.toString()),
        isActive: true,
        isOrderable: true,
      }).expect(200)
    ).body;
    expect(fullEdit.availabilitySchedule).toEqual(payload.availabilitySchedule);
    const disabled = (
      await auth("patch", `/catalog/products/${product!._id}/availability`, {
        isActive: false,
        expectedRevision: fullEdit.revision,
        availabilitySchedule: { mode: "ALWAYS", timezone: "Asia/Manila" },
      }).expect(200)
    ).body;
    expect(disabled.effectiveActive).toBe(false);
    expect(disabled.isOrderable).toBe(product?.isOrderable);
  });
  it("rejects foreign category references and keeps archived addresses claimed", async () => {
    const foreign = await CatalogCategory.create({
      businessId: new mongoose.Types.ObjectId(),
      name: "Foreign",
      normalizedName: "foreign",
      sourceType: "PRODUCT",
    });
    const doc = structuredClone(second.variant);
    doc.sections
      .flatMap((s: any) => s.components)
      .find((c: any) => c.type === "CATALOG").content.categoryBinding = {
      mode: "SELECTED_CATEGORIES",
      categoryIds: [String(foreign._id)],
    };
    await auth("patch", `/landing-page/pages/${second.page._id}/variants/${doc._id}`, {
      ...doc,
      categoryBindingVersion: 1,
      expectedRevision: doc.revision,
    }).expect(422);
    await auth("delete", `/landing-page/pages/${first.page._id}`, {
      expectedPageRevision: first.page.revision,
    }).expect(204);
    await request(app).get("/api/public/landing-pages/farm-shop").expect(404);
    expect(
      (
        await auth(
          "get",
          "/landing-page/subdomains/availability?slug=farm-shop",
          undefined,
          otherToken,
        )
      ).body.status,
    ).toBe("TAKEN");
    await request(app).get("/api/public/landing-pages/holiday-shop").expect(200);
    expect(
      await LandingPageVariant.countDocuments({ landingPageId: first.page._id }),
    ).toBeGreaterThan(0);
  });
});
