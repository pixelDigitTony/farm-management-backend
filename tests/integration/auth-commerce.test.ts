import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import {
  AuthSession,
  Business,
  CatalogProduct,
  CustomerOrder,
  User,
} from "../../src/models/index.js";
import { updateOrderStatus } from "../../src/services/commerce.service.js";
import { seedBrowserFixtures, testCredentials } from "../support/seed.js";
import { startTestDatabase } from "./database.js";

let stop: (() => Promise<void>) | undefined;
let fixture: Awaited<ReturnType<typeof seedBrowserFixtures>>;
beforeAll(async () => {
  stop = await startTestDatabase();
  fixture = await seedBrowserFixtures();
});
afterAll(async () => {
  await stop?.();
});
async function login() {
  return request(app)
    .post("/api/auth/login")
    .send({ method: "EMAIL_PASSWORD", ...testCredentials })
    .expect(200);
}
function orderInput(key: string, expectedTotal = 100) {
  return {
    idempotencyKey: key,
    customer: { name: "Test Customer", phone: "+639171234568", email: "" },
    fulfillmentMethod: "PICKUP",
    paymentMethod: "PAY_ON_PICKUP",
    items: [
      {
        sourceType: "PRODUCT",
        sourceId: fixture.products[0]?.id,
        quantity: 1,
        expectedUnitPrice: 100,
      },
    ],
    expectedTotal,
  };
}

describe("real authentication and public checkout", () => {
  it("rejects absent or malformed credentials on private endpoints", async () => {
    await request(app).get("/api/resources/inventory-items").expect(401);
    await request(app)
      .get("/api/resources/inventory-items")
      .set("Authorization", "Bearer invalid")
      .expect(401);
  });
  it("issues an HttpOnly refresh cookie and refuses revoked sessions", async () => {
    const result = await login();
    const cookies = result.get("Set-Cookie");
    expect(cookies?.join(";")).toContain("HttpOnly");
    await request(app).get("/api/auth/me").auth(result.body.token, { type: "bearer" }).expect(200);
    await AuthSession.updateMany(
      { userId: fixture.user.id },
      { $set: { revokedAt: new Date(), revokeReason: "SECURITY" } },
    );
    await request(app).get("/api/auth/me").auth(result.body.token, { type: "bearer" }).expect(401);
  });
  it("enforces the existing highest-role boundary using current database state", async () => {
    const result = await login();
    await User.updateOne({ _id: fixture.user.id }, { $set: { role: 1 } });
    try {
      await request(app)
        .get("/api/catalog/products")
        .auth(result.body.token, { type: "bearer" })
        .expect(403);
    } finally {
      await User.updateOne({ _id: fixture.user.id }, { $set: { role: 0 } });
    }
  });
  it("returns the existing order on a concurrent checkout retry", async () => {
    const body = orderInput("idempotent_checkout_request");
    const responses = await Promise.all([
      request(app).post("/api/public/landing-pages/test-farm/orders").send(body),
      request(app).post("/api/public/landing-pages/test-farm/orders").send(body),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(responses[0]?.body.orderNumber).toBe(responses[1]?.body.orderNumber);
    expect(await CustomerOrder.countDocuments({ idempotencyKey: body.idempotencyKey })).toBe(1);
  });
  it("rejects stale prices with the existing price-review response contract", async () => {
    const result = await request(app)
      .post("/api/public/landing-pages/test-farm/orders")
      .send(orderInput("stale_price_checkout_request", 1))
      .expect(409);
    expect(result.body.code).toBe("PRICES_CHANGED");
    expect(result.body.details).toHaveProperty("total");
    expect(
      await CustomerOrder.countDocuments({ idempotencyKey: "stale_price_checkout_request" }),
    ).toBe(0);
  });
  it("rejects products belonging to another business", async () => {
    const foreign = await CatalogProduct.create({
      businessId: new mongoose.Types.ObjectId(),
      productCode: "FOREIGN",
      name: "Foreign",
      basePrice: 100,
    });
    const body = orderInput("foreign_product_checkout_request");
    const item = body.items[0];
    if (!item) throw new Error("Missing fixture order item");
    body.items[0] = { ...item, sourceId: foreign.id };
    await request(app).post("/api/public/landing-pages/test-farm/orders").send(body).expect(422);
  });
  it("reserves and restores stock exactly once through concurrent status transitions", async () => {
    const result = await request(app)
      .post("/api/public/landing-pages/test-farm/orders")
      .send(orderInput("transition_checkout_request"))
      .expect(201);
    const order = await CustomerOrder.findOne({ orderNumber: result.body.orderNumber });
    if (!order) throw new Error("Missing test order");
    const outcomes = await Promise.allSettled([
      updateOrderStatus(fixture.business._id, fixture.user._id, order.id, { status: "CONFIRMED" }),
      updateOrderStatus(fixture.business._id, fixture.user._id, order.id, { status: "CONFIRMED" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect((await CatalogProduct.findById(fixture.products[0]?.id))?.availableQuantity).toBe(999);
    await updateOrderStatus(fixture.business._id, fixture.user._id, order.id, {
      status: "CANCELLED",
      cancellationReason: "Test cancellation",
    });
    expect((await CatalogProduct.findById(fixture.products[0]?.id))?.availableQuantity).toBe(1000);
    expect(
      (await CustomerOrder.findById(order.id).select("+transitionLock"))?.transitionLock,
    ).toBeNull();
  });
  it("hides published pages for archived businesses", async () => {
    await Business.updateOne({ _id: fixture.business.id }, { $set: { isArchived: true } });
    try {
      await request(app).get("/api/public/landing-pages/test-farm").expect(404);
    } finally {
      await Business.updateOne({ _id: fixture.business.id }, { $set: { isArchived: false } });
    }
  });
});
