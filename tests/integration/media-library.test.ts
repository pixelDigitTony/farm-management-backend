import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { app } from "../../src/app.js";
import { imageConfig as c, pipelineVersion } from "../../src/images/config.js";
import { trashedImageMessage } from "../../src/images/library.js";
import { claimJob, finishJob, storeOutput } from "../../src/images/queue.js";
import { assertImageReferences } from "../../src/images/references.js";
import { ImageJob, StoredImage } from "../../src/models/image.models.js";
import { Business, CatalogProduct, User } from "../../src/models/index.js";
import { seedBrowserFixtures, testCredentials } from "../support/seed.js";
import { startTestDatabase } from "./database.js";

vi.mock("../../src/images/service.js", () => ({ imageProcessingStatus: () => ({ ready: true }) }));
let stop: (() => Promise<void>) | undefined;
let fixture: Awaited<ReturnType<typeof seedBrowserFixtures>>;
let token: string;
let directory: string;
const bytes = Buffer.from("isolated-image-bytes");
const output = { bytes, mime: "image/png", width: 32, height: 16 };
const signed = (method: "get" | "post", path: string) =>
  request(app)[method](path).auth(token, { type: "bearer" });
const postUpload = (query = "") =>
  signed("post", `/api/images/jobs?scope=media-library${query}`)
    .set("Content-Type", "application/octet-stream")
    .send(bytes);
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "media-library-"));
  c.staging = directory;
  c.metric = process.execPath;
  stop = await startTestDatabase();
  fixture = await seedBrowserFixtures();
  token = (
    await request(app)
      .post("/api/auth/login")
      .send({ method: "EMAIL_PASSWORD", ...testCredentials })
      .expect(200)
  ).body.token;
});
beforeEach(async () => {
  await StoredImage.deleteMany({});
  await ImageJob.deleteMany({});
  await User.updateOne({ _id: fixture.user._id }, { $set: { role: 0 } });
  await Business.updateOne(
    { _id: fixture.business._id },
    {
      $set: {
        roles: [
          { level: 0, name: "Owner" },
          { level: 1, name: "Staff", permissions: [] },
        ],
      },
    },
  );
});
afterAll(async () => {
  await stop?.();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function staff(permissions: string[]) {
  await User.updateOne({ _id: fixture.user._id }, { $set: { role: 1 } });
  await Business.updateOne(
    { _id: fixture.business._id },
    { $set: { "roles.1.permissions": permissions } },
  );
}
it("separates active/trash discovery, retains metadata pagination and prevents tenant leakage", async () => {
  const active = await storeOutput(fixture.business._id, output, "photo");
  const trashed = await storeOutput(
    fixture.business._id,
    { ...output, bytes: Buffer.from("second") },
    "photo",
  );
  const foreign = await storeOutput(new mongoose.Types.ObjectId(), output, "photo");
  await signed("post", `/api/images/${trashed._id}/trash`).expect(204);
  const list = await signed("get", "/api/images/library?scope=media-library&limit=1").expect(200);
  expect(list.body.items.map((x: any) => x.id)).toEqual([String(active._id)]);
  expect(list.body.items[0].bytes).toBeUndefined();
  expect(list.body.nextCursor).toBeNull();
  const trash = await signed("get", "/api/images/library?scope=media-library&status=trash").expect(
    200,
  );
  expect(trash.body.items.map((x: any) => x.id)).toEqual([String(trashed._id)]);
  await signed("get", "/api/images/library?scope=catalog&status=trash").expect(403);
  await signed("get", "/api/images/library?scope=media-library&status=invalid").expect(422);
  await signed("post", `/api/images/${foreign._id}/trash`).expect(404);
  await signed("post", `/api/images/${foreign._id}/restore`).expect(404);
  await signed("post", "/api/images/invalid/trash").expect(404);
});
it("trashes and restores idempotently while retaining existing private/public image uses", async () => {
  const image = await storeOutput(fixture.business._id, output, "photo");
  const url = `/api/images/${image._id}`;
  await CatalogProduct.updateOne({ _id: fixture.products[0]?._id }, { $set: { mediaUrls: [url] } });
  await signed("post", `${url}/trash`).expect(204);
  const first = await StoredImage.findById(image._id).lean();
  expect(String(first?.trashedBy)).toBe(String(fixture.user._id));
  await signed("post", `${url}/trash`).expect(204);
  expect((await StoredImage.findById(image._id).lean())?.trashedAt).toEqual(first?.trashedAt);
  expect((await signed("get", url).expect(200)).body).toEqual(bytes);
  await request(app).get(`/api/public/images/${image._id}`).expect(200);
  await assertImageReferences([url, { mediaUrlSnapshot: url }], fixture.business._id);
  await signed("post", `${url}/restore`).expect(204);
  await signed("post", `${url}/restore`).expect(204);
  expect((await StoredImage.findById(image._id).lean())?.trashedAt).toBeUndefined();
});
it("enforces view, create, edit plus create, and delete independently", async () => {
  const image = await storeOutput(fixture.business._id, output, "photo");
  await staff([]);
  await signed("get", "/api/images/library?scope=media-library").expect(403);
  await staff(["media-library:view"]);
  await signed("get", "/api/images/library?scope=media-library").expect(200);
  await signed("get", `/api/images/${image._id}`).expect(200);
  await postUpload().expect(403);
  await signed("post", `/api/images/${image._id}/trash`).expect(403);
  await staff(["media-library:view", "media-library:edit"]);
  await postUpload().expect(403);
  await staff(["media-library:view", "media-library:create"]);
  await postUpload(`&sourceImageId=${image._id}`).expect(403);
  await postUpload().expect(202);
  await staff(["media-library:view", "media-library:create", "media-library:edit"]);
  await postUpload(`&sourceImageId=${image._id}`).expect(202);
  await postUpload(`&sourceImageId=${new mongoose.Types.ObjectId()}`).expect(404);
  await staff(["media-library:view", "media-library:delete"]);
  await signed("post", `/api/images/${image._id}/trash`).expect(204);
  await signed("post", `/api/images/${image._id}/restore`).expect(204);
});
it("keeps legacy roles out of the management page and preserves feature picker access", async () => {
  await User.updateOne({ _id: fixture.user._id }, { $set: { role: 1 } });
  await Business.updateOne({ _id: fixture.business._id }, { $unset: { "roles.1.permissions": 1 } });
  await signed("get", "/api/images/library?scope=media-library").expect(403);
  await signed("get", "/api/images/library?scope=menu").expect(200);
});
it("reuses active cached uploads but rejects trashed duplicates in cache and output deduplication", async () => {
  const uploaded = await postUpload().expect(202);
  const job = await claimJob("cache");
  const image = await storeOutput(fixture.business._id, output, "photo");
  await finishJob(job._id, "cache", image._id);
  const reused = await postUpload().expect(202);
  expect(reused.body.state).toBe("ready");
  await signed("post", `/api/images/${image._id}/trash`).expect(204);
  const rejected = await postUpload().expect(409);
  expect(rejected.body.message).toBe(trashedImageMessage);
  await expect(storeOutput(fixture.business._id, output, "photo")).rejects.toThrow(
    trashedImageMessage,
  );
  const stale = await signed("get", `/api/images/jobs/${uploaded.body.jobId}`).expect(200);
  expect(stale.body.state).toBe("failed");
  expect(stale.body.imageUrl).toBeUndefined();
  expect((await StoredImage.findById(image._id).lean())?.trashedAt).toBeTruthy();
});
it("guards completion after trash and never resurrects images during concurrent reuse", async () => {
  const image = await storeOutput(fixture.business._id, output, "photo");
  await ImageJob.create({
    businessId: fixture.business._id,
    userId: fixture.user._id,
    scope: "media-library",
    profile: "photo",
    pipelineVersion,
  });
  const job = await claimJob("race");
  await signed("post", `/api/images/${image._id}/trash`).expect(204);
  await expect(finishJob(job._id, "race", image._id)).rejects.toThrow(trashedImageMessage);
  await Promise.allSettled([
    storeOutput(fixture.business._id, output, "photo"),
    signed("post", `/api/images/${image._id}/trash`),
  ]);
  expect((await StoredImage.findById(image._id).lean())?.trashedAt).toBeTruthy();
  await assertImageReferences([`/api/images/${image._id}`], fixture.business._id);
});
