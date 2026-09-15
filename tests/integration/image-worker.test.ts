import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mongoose from "mongoose";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { imageConfig as c } from "../../src/images/config.js";
import { ImageJob, StoredImage } from "../../src/models/image.models.js";
import { seedBrowserFixtures, testCredentials } from "../support/seed.js";
import { startTestDatabase } from "./database.js";

let stop: (() => Promise<void>) | undefined;
let worker: ChildProcess | undefined;
let directory: string;
let token: string;
let workerEnv: NodeJS.ProcessEnv;
async function launch() {
  worker = spawn(process.execPath, ["dist/images/worker.js"], {
    env: workerEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stderr?.on("data", (data) => process.stderr.write(data));
}
async function halt() {
  if (!worker || worker.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => worker?.once("exit", () => resolve()));
  worker.kill("SIGTERM");
  await exited;
}
async function terminal(id: string) {
  for (let i = 0; i < 120; i++) {
    const job = await ImageJob.findById(id).lean();
    if (["ready", "failed"].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Worker did not finish in 60 seconds");
}
beforeAll(async () => {
  if (!process.env.SSIMULACRA2_BIN)
    throw new Error("Run image worker tests with the pinned SSIMULACRA2_BIN; see deploy/IMAGES.md");
  directory = await mkdtemp(join(tmpdir(), "farm-worker-"));
  c.staging = directory;
  stop = await startTestDatabase();
  await seedBrowserFixtures();
  if (!mongoose.connection.name.startsWith("farm_test_"))
    throw new Error("Refusing non-disposable database");
  const clientOptions = mongoose.connection.getClient().options;
  const host = clientOptions.hosts[0];
  if (!host) throw new Error("Missing disposable container address");
  workerEnv = {
    ...process.env,
    NODE_ENV: "test",
    EMAIL_PROVIDER: "console",
    MONGODB_URI: `mongodb://${host.toString()}/${mongoose.connection.name}?directConnection=true&replicaSet=rs0`,
    IMAGE_STAGING_DIR: directory,
    JWT_SECRET: "isolated-test-secret-not-for-production",
  };
  token = (
    await request(app)
      .post("/api/auth/login")
      .send({ method: "EMAIL_PASSWORD", ...testCredentials })
      .expect(200)
  ).body.token;
  await launch();
});
afterAll(async () => {
  await halt();
  await stop?.();
  if (directory) await rm(directory, { recursive: true, force: true });
});
it("runs upload through the actual executable worker, then reuses a verified source-cache hit", async () => {
  const bytes = await sharp({
    create: { width: 64, height: 48, channels: 3, background: "#ab5678" },
  })
    .png()
    .toBuffer();
  const upload = () =>
    request(app)
      .post("/api/images/jobs?scope=catalog&profile=photo")
      .auth(token, { type: "bearer" })
      .set("Content-Type", "application/octet-stream")
      .send(bytes)
      .expect(202);
  const first = await upload();
  const ready = await terminal(first.body.jobId);
  expect(ready.state).toBe("ready");
  const image = await StoredImage.findById(ready.imageId).select("+bytes");
  expect(image.bytes.length).toBeLessThanOrEqual(bytes.length);
  expect(await sharp(image.bytes).metadata()).toMatchObject({ width: 64, height: 48 });
  const cached = await upload();
  expect(cached.body.state).toBe("ready");
  expect((await ImageJob.findById(cached.body.jobId)).imageId.toString()).toBe(
    ready.imageId.toString(),
  );
}, 90_000);
it("recovers a queued job after a worker restart without altering application records", async () => {
  await halt();
  const bytes = await sharp({
    create: { width: 60, height: 40, channels: 4, background: "#5588aa80" },
  })
    .png()
    .toBuffer();
  const upload = await request(app)
    .post("/api/images/jobs?scope=landing-page&profile=preserve")
    .auth(token, { type: "bearer" })
    .set("Content-Type", "application/octet-stream")
    .send(bytes)
    .expect(202);
  await launch();
  const ready = await terminal(upload.body.jobId);
  expect(ready.state).toBe("ready");
  const image = await StoredImage.findById(ready.imageId).select("+bytes");
  expect((await sharp(image.bytes).metadata()).hasAlpha).toBe(true);
}, 90_000);
