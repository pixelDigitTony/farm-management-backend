import { createHash, randomUUID } from "node:crypto";
import { access, constants, lstat, mkdir, open, readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { Request } from "express";
import mongoose from "mongoose";
import { HttpError } from "../lib/http-error.js";
import { ImageJob, ImageLock, StoredImage } from "../models/image.models.js";
import {
  assertImageConfig,
  imageConfig as c,
  type ImageProfile,
  pipelineVersion,
} from "./config.js";
export async function prepareStaging() {
  await mkdir(c.staging, { recursive: true, mode: 0o700 });
  const directory = await lstat(c.staging);
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0)
    throw new HttpError(503, "IMAGE_STAGING_DIR must be a private directory with mode 0700");
}
async function stagedBytes(directory: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    try {
      const info = await lstat(path);
      if (info.isFile()) total += info.size;
      else if (info.isDirectory()) total += await stagedBytes(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return total;
}
export const sourcePath = (id: string) => {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid staging identifier");
  return join(c.staging, `${id}.source`);
};
export async function acquireLock(id: string, token: string, duration = c.leaseMs) {
  try {
    return await ImageLock.findOneAndUpdate(
      { _id: id, $or: [{ until: { $lte: new Date() } }, { token }] },
      { $set: { token, until: new Date(Date.now() + duration), heartbeat: new Date() } },
      { upsert: true, returnDocument: "after" },
    );
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return null;
    throw error;
  }
}
export async function releaseLock(id: string, token: string) {
  await ImageLock.deleteOne({ _id: id, token });
}
export async function stageUpload(
  request: Request,
  businessId: mongoose.Types.ObjectId,
  userId: mongoose.Types.ObjectId,
  scope: string,
  profile: ImageProfile,
) {
  try {
    assertImageConfig();
    await access(c.metric, constants.X_OK);
  } catch {
    throw new HttpError(503, "Image uploads need persistent staging and SSIMULACRA2 configuration");
  }
  const token = randomUUID();
  if (!(await acquireLock("image-admission", token, 60_000)))
    throw new HttpError(429, "An upload is being received. Retry shortly");
  const id = new mongoose.Types.ObjectId();
  const path = sourcePath(String(id));
  let durable = false;
  const timer = setTimeout(() => request.destroy(), 30_000);
  try {
    await prepareStaging();
    const used = await stagedBytes(c.staging);
    const workspaceReserve = Math.max(256 * 1024 * 1024, c.maxPixels * 8 + c.maxOutput);
    const disk = await statfs(c.staging);
    if (
      used + c.maxBytes + workspaceReserve > c.stagingBytes ||
      disk.bavail * disk.bsize < c.maxBytes + workspaceReserve ||
      (await ImageJob.countDocuments({ state: { $in: ["queued", "processing"] } })) >= c.queueLimit
    )
      throw new HttpError(429, "Image queue or staging space is full. Retry later");
    const file = await open(path, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > c.maxBytes) throw new HttpError(413, "Image upload exceeds the byte limit");
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      if (!bytes) throw new HttpError(422, "Choose an image file");
      await file.sync();
    } finally {
      await file.close();
    }
    const directory = await open(c.staging, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    const sourceHash = hash.digest("hex");
    const cached = await ImageJob.findOne({
      businessId,
      sourceHash,
      profile,
      pipelineVersion,
      state: "ready",
    }).lean();
    const image = cached && (await StoredImage.findOne({ _id: cached.imageId, businessId }).lean());
    const job = await ImageJob.create({
      _id: id,
      businessId,
      userId,
      scope,
      profile,
      sourceHash,
      pipelineVersion,
      ...(image ? { state: "ready", imageId: image._id } : {}),
    });
    durable = true;
    if (image) {
      await rm(path, { force: true });
      await ImageJob.updateOne(
        { _id: id, state: "ready" },
        { $set: { cleanedAt: new Date(), expireAt: new Date(Date.now() + c.retentionMs) } },
      );
    }
    return job;
  } finally {
    clearTimeout(timer);
    if (!durable) await rm(path, { force: true });
    await releaseLock("image-admission", token);
  }
}
export async function claimJob(token: string) {
  return ImageJob.findOneAndUpdate(
    {
      $or: [
        { state: "queued", nextAt: { $lte: new Date() } },
        { state: "processing", leaseUntil: { $lte: new Date() } },
      ],
    },
    {
      $set: { state: "processing", token, leaseUntil: new Date(Date.now() + c.leaseMs) },
      $inc: { attempts: 1 },
    },
    { returnDocument: "after", sort: { createdAt: 1 } },
  );
}
export function ownedJob(id: unknown, token: string) {
  return { _id: id, token, state: "processing", leaseUntil: { $gt: new Date() } };
}
export async function finishJob(id: unknown, token: string, imageId: unknown) {
  return ImageJob.updateOne(ownedJob(id, token), {
    $set: { state: "ready", imageId },
    $unset: { error: 1 },
  });
}
export async function failJob(job: any, token: string, error: string) {
  const terminal = job.attempts >= c.attempts;
  return ImageJob.updateOne(ownedJob(job._id, token), {
    $set: {
      state: terminal ? "failed" : "queued",
      error,
      nextAt: new Date(Date.now() + 2000 * 2 ** job.attempts),
    },
  });
}
export async function storeOutput(
  businessId: unknown,
  result: { bytes: Buffer; mime: string; width: number; height: number },
  profile: string,
) {
  const sha256 = createHash("sha256").update(result.bytes).digest("hex");
  try {
    return await StoredImage.create({
      businessId,
      ...result,
      sha256,
      byteLength: result.bytes.length,
      profile,
      pipelineVersion,
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const image = await StoredImage.findOne({ businessId, sha256 });
    if (!image) throw error;
    return image;
  }
}
// Run only while holding the singleton worker lease. Stored images are never garbage-collected:
// this deliberately protects all drafts, order snapshots and concurrent attachments.
export async function cleanup() {
  await mkdir(c.staging, { recursive: true, mode: 0o700 });
  const cutoff = new Date(Date.now() - c.graceMs);
  const jobs = await ImageJob.find({
    state: { $in: ["ready", "failed"] },
    cleanedAt: null,
    updatedAt: { $lt: cutoff },
    $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: cutoff } }],
  }).limit(100);
  for (const job of jobs) {
    await rm(sourcePath(String(job._id)), { force: true });
    await ImageJob.updateOne(
      { _id: job._id, state: job.state },
      { $set: { cleanedAt: new Date(), expireAt: new Date(Date.now() + c.retentionMs) } },
    );
  }
  for (const name of await readdir(c.staging)) {
    const match = /^([a-f0-9]{24})\.(source|work-[a-f0-9-]+)$/.exec(name);
    if (!match) continue;
    const path = join(c.staging, name);
    const s = await stat(path);
    if (s.mtimeMs > Date.now() - Math.max(c.graceMs, c.timeoutMs + 60_000)) continue;
    const job = await ImageJob.findById(match[1]).lean();
    if (job && ["queued", "processing"].includes(job.state)) continue;
    if (job?.leaseUntil && new Date(job.leaseUntil).getTime() > Date.now() - c.graceMs) continue;
    await rm(path, { force: true, recursive: s.isDirectory() });
  }
}
