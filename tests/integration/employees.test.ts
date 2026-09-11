import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../../src/middleware/errors.js";
import { requirePermissions } from "../../src/middleware/permissions.js";
import { Business, RegistrationInvite, User } from "../../src/models/index.js";
import { employeeRouter, invitePublicRouter } from "../../src/routes/employee.routes.js";
import { startTestDatabase } from "./database.js";

const businessId = new mongoose.Types.ObjectId();
const foreignId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
let requestRole = 5;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.owner = {
    businessId,
    userId,
    sessionId: new mongoose.Types.ObjectId(),
    role: requestRole,
    status: "ACTIVE",
    isApproved: true,
    emailVerified: true,
  };
  next();
});
app.use("/employees", employeeRouter);
app.use("/public/invites", invitePublicRouter);
app.use("/api", requirePermissions);
app.all("/api/resources/inventory-items", (_req, res) => res.json({ allowed: true }));
app.all("/api/operations/inventory-receipts", (_req, res) => res.json({ allowed: true }));
app.all("/api/orders", (_req, res) => res.json({ allowed: true }));
app.use(errorHandler);
let stop: (() => Promise<void>) | undefined;
beforeAll(async () => {
  stop = await startTestDatabase();
});
afterAll(async () => {
  await stop?.();
});
beforeEach(async () => {
  if (!mongoose.connection.name.startsWith("farm_test_")) throw new Error("Unsafe test database");
  for (const model of Object.values(mongoose.models)) await model.deleteMany({});
  requestRole = 5;
  await Business.create({
    _id: businessId,
    businessName: "Test",
    businessNameNormalized: "test",
    ownerRole: 5,
    roles: [
      { level: 5, name: "Owner" },
      { level: 1, name: "Staff" },
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
  });
});
async function invite(tenant = businessId) {
  return RegistrationInvite.create({
    businessId: tenant,
    createdBy: userId,
    role: 1,
    tokenId: `token-${tenant}`,
    isActive: true,
  });
}
describe("employee roles and links", () => {
  it("creates a higher role using its name and keeps the owner authorized", async () => {
    const result = await request(app)
      .post("/employees/roles")
      .send({ level: 8, name: "Director" })
      .expect(201);
    expect(result.body.roles).toEqual(
      expect.arrayContaining([
        { level: 8, name: "Director", permissions: [] },
        { level: 5, name: "Owner" },
      ]),
    );
    expect((await User.findById(userId))?.role).toBe(8);
    requestRole = 8;
    await request(app).get("/employees").expect(200);
  });
  it("renames roles, validates names, and deletes unused roles", async () => {
    await request(app).patch("/employees/roles/1").send({ name: "Farm staff" }).expect(200);
    expect(
      (await Business.findById(businessId))?.roles.find(
        (role: { level: number; name: string }) => role.level === 1,
      )?.name,
    ).toBe("Farm staff");
    await request(app).patch("/employees/roles/1").send({ name: " " }).expect(422);
    await request(app).delete("/employees/roles/1").expect(200);
    await request(app).delete("/employees/roles/1").expect(404);
    await request(app).patch("/employees/roles/1").send({ name: "Missing" }).expect(404);
  });
  it("protects the highest role and roles assigned to users or links", async () => {
    await request(app).delete("/employees/roles/5").expect(409);
    const link = await invite();
    await request(app).delete("/employees/roles/1").expect(409);
    await RegistrationInvite.deleteOne({ _id: link._id });
    await User.updateOne({ _id: userId }, { role: 1 });
    await request(app).delete("/employees/roles/1").expect(409);
  });
  it("invalidates deleted links without deleting registered accounts", async () => {
    const link = await invite();
    expect((await request(app).get(`/public/invites/${link.tokenId}`)).body.valid).toBe(true);
    await request(app).delete(`/employees/invites/${link.id}`).expect(200);
    expect((await request(app).get(`/public/invites/${link.tokenId}`)).body.valid).toBe(false);
    await request(app).post(`/public/invites/${link.tokenId}/register`).send({}).expect(404);
    expect(await User.countDocuments()).toBe(1);
    await request(app).delete(`/employees/invites/${link.id}`).expect(404);
  });
  it("isolates businesses and refuses management by lower roles", async () => {
    const link = await invite(foreignId);
    await request(app).delete(`/employees/invites/${link.id}`).expect(404);
    expect(await RegistrationInvite.exists({ _id: link._id })).toBeTruthy();
    await Business.create({
      _id: foreignId,
      businessName: "Other",
      businessNameNormalized: "other",
      ownerRole: 7,
      roles: [{ level: 7, name: "Other owner" }],
    });
    await request(app).patch("/employees/roles/7").send({ name: "Changed" }).expect(404);
    await request(app).delete("/employees/roles/7").expect(404);
    requestRole = 1;
    await request(app).patch("/employees/roles/1").send({ name: "Changed" }).expect(403);
    await request(app).delete("/employees/roles/1").expect(403);
    await request(app).delete(`/employees/invites/${link.id}`).expect(403);
  });
});

describe("role permission enforcement", () => {
  it("saves permissions and enforces changes on the next request", async () => {
    await request(app)
      .put("/employees/roles/1/permissions")
      .send({ permissions: ["inventory:view"] })
      .expect(200);
    requestRole = 1;
    await request(app).get("/api/resources/inventory-items").expect(200);
    await request(app).post("/api/operations/inventory-receipts").expect(403);
    await request(app).get("/api/orders").expect(403);
    requestRole = 5;
    await request(app).put("/employees/roles/1/permissions").send({ permissions: [] }).expect(200);
    requestRole = 1;
    await request(app).get("/api/resources/inventory-items").expect(403);
  });
  it("allows exactly the granted action including formerly highest-only modules", async () => {
    await request(app)
      .put("/employees/roles/1/permissions")
      .send({ permissions: ["inventory:view", "inventory:create", "orders:view"] })
      .expect(200);
    requestRole = 1;
    await request(app).post("/api/operations/inventory-receipts").expect(200);
    await request(app).delete("/api/resources/inventory-items").expect(403);
    await request(app).get("/api/orders").expect(200);
    await request(app).patch("/api/orders").expect(403);
  });
  it("prevents invalid permissions, privilege escalation, and highest-role lockout", async () => {
    for (const permissions of [
      ["admin:view"],
      ["employees:edit"],
      ["inventory:delete"],
      ["inventory:unknown"],
    ])
      await request(app).put("/employees/roles/1/permissions").send({ permissions }).expect(422);
    await request(app).put("/employees/roles/5/permissions").send({ permissions: [] }).expect(409);
    await request(app).put("/employees/roles/7/permissions").send({ permissions: [] }).expect(404);
    requestRole = 1;
    await request(app)
      .put("/employees/roles/1/permissions")
      .send({ permissions: ["orders:view"] })
      .expect(403);
  });
  it("keeps custom permissions when creating or renaming another role", async () => {
    await request(app)
      .put("/employees/roles/1/permissions")
      .send({ permissions: ["inventory:view"] })
      .expect(200);
    await request(app).post("/employees/roles").send({ level: 2, name: "Assistant" }).expect(201);
    await request(app).patch("/employees/roles/1").send({ name: "Stock viewer" }).expect(200);
    const business = await Business.findById(businessId);
    expect(
      business?.roles.find((role: { level: number }) => role.level === 1)?.permissions,
    ).toEqual(["inventory:view"]);
    expect(
      business?.roles.find((role: { level: number }) => role.level === 2)?.permissions,
    ).toEqual([]);
  });
});
