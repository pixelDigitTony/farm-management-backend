import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { LandingPage, LandingPageVariant } from "../../src/models/index.js";
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
