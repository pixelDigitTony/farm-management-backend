import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mongoose from "mongoose";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { app } from "../../src/app.js";
import { imageConfig as c, pipelineVersion } from "../../src/images/config.js";
import {
  acquireLock,
  claimJob,
  cleanup,
  failJob,
  finishJob,
  releaseLock,
  sourcePath,
  storeOutput,
} from "../../src/images/queue.js";
import { assertImageReferences } from "../../src/images/references.js";
import { ImageJob, StoredImage } from "../../src/models/image.models.js";
import { CatalogProduct, LandingPage } from "../../src/models/index.js";
import { seedBrowserFixtures, testCredentials } from "../support/seed.js";
import { startTestDatabase } from "./database.js";

// These queue tests control job claims manually; executable API tests exercise the real service.
vi.mock("../../src/images/service.js", () => ({
  imageProcessingStatus: () => ({ ready: true, lastError: null }),
}));

let stop: (() => Promise<void>) | undefined;
let fixture: Awaited<ReturnType<typeof seedBrowserFixtures>>;
let token: string;
let dir: string;
let bytes: Buffer;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "image-integration-"));
  c.staging = dir;
  c.metric = process.execPath;
  stop = await startTestDatabase();
  fixture = await seedBrowserFixtures();
  token = (
    await request(app)
      .post("/api/auth/login")
      .send({ method: "EMAIL_PASSWORD", ...testCredentials })
      .expect(200)
  ).body.token;
  bytes = await sharp({ create: { width: 32, height: 16, channels: 3, background: "#ac2255" } })
    .png()
    .toBuffer();
});
afterAll(async () => {
  await stop?.();
  if (dir) await rm(dir, { recursive: true, force: true });
});
const owner = () => ({
  businessId: fixture.business._id,
  userId: fixture.user._id,
  scope: "catalog",
  profile: "photo",
  pipelineVersion,
});
const output = () => ({ bytes, mime: "image/png", width: 32, height: 16 });
it("lists the company library across profiles without exposing another tenant or binary data", async () => {
  const own = await storeOutput(fixture.business._id, output(), "photo");
  const second = await storeOutput(
    fixture.business._id,
    { ...output(), bytes: Buffer.from("second output") },
    "display",
  );
  const foreign = await storeOutput(new mongoose.Types.ObjectId(), output(), "photo");
  const list = (query: string) =>
    request(app).get(`/api/images/library?scope=menu&${query}`).auth(token, { type: "bearer" });
  const first = await list("limit=1").expect(200);
  expect(first.body.items).toHaveLength(1);
  expect(first.body.items[0].id).toBe(String(second._id));
  expect(first.body.items[0].bytes).toBeUndefined();
  const next = await list(`limit=1&before=${first.body.nextCursor}`).expect(200);
  expect(next.body.items[0].id).toBe(String(own._id));
  expect(next.body.nextCursor).toBeNull();
  expect(
    [...first.body.items, ...next.body.items].some(
      (image: any) => image.id === String(foreign._id),
    ),
  ).toBe(false);
  await list("before=invalid").expect(422);
  await list("limit=10000").expect(422);
  await request(app).get("/api/images/library?scope=menu").expect(401);
  await request(app)
    .get("/api/images/library?scope=unknown")
    .auth(token, { type: "bearer" })
    .expect(422);
});
it("durably stages an authorized upload, publishes status and attaches only the ready tenant image", async () => {
  const uploaded = await request(app)
    .post("/api/images/jobs?scope=catalog&profile=photo")
    .auth(token, { type: "bearer" })
    .set("Content-Type", "application/octet-stream")
    .send(bytes)
    .expect(202);
  expect(await readFile(sourcePath(uploaded.body.jobId))).toEqual(bytes);
  const job = await claimJob("worker-a");
  expect(job.state).toBe("processing");
  const image = await storeOutput(fixture.business._id, output(), "photo");
  expect((await finishJob(job._id, "worker-a", image._id)).modifiedCount).toBe(1);
  const status = await request(app)
    .get(`/api/images/jobs/${job._id}`)
    .auth(token, { type: "bearer" })
    .expect(200);
  expect(status.body.imageUrl).toBe(`/api/images/${image._id}`);
  await assertImageReferences([status.body.imageUrl], fixture.business._id);
  const product = fixture.products[0];
  if (!product) throw new Error("Missing fixture");
  await request(app)
    .put(`/api/catalog/products/${product._id}`)
    .auth(token, { type: "bearer" })
    .send({ name: product.name, basePrice: 100, mediaUrls: [status.body.imageUrl] })
    .expect(200);
  const privateResponse = await request(app)
    .get(status.body.imageUrl)
    .auth(token, { type: "bearer" })
    .expect(200);
  expect(privateResponse.body).toEqual(bytes);
  await request(app).get(`/api/public/images/${image._id}`).expect(200);
  await LandingPage.updateOne(
    { businessId: fixture.business._id },
    { $set: { isPublished: false } },
  );
  await request(app).get(`/api/public/images/${image._id}`).expect(404);
  await request(app).get(status.body.imageUrl).expect(401);
});
it("deduplicates concurrent outputs per tenant and prevents cross-tenant attachment", async () => {
  const [a, b] = await Promise.all([
    storeOutput(fixture.business._id, output(), "photo"),
    storeOutput(fixture.business._id, output(), "photo"),
  ]);
  expect(String(a._id)).toBe(String(b._id));
  const other = new mongoose.Types.ObjectId();
  const foreign = await storeOutput(other, output(), "photo");
  expect(String(foreign._id)).not.toBe(String(a._id));
  await expect(
    assertImageReferences([`/api/images/${foreign._id}`], fixture.business._id),
  ).rejects.toThrow("business");
  await request(app).get(`/api/images/${foreign._id}`).auth(token, { type: "bearer" }).expect(404);
  expect((await StoredImage.findById(a._id).lean())?.bytes).toBeUndefined();
});
it("reclaims expired work, fences stale completion and survives insertion-before-completion crash", async () => {
  const job = await ImageJob.create(owner());
  const first = await claimJob("old");
  expect(String(first._id)).toBe(String(job._id));
  const image = await storeOutput(fixture.business._id, output(), "photo");
  await ImageJob.updateOne({ _id: job._id }, { $set: { leaseUntil: new Date(0) } });
  const second = await claimJob("new");
  expect(second.attempts).toBe(2);
  expect((await finishJob(job._id, "old", image._id)).modifiedCount).toBe(0);
  const again = await storeOutput(fixture.business._id, output(), "photo");
  expect(String(again._id)).toBe(String(image._id));
  expect((await finishJob(job._id, "new", again._id)).modifiedCount).toBe(1);
});
it("serializes worker claims and terminates exhausted retries", async () => {
  expect(await acquireLock("test-singleton", "one")).toBeTruthy();
  expect(await acquireLock("test-singleton", "two")).toBeNull();
  await releaseLock("test-singleton", "one");
  await ImageJob.create({ ...owner(), attempts: c.attempts - 1 });
  const job = await claimJob("exhausted");
  await failJob(job, "exhausted", "Quality rejected");
  expect((await ImageJob.findById(job._id)).state).toBe("failed");
});
it("cleans only terminal files, preserves active files and never removes referenced bytes", async () => {
  const old = new Date(Date.now() - c.graceMs * 3);
  const job = await ImageJob.create({ ...owner(), state: "failed" });
  await writeFile(sourcePath(String(job._id)), bytes);
  await ImageJob.collection.updateOne({ _id: job._id }, { $set: { updatedAt: old } });
  const active = await ImageJob.create(owner());
  await writeFile(sourcePath(String(active._id)), bytes);
  const count = await StoredImage.countDocuments();
  await cleanup();
  await expect(stat(sourcePath(String(job._id)))).rejects.toThrow();
  expect((await stat(sourcePath(String(active._id)))).size).toBe(bytes.length);
  expect(await StoredImage.countDocuments()).toBe(count);
  expect((await ImageJob.findById(job._id)).expireAt).toBeTruthy();
  await ImageJob.deleteOne({ _id: active._id });
});
it("rejects missing references without changing a saved product and preserves HTTPS URLs", async () => {
  const product = await CatalogProduct.findById(fixture.products[0]?._id);
  const before = product.mediaUrls;
  await request(app)
    .put(`/api/catalog/products/${product._id}`)
    .auth(token, { type: "bearer" })
    .send({
      name: product.name,
      basePrice: 100,
      mediaUrls: [`/api/images/${new mongoose.Types.ObjectId()}`],
    })
    .expect(422);
  expect((await CatalogProduct.findById(product._id)).mediaUrls).toEqual(before);
  await request(app)
    .put(`/api/catalog/products/${product._id}`)
    .auth(token, { type: "bearer" })
    .send({ name: product.name, basePrice: 100, mediaUrls: ["https://example.test/photo.jpg"] })
    .expect(200);
});
it("backpressures uploads and forbids unsupported scopes", async () => {
  await request(app)
    .post("/api/images/jobs?scope=unknown")
    .auth(token, { type: "bearer" })
    .set("Content-Type", "application/octet-stream")
    .send(bytes)
    .expect(422);
  const previous = c.stagingBytes;
  c.stagingBytes = 1;
  try {
    await request(app)
      .post("/api/images/jobs?scope=catalog")
      .auth(token, { type: "bearer" })
      .set("Content-Type", "application/octet-stream")
      .send(bytes)
      .expect(429);
  } finally {
    c.stagingBytes = previous;
  }
});
