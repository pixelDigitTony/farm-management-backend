import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import {
  AuditLog,
  Business,
  CatalogMyDayCampaign,
  CatalogProduct,
  LandingPage,
  User,
} from "../../src/models/index.js";
import { seedBrowserFixtures, testCredentials } from "../support/seed.js";
import { startTestDatabase } from "./database.js";

let stop: (() => Promise<void>) | undefined;
let fixture: Awaited<ReturnType<typeof seedBrowserFixtures>>;
let token: string, otherToken: string, pageId: string;
const auth = (
  method: "get" | "post" | "put" | "patch" | "delete",
  path: string,
  body?: Record<string, unknown>,
  bearer = token,
) => request(app)[method](`/api/catalog/my-day${path}`).auth(bearer, { type: "bearer" }).send(body);
const input = () => ({
  name: "Harvest",
  heading: "My Day",
  description: "Fresh picks",
  landingPageId: pageId,
  productIds: fixture.products.slice(0, 2).map((p) => String(p._id)),
  timezone: "Asia/Manila",
  startsAt: new Date(Date.now() - 60_000).toISOString(),
  endsAt: new Date(Date.now() + 3600_000).toISOString(),
  isEnabled: true,
});
beforeAll(async () => {
  stop = await startTestDatabase();
  fixture = await seedBrowserFixtures();
  pageId = String((await LandingPage.findOne({ slug: "test-farm" }).lean())?._id);
  token = (
    await request(app)
      .post("/api/auth/login")
      .send({ method: "EMAIL_PASSWORD", ...testCredentials })
      .expect(200)
  ).body.token;
  const other = await Business.create({ businessName: "Other", businessNameNormalized: "other" });
  await User.create({
    businessId: other._id,
    name: "Other",
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
describe("My Day persisted HTTP flow", () => {
  it("creates disabled by default, lists canonical data, and audits atomically", async () => {
    const { isEnabled: _, ...data } = input();
    const created = await auth("post", "", data).expect(201);
    expect(created.body._id).toMatch(/^[a-f0-9]{24}$/);
    const list = (await auth("get", "?status=Disabled").expect(200)).body;
    expect(list.items).toHaveLength(1);
    expect(list.pages[0]._id).toBe(pageId);
    expect(list.items[0]).toMatchObject({
      status: "Disabled",
      revision: 1,
      productIds: data.productIds,
    });
    expect(
      await AuditLog.countDocuments({
        targetCollection: "catalog-my-day-campaigns",
        action: "CREATE",
      }),
    ).toBe(1);
    const publicPage = (await request(app).get("/api/public/landing-pages/test-farm").expect(200))
      .body;
    expect(publicPage.myDay).toBeNull();
  });
  it("activates without republishing, enforces revision checks, and exposes only safe public fields", async () => {
    const campaign = await CatalogMyDayCampaign.findOne().lean();
    await auth("patch", `/${campaign._id}/status`, { expectedRevision: 1, isEnabled: true }).expect(
      200,
    );
    await auth("patch", `/${campaign._id}/status`, {
      expectedRevision: 1,
      isEnabled: false,
    }).expect(409);
    const result = await request(app).get("/api/public/landing-pages/test-farm").expect(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body.myDay).toMatchObject({
      id: String(campaign._id),
      productKeys: input().productIds.map((id) => `PRODUCT:${id}`),
    });
    expect(result.body.myDay).not.toHaveProperty("name");
    expect(result.body.myDay).not.toHaveProperty("createdByUserId");
    expect(result.body.myDayFrequency.timezone).toBe("Asia/Manila");
  });
  it("rejects cross-business CRUD, spoofed references, invalid dates, and unauthenticated access", async () => {
    const campaign = await CatalogMyDayCampaign.findOne().lean();
    await auth(
      "patch",
      `/${campaign._id}/status`,
      { expectedRevision: 2, isEnabled: false },
      otherToken,
    ).expect(404);
    await auth("delete", `/${campaign._id}`, { expectedRevision: 2 }, otherToken).expect(404);
    await auth("post", "", input(), otherToken).expect(422);
    await auth("post", "/preview", input(), otherToken).expect(422);
    await auth("post", "", { ...input(), endsAt: input().startsAt }).expect(422);
    await request(app).get("/api/catalog/my-day").expect(401);
    expect((await auth("get", "", undefined, otherToken).expect(200)).body.items).toHaveLength(0);
  });
  it("previews future content without writing campaign state", async () => {
    const count = await CatalogMyDayCampaign.countDocuments();
    const result = (
      await auth("post", "/preview", {
        ...input(),
        isEnabled: false,
        startsAt: "2030-01-01T00:00:00Z",
        endsAt: "2030-01-02T00:00:00Z",
      }).expect(200)
    ).body;
    expect(result.myDay.productKeys).toHaveLength(2);
    expect(result.theme).toBeTruthy();
    expect(await CatalogMyDayCampaign.countDocuments()).toBe(count);
  });
  it("filters stock and off-schedule products, then permits catalog details", async () => {
    const [first, second] = fixture.products;
    await CatalogProduct.updateOne({ _id: first._id }, { $set: { availableQuantity: 0 } });
    await CatalogProduct.updateOne({ _id: second._id }, { $set: { isActive: false } });
    expect(
      (await request(app).get("/api/public/landing-pages/test-farm").expect(200)).body.myDay,
    ).toBeNull();
    await LandingPage.updateOne({ _id: pageId }, { $set: { "publishedSnapshot.goal": "CATALOG" } });
    expect(
      (await request(app).get("/api/public/landing-pages/test-farm").expect(200)).body.myDay
        .productKeys,
    ).toEqual([`PRODUCT:${first._id}`]);
    await CatalogProduct.updateMany(
      { _id: { $in: [first._id, second._id] } },
      { $set: { availableQuantity: 100, isActive: true } },
    );
    await LandingPage.updateOne({ _id: pageId }, { $set: { "publishedSnapshot.goal": "SHOP" } });
  });
  it("never expands the published catalog or leaks draft-only products", async () => {
    const page = await LandingPage.findById(pageId).lean();
    await LandingPage.updateOne(
      { _id: pageId },
      {
        $set: {
          "publishedSnapshot.schemaVersion": 2,
          "publishedSnapshot.sections": [
            {
              id: "only-one",
              enabled: true,
              components: [
                {
                  id: "catalog",
                  enabled: true,
                  type: "CATALOG",
                  content: {
                    catalogItemRefs: [
                      { sourceType: "PRODUCT", sourceId: String(fixture.products[0]._id) },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    );
    expect(
      (await request(app).get("/api/public/landing-pages/test-farm").expect(200)).body.myDay
        .productKeys,
    ).toEqual([`PRODUCT:${fixture.products[0]._id}`]);
    await LandingPage.updateOne(
      { _id: pageId },
      { $set: { publishedSnapshot: page.publishedSnapshot } },
    );
  });
  it("reports superseded campaigns and includes future start boundaries", async () => {
    await auth("post", "", {
      ...input(),
      name: "Newer",
      startsAt: new Date(Date.now() - 1000).toISOString(),
    }).expect(201);
    const list = (await auth("get", "?status=Active").expect(200)).body;
    expect(
      list.items.some((c: { diagnostics: string[] }) =>
        c.diagnostics.includes("Superseded by another active campaign"),
      ),
    ).toBe(true);
    const startsAt = new Date(Date.now() + 30_000).toISOString();
    await auth("post", "", { ...input(), startsAt }).expect(201);
    expect(
      (await request(app).get("/api/public/landing-pages/test-farm").expect(200)).body
        .nextTransitionAt,
    ).toBe(startsAt);
  });
  it("isolates pages and suppresses unpublished/archived pages", async () => {
    const page = await LandingPage.findById(pageId).lean();
    const { _id: _, ...copy } = page;
    await LandingPage.create({ ...copy, _id: new mongoose.Types.ObjectId(), slug: "other-page" });
    expect(
      (await request(app).get("/api/public/landing-pages/other-page").expect(200)).body.myDay,
    ).toBeNull();
    await LandingPage.updateOne({ _id: pageId }, { $set: { isPublished: false } });
    await request(app).get("/api/public/landing-pages/test-farm").expect(404);
    await LandingPage.updateOne({ _id: pageId }, { $set: { isPublished: true } });
  });
  it("allows only one concurrent revision to commit", async () => {
    const campaign = await CatalogMyDayCampaign.findOne().lean();
    const updates = await Promise.all([
      auth("patch", `/${campaign._id}/status`, {
        expectedRevision: campaign.revision,
        isEnabled: false,
      }),
      auth("patch", `/${campaign._id}/status`, {
        expectedRevision: campaign.revision,
        isEnabled: false,
      }),
    ]);
    expect(updates.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await CatalogMyDayCampaign.findById(campaign._id).lean()).revision).toBe(
      campaign.revision + 1,
    );
  });
  it("disables and deletes campaigns after product references disappear", async () => {
    const campaign = await CatalogMyDayCampaign.findOne().lean();
    await CatalogProduct.deleteMany({ _id: { $in: campaign.productIds } });
    await auth("patch", `/${campaign._id}/status`, {
      expectedRevision: campaign.revision,
      isEnabled: false,
    }).expect(200);
    await auth("delete", `/${campaign._id}`, { expectedRevision: campaign.revision }).expect(409);
    await auth("delete", `/${campaign._id}`, { expectedRevision: campaign.revision + 1 }).expect(
      204,
    );
    expect(
      await AuditLog.countDocuments({
        targetDocumentId: campaign._id,
        targetCollection: "catalog-my-day-campaigns",
        action: "DELETE",
      }),
    ).toBe(1);
  });
  it("uses the public resolution index with 1,000 unrelated campaign windows", async () => {
    const anotherPage = new mongoose.Types.ObjectId();
    await CatalogMyDayCampaign.insertMany(
      Array.from({ length: 1000 }, (_, index) => ({
        ...input(),
        businessId: fixture.business._id,
        landingPageId: anotherPage,
        name: `Scale fixture ${index}`,
        createdByUserId: fixture.user._id,
        updatedByUserId: fixture.user._id,
      })),
    );
    const plan = await CatalogMyDayCampaign.collection
      .find({
        businessId: fixture.business._id,
        landingPageId: new mongoose.Types.ObjectId(pageId),
        isEnabled: true,
        endsAt: { $gt: new Date() },
      })
      .explain("executionStats");
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain(
      "businessId_1_landingPageId_1_isEnabled_1_startsAt_1_endsAt_1",
    );
    expect(plan.executionStats.totalDocsExamined).toBeLessThan(20);
  });
});
