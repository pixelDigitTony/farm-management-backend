import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../src/config/env.js";
import { errorHandler } from "../../src/middleware/errors.js";
import { requirePermissions } from "../../src/middleware/permissions.js";
import {
  Business,
  CustomerOrder,
  EmailOutbox,
  EmailReplyAlias,
  EmailVerificationToken,
  EmailWebhookEvent,
  LandingEvent,
  LandingPage,
  LandingVisit,
  OrderConversation,
  OrderMessage,
  User,
} from "../../src/models/index.js";
import { authRouter } from "../../src/routes/auth.routes.js";
import { emailWebhookRouter } from "../../src/routes/email-webhook.routes.js";
import { employeeRouter } from "../../src/routes/employee.routes.js";
import {
  analyticsManagementRouter,
  analyticsPublicRouter,
} from "../../src/routes/landing-analytics.routes.js";
import { orderMessagingRouter } from "../../src/routes/order-messaging.routes.js";
import { emailService } from "../../src/services/email.service.js";
import { processEmailOutbox, readEmailPayload } from "../../src/services/email-outbox.service.js";
import { issueVerificationEmail } from "../../src/services/email-verification.service.js";
import { processEmailWebhooks, saveWebhook } from "../../src/services/email-webhook.service.js";
import {
  landingStatistics,
  recordLandingEvents,
} from "../../src/services/landing-analytics.service.js";
import { initializeOrderEmail } from "../../src/services/order-messaging.service.js";
import { startTestDatabase } from "./database.js";

const businessId = new mongoose.Types.ObjectId(),
  otherBusinessId = new mongoose.Types.ObjectId(),
  userId = new mongoose.Types.ObjectId();
let role = 5;
let stop: (() => Promise<void>) | undefined;
let page: any;
const app = express();
app.use("/webhooks", emailWebhookRouter);
app.use(express.json());
app.use((req, _res, next) => {
  req.owner = {
    businessId,
    userId,
    sessionId: new mongoose.Types.ObjectId(),
    role,
    status: "ACTIVE",
    isApproved: true,
    emailVerified: true,
  };
  next();
});
app.use("/api/orders", requirePermissions, orderMessagingRouter);
app.use("/api/landing-page", requirePermissions, analyticsManagementRouter);
app.use("/api/public", analyticsPublicRouter);
app.use("/employees", employeeRouter);
app.use("/auth", authRouter);
app.use(errorHandler);
beforeAll(async () => {
  env.EMAIL_PROVIDER = "console";
  env.ORDER_EMAIL_INBOX_ENABLED = "true";
  env.EMAIL_RECEIVING_DOMAIN = "reply.example.test";
  stop = await startTestDatabase();
});
afterAll(async () => {
  await stop?.();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  role = 5;
  if (!mongoose.connection.name.startsWith("farm_test_")) throw new Error("Unsafe test database");
  for (const model of Object.values(mongoose.models)) await model.deleteMany({});
  await Business.create({
    _id: businessId,
    businessName: "Farm",
    businessNameNormalized: "farm",
    ownerRole: 5,
    roles: [
      { level: 5, name: "Owner" },
      { level: 1, name: "Viewer", permissions: ["orders:view", "landing-page:view"] },
    ],
  });
  await User.create({
    _id: userId,
    businessId,
    name: "Owner",
    email: "owner@example.test",
    emailNormalized: "owner@example.test",
    phone: "09171234567",
    phoneNormalized: "+639171234567",
    passwordHash: "test",
    mpinHash: "test",
    role: 5,
    status: "ACTIVE",
    isApproved: true,
    emailVerifiedAt: new Date(),
  });
  page = await LandingPage.create({
    businessId,
    slug: "farm",
    siteTitle: "Farm",
    isPublished: true,
    publishedAt: new Date(),
    publishedSnapshot: {
      sections: [{ enabled: true, components: [{ id: "hero-cta", enabled: true }] }],
    },
  });
});
async function order(overrides: Record<string, unknown> = {}) {
  return CustomerOrder.create({
    businessId,
    landingPageId: page._id,
    sourceSlugSnapshot: "farm",
    orderNumber: `WEB-${randomUUID()}`,
    idempotencyKey: randomUUID(),
    customer: { name: "Buyer", phone: "09171234568", email: "buyer@example.test" },
    fulfillmentMethod: "PICKUP",
    paymentMethod: "PAY_ON_PICKUP",
    items: [],
    ...overrides,
  });
}
const incoming = (id: string, to: string, from = "buyer@example.test") => ({
  type: "email.received",
  data: { email_id: id, from, to: [to], message_id: `<${id}@example.test>` },
});

describe("landing statistics", () => {
  it("measures the 100k-event statistics and ingestion budgets", async () => {
    const now = Date.now();
    for (let batch = 0; batch < 20; batch++) {
      await LandingEvent.collection.insertMany(
        Array.from({ length: 5000 }, (_, index) => {
          const number = batch * 5000 + index;
          return {
            businessId,
            landingPageId: page._id,
            eventId: randomUUID(),
            visitorId: `visitor_${number % 10000}`,
            sessionId: randomUUID(),
            type: "page_view",
            occurredAt: new Date(now - (number % 88) * 86400000),
            receivedAt: new Date(now),
            deviceCategory: "mobile",
            expiresAt: new Date(now + 90 * 86400000),
          };
        }),
      );
    }
    const timings = [];
    for (let sample = 0; sample < 5; sample++) {
      const start = performance.now();
      const result = (await landingStatistics(businessId, page.id, {
        from: new Date(now - 89 * 86400000).toISOString(),
        to: new Date(now + 1000).toISOString(),
        timezone: "Asia/Manila",
      })) as any;
      expect(result.summary.pageViews).toBe(100000);
      expect(result.summary.uniqueVisitors).toBe(10000);
      timings.push(performance.now() - start);
    }
    const ingestion = [];
    for (let sample = 0; sample < 20; sample++) {
      const start = performance.now();
      await recordLandingEvents("farm", {
        events: [
          {
            eventId: randomUUID(),
            visitorId: randomUUID(),
            sessionId: randomUUID(),
            type: "page_view",
            occurredAt: new Date().toISOString(),
          },
        ],
      });
      ingestion.push(performance.now() - start);
    }
    const p95 = (values: number[]) =>
      Math.ceil([...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? 0);
    const evidence = {
      fixture: "Disposable MongoDB, 100000 page views, 10000 anonymous visitors",
      statisticsP95Ms: p95(timings),
      ingestionP95Ms: p95(ingestion),
      statisticsSamples: timings.length,
      ingestionSamples: ingestion.length,
    };
    await mkdir("test-results/management-communications", { recursive: true });
    await writeFile(
      "test-results/management-communications/performance.json",
      JSON.stringify(evidence, null, 2),
    );
    expect(evidence.statisticsP95Ms).toBeLessThan(2000);
    expect(evidence.ingestionP95Ms).toBeLessThan(300);
  });
  it("deduplicates events and measures range uniques and confirmed orders", async () => {
    const event = {
      eventId: randomUUID(),
      visitorId: randomUUID(),
      sessionId: randomUUID(),
      type: "page_view",
      occurredAt: new Date().toISOString(),
      deviceCategory: "mobile",
    };
    await request(app)
      .post("/api/public/landing-pages/farm/events")
      .send({ events: [event] })
      .expect(202);
    await request(app)
      .post("/api/public/landing-pages/farm/events")
      .send({ events: [event] })
      .expect(202);
    await request(app)
      .post("/api/public/landing-pages/farm/events")
      .send({ events: [{ ...event, eventId: randomUUID() }] })
      .expect(202);
    await order({ analyticsSessionId: event.sessionId });
    await order({ analyticsSessionId: event.sessionId });
    const result = await request(app)
      .get(`/api/landing-page/pages/${page.id}/statistics`)
      .query({
        from: new Date(Date.now() - 86400000).toISOString(),
        to: new Date(Date.now() + 1000).toISOString(),
        timezone: "Asia/Manila",
      })
      .expect(200);
    expect(result.body.summary).toMatchObject({
      uniqueVisitors: 1,
      visits: 1,
      pageViews: 2,
      ordersCreated: 2,
      convertedVisits: 1,
      conversionRate: 100,
    });
    expect(await LandingEvent.countDocuments()).toBe(2);
    expect(await LandingVisit.countDocuments()).toBe(1);
  });
  it("filters bots and rejects cross-business reports and invalid components", async () => {
    const event = {
      eventId: randomUUID(),
      visitorId: randomUUID(),
      sessionId: randomUUID(),
      type: "page_view",
      occurredAt: new Date().toISOString(),
    };
    await request(app)
      .post("/api/public/landing-pages/farm/events")
      .set("User-Agent", "ExampleBot")
      .send({ events: [event] })
      .expect(202);
    expect(await LandingEvent.countDocuments()).toBe(0);
    await request(app)
      .post("/api/public/landing-pages/farm/events")
      .send({ events: [{ ...event, type: "cta_click", componentId: "foreign" }] })
      .expect(422);
    await LandingPage.updateOne({ _id: page._id }, { businessId: otherBusinessId });
    await request(app).get(`/api/landing-page/pages/${page.id}/statistics`).expect(404);
  });
});
describe("employee verification", () => {
  it("preserves a literal pending email address when consuming its token", async () => {
    const employee = await User.findById(userId).select("+emailNormalized");
    await User.updateOne(
      { _id: userId },
      { $set: { pendingEmail: "$new@example.test", pendingEmailNormalized: "$new@example.test" } },
    );
    const delivery = await issueVerificationEmail({
      _id: userId,
      id: String(userId),
      name: employee!.name,
      email: "$new@example.test",
      emailNormalized: "$new@example.test",
      businessId,
    });
    const raw =
      "developmentVerificationUrl" in delivery
        ? new URL(delivery.developmentVerificationUrl!).searchParams.get("token")
        : null;
    await request(app).post("/auth/verify-email").send({ token: raw }).expect(200);
    expect((await User.findById(userId))!.email).toBe("$new@example.test");
  });
  it("activates an approved employee once and exposes scoped resend cooldown", async () => {
    const employee = await User.create({
      businessId,
      name: "Employee",
      email: "new@example.test",
      emailNormalized: "new@example.test",
      phone: "09171234569",
      phoneNormalized: "+639171234569",
      passwordHash: "test",
      mpinHash: "test",
      role: 1,
      isApproved: true,
      status: "PENDING_EMAIL_VERIFICATION",
    });
    const delivery = await issueVerificationEmail(employee);
    const raw =
      "developmentVerificationUrl" in delivery
        ? new URL(delivery.developmentVerificationUrl!).searchParams.get("token")
        : null;
    await request(app).post(`/employees/accounts/${employee.id}/resend-verification`).expect(429);
    await request(app).post("/auth/verify-email").send({ token: raw }).expect(200);
    expect((await User.findById(employee._id))!.status).toBe("ACTIVE");
    await request(app).post(`/employees/accounts/${employee.id}/resend-verification`).expect(409);
    await User.updateOne({ _id: employee._id }, { businessId: otherBusinessId });
    await request(app).post(`/employees/accounts/${employee.id}/resend-verification`).expect(404);
  });
  it("creates a safe account DTO, uses the queue and preserves creation retries", async () => {
    const input = {
      name: "New employee",
      email: "staff@example.test",
      phone: "09171234569",
      role: 1,
      password: "Temporary-password",
      mpin: "048297",
    };
    const key = randomUUID();
    const result = await request(app)
      .post("/employees/accounts")
      .set("Idempotency-Key", key)
      .send(input)
      .expect(201);
    expect(result.body.emailDelivery.status).toBe("DEVELOPMENT");
    expect(result.body.user.passwordHash).toBeUndefined();
    expect(result.body.user.mpinHash).toBeUndefined();
    await request(app)
      .post("/employees/accounts")
      .set("Idempotency-Key", key)
      .send(input)
      .expect(201);
    expect(await EmailOutbox.countDocuments()).toBe(1);
    expect(await User.countDocuments()).toBe(2);
    const job = await EmailOutbox.findOne().select("+payload");
    expect(readEmailPayload<any>(job!.payload).text).toContain("verify-email?token=");
    await processEmailOutbox();
    expect((await EmailVerificationToken.findOne())!.delivery.status).toBe("DEVELOPMENT");
  });
  it("limits concurrent resend and preserves restrictions on verification", async () => {
    const employee = await User.create({
      businessId,
      name: "Unverified",
      email: "staff@example.test",
      emailNormalized: "staff@example.test",
      phone: "09171234569",
      phoneNormalized: "+639171234569",
      passwordHash: "test",
      mpinHash: "test",
      role: 1,
      isApproved: true,
      status: "PENDING_EMAIL_VERIFICATION",
    });
    const attempts = await Promise.allSettled([
      issueVerificationEmail(employee),
      issueVerificationEmail(employee),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const fulfilled = attempts.find(
      (result) => result.status === "fulfilled",
    ) as PromiseFulfilledResult<any>;
    const token = new URL(fulfilled.value.developmentVerificationUrl).searchParams.get("token");
    await User.updateOne({ _id: employee._id }, { status: "DISABLED", isActive: false });
    await request(app).post("/auth/verify-email").send({ token }).expect(200);
    expect((await User.findById(employee._id))!.status).toBe("DISABLED");
    await request(app).post("/auth/verify-email").send({ token }).expect(400);
  });
});
describe("email order messaging", () => {
  it("recovers a temporary send failure without changing the logical send key", async () => {
    const created = await order({ emailNotificationPending: true });
    await initializeOrderEmail(created);
    const send = vi
      .spyOn(emailService, "send")
      .mockRejectedValueOnce(new Error("Temporary provider failure"))
      .mockResolvedValueOnce({ provider: "RESEND", status: "SENT", messageId: "provider-one" });
    await processEmailOutbox();
    expect((await EmailOutbox.findOne())!.state).toBe("QUEUED");
    await EmailOutbox.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
    await processEmailOutbox();
    expect(send.mock.calls[0]![1]).toBe(send.mock.calls[1]![1]);
    expect((await OrderMessage.findOne())!.deliveryState).toBe("SENT");
    await saveWebhook("delivered-first", {
      type: "email.delivered",
      data: { email_id: "provider-one", message_id: "<one@example.test>" },
    });
    await processEmailWebhooks();
    await saveWebhook("sent-late", { type: "email.sent", data: { email_id: "provider-one" } });
    await processEmailWebhooks();
    expect((await OrderMessage.findOne())!.deliveryState).toBe("DELIVERED");
  });
  it("keeps unread state per staff account", async () => {
    const created = await order();
    const { storeOrderMessage, unreadCount } = await import(
      "../../src/services/order-messaging.service.js"
    );
    const message = await storeOrderMessage(created, {
      bodyText: "Hello",
      clientMessageId: randomUUID(),
      senderKind: "CUSTOMER",
      direction: "INBOUND",
    });
    await request(app)
      .patch(`/api/orders/${created.id}/messages/read`)
      .send({ lastReadMessageId: message.id })
      .expect(200);
    const conversation = await OrderConversation.findOne({ orderId: created._id });
    expect(await unreadCount(businessId, conversation!._id, userId)).toBe(0);
    expect(await unreadCount(businessId, conversation!._id, new mongoose.Types.ObjectId())).toBe(1);
  });
  it("deduplicates initial acknowledgement and staff send, and denies viewer writes", async () => {
    const created = await order({ emailNotificationPending: true });
    await initializeOrderEmail(created);
    await initializeOrderEmail(created);
    expect(await OrderConversation.countDocuments()).toBe(1);
    expect(await OrderMessage.countDocuments()).toBe(1);
    const input = { bodyText: "We are preparing your order", clientMessageId: randomUUID() };
    await request(app).post(`/api/orders/${created.id}/messages`).send(input).expect(202);
    await request(app).post(`/api/orders/${created.id}/messages`).send(input).expect(202);
    expect(await OrderMessage.countDocuments()).toBe(2);
    expect(await EmailOutbox.countDocuments()).toBe(2);
    role = 1;
    await request(app)
      .post(`/api/orders/${created.id}/messages`)
      .send({ ...input, clientMessageId: randomUUID() })
      .expect(403);
    const history = await request(app).get(`/api/orders/${created.id}/messages`).expect(200);
    await request(app)
      .patch(`/api/orders/${created.id}/messages/read`)
      .send({ lastReadMessageId: history.body.items[1]._id })
      .expect(200);
  });
  it("leaves orders without email valid and isolates foreign order IDs", async () => {
    const missing = await order({
      customer: { name: "Offline buyer", phone: "09171234568", email: "" },
    });
    await request(app).get(`/api/orders/${missing.id}/messages`).expect(200);
    await request(app)
      .post(`/api/orders/${missing.id}/messages`)
      .send({ bodyText: "Hi", clientMessageId: randomUUID() })
      .expect(409);
    await CustomerOrder.updateOne({ _id: missing._id }, { businessId: otherBusinessId });
    await request(app).get(`/api/orders/${missing.id}/messages`).expect(404);
  });
  it("records customer email once and permits authorized staff email replies", async () => {
    const created = await order({ emailNotificationPending: true });
    await initializeOrderEmail(created);
    const customerAlias = await EmailReplyAlias.findOne({ senderKind: "CUSTOMER" }).select(
      "+encryptedAlias",
    );
    const address = readEmailPayload<string>(customerAlias!.encryptedAlias);
    vi.spyOn(emailService, "getReceived").mockResolvedValue({
      from: "buyer@example.test",
      to: [address],
      received_for: [address],
      text: "Can I collect tomorrow?",
      message_id: "<customer@example.test>",
      headers: { "Authentication-Results": "mx.test; dmarc=pass header.from=example.test" },
    } as any);
    await saveWebhook("evt-customer", incoming("mail-customer", address));
    await processEmailWebhooks();
    await saveWebhook("evt-customer", incoming("mail-customer", address));
    await processEmailWebhooks();
    expect(await OrderMessage.countDocuments({ direction: "INBOUND" })).toBe(1);
    expect(await EmailOutbox.countDocuments({ purpose: "STAFF_NOTIFICATION" })).toBe(1);
    const staffAlias = await EmailReplyAlias.findOne({ senderKind: "STAFF" }).select(
      "+encryptedAlias",
    );
    const staffAddress = readEmailPayload<string>(staffAlias!.encryptedAlias);
    vi.mocked(emailService.getReceived).mockResolvedValue({
      from: "owner@example.test",
      to: [staffAddress],
      received_for: [staffAddress],
      text: "Yes, tomorrow is fine",
      message_id: "<staff@example.test>",
      headers: { "Authentication-Results": "mx.test; dmarc=pass header.from=example.test" },
    } as any);
    await saveWebhook("evt-staff", incoming("mail-staff", staffAddress, "owner@example.test"));
    await processEmailWebhooks();
    expect(await OrderMessage.countDocuments({ senderKind: "STAFF", direction: "OUTBOUND" })).toBe(
      1,
    );
    expect(await EmailOutbox.countDocuments({ purpose: "ORDER_MESSAGE" })).toBe(2);
    await User.updateOne({ _id: userId }, { status: "DISABLED" });
    await saveWebhook("evt-revoked", incoming("mail-revoked", staffAddress, "owner@example.test"));
    await processEmailWebhooks();
    expect((await EmailWebhookEvent.findOne({ eventId: "evt-revoked" }))!.state).toBe(
      "QUARANTINED",
    );
  });
  it("validates exact webhook bytes and rejects forged signatures", async () => {
    env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from("test-signing-secret").toString("base64")}`;
    const body = JSON.stringify(incoming("received-mail", "unknown@reply.example.test"));
    const id = "evt-signed",
      timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", "test-signing-secret")
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64");
    await request(app)
      .post("/webhooks/resend")
      .set("Content-Type", "application/json")
      .set("svix-id", id)
      .set("svix-timestamp", timestamp)
      .set("svix-signature", `v1,${signature}`)
      .send(body)
      .expect(200);
    await request(app)
      .post("/webhooks/resend")
      .set("Content-Type", "application/json")
      .set("svix-id", "forged")
      .set("svix-timestamp", timestamp)
      .set("svix-signature", "v1,forged")
      .send(body)
      .expect(400);
    expect(await EmailWebhookEvent.countDocuments()).toBe(1);
  });
});
