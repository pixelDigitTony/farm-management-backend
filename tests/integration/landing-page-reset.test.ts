import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { LandingPage, LandingPageVariant } from "../../src/models/index.js";
import { landingTemplates } from "../../src/services/landing-presets.js";
import { defaultLandingPageCommerceSettings } from "../../src/validation/landing-page.js";
import { seedBrowserFixtures, testCredentials } from "../support/seed.js";
import { startTestDatabase } from "./database.js";

let stop: (() => Promise<void>) | undefined;
let token: string;
let variantId: string;
beforeAll(async () => {
  stop = await startTestDatabase();
  await seedBrowserFixtures();
  const login = await request(app)
    .post("/api/auth/login")
    .send({ method: "EMAIL_PASSWORD", ...testCredentials })
    .expect(200);
  token = login.body.token;
  const created = await request(app)
    .post("/api/landing-page/variants")
    .auth(token, { type: "bearer" })
    .send({ name: "My variant" })
    .expect(201);
  variantId = created.body._id;
});
afterAll(async () => {
  await stop?.();
});

describe("landing-page reset", () => {
  it.each(landingTemplates)(
    "persists $id V2 backgrounds through save, duplicate, publish, public read and reset",
    async (template) => {
      const created = await request(app)
        .post("/api/landing-page/variants")
        .auth(token, { type: "bearer" })
        .send({ name: `${template.id} round trip`, templateId: template.id, goal: "SHOP" })
        .expect(201);
      const doc = created.body;
      const original = structuredClone(doc.theme.background);
      doc.theme.background.mode = "COLOR";
      doc.theme.background.color = "#123456";
      doc.theme.background.image = {
        url: "https://example.test/background.webp",
        alt: "Merchant background",
        focalPoint: { x: 0.2, y: 0.7 },
        aspectRatio: "WIDE",
      };
      const saved = await request(app)
        .patch(`/api/landing-page/variants/${doc._id}`)
        .auth(token, { type: "bearer" })
        .send(doc)
        .expect(200);
      const stored = await LandingPageVariant.findById(doc._id).lean();
      expect(stored?.theme).toEqual(saved.body.theme);
      expect(stored?.schemaVersion).toBe(2);
      expect(stored?.template).toEqual({ id: template.id, revision: template.revision });
      const duplicated = await request(app)
        .post("/api/landing-page/variants")
        .auth(token, { type: "bearer" })
        .send({ name: `${template.id} copy`, duplicateFromId: doc._id })
        .expect(201);
      expect(duplicated.body.theme).toEqual(saved.body.theme);
      expect(duplicated.body.sections).toEqual(saved.body.sections);
      const published = await request(app)
        .post(`/api/landing-page/variants/${doc._id}/publish`)
        .auth(token, { type: "bearer" })
        .expect(200);
      const snapshot = published.body.publishedSnapshot;
      const publicRead = await request(app)
        .get(`/api/public/landing-pages/${published.body.slug}`)
        .expect(200);
      expect(publicRead.body.variant.theme).toEqual(saved.body.theme);
      expect(publicRead.body.variant.template).toEqual(saved.body.template);
      expect(publicRead.body.variant.goal).toBe("SHOP");
      expect(publicRead.body.variant.sections).toEqual(saved.body.sections);
      await request(app)
        .patch(`/api/landing-page/variants/${doc._id}`)
        .auth(token, { type: "bearer" })
        .send({ ...doc, schemaVersion: undefined })
        .expect(409);
      const reset = await request(app)
        .patch(`/api/landing-page/variants/${doc._id}/reset`)
        .auth(token, { type: "bearer" })
        .expect(200);
      expect(reset.body._id).toBe(doc._id);
      expect(reset.body.name).toBe(doc.name);
      expect(reset.body.theme.background).toEqual(original);
      expect(reset.body.template).toEqual(doc.template);
      const afterReset = await request(app)
        .get(`/api/public/landing-pages/${published.body.slug}`)
        .expect(200);
      expect(afterReset.body.variant.theme).toEqual(snapshot.theme);
    },
  );
  it("restores defaults in place and preserves the variant name and published snapshot", async () => {
    const pageBefore = await LandingPage.findOne().lean();
    const variantBefore = await LandingPageVariant.findById(variantId).lean();
    await LandingPageVariant.updateOne(
      { _id: variantId },
      {
        $set: {
          theme: { ...variantBefore?.theme, primaryColor: "#112233" },
          commerce: { ...defaultLandingPageCommerceSettings, cartButtonLabel: "My bag" },
          sections: [{ id: "custom", name: "Custom", enabled: true, components: [] }],
        },
      },
    );
    const reset = await request(app)
      .patch(`/api/landing-page/variants/${variantId}/reset`)
      .auth(token, { type: "bearer" })
      .expect(200);
    expect(reset.body._id).toBe(variantId);
    expect(reset.body.name).toBe("My variant");
    expect(reset.body.theme.primaryColor).toBe("#be185d");
    expect(reset.body.commerce).toEqual(defaultLandingPageCommerceSettings);
    expect(reset.body.sections.length).toBeGreaterThan(1);
    expect(reset.body.sections.some((section: { id: string }) => section.id === "custom")).toBe(
      false,
    );
    const pageAfter = await LandingPage.findOne().lean();
    expect(pageAfter?.publishedSnapshot).toEqual(pageBefore?.publishedSnapshot);
    expect(pageAfter?.publishedAt).toEqual(pageBefore?.publishedAt);
    expect(pageAfter?.isPublished).toBe(true);
  });
  it("rejects unauthenticated, malformed and foreign variant resets", async () => {
    await request(app).patch(`/api/landing-page/variants/${variantId}/reset`).expect(401);
    await request(app)
      .patch("/api/landing-page/variants/invalid/reset")
      .auth(token, { type: "bearer" })
      .expect(400);
    await request(app)
      .patch(`/api/landing-page/variants/${new mongoose.Types.ObjectId()}/reset`)
      .auth(token, { type: "bearer" })
      .expect(404);
  });
});
