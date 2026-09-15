import { encodeInProcess } from "./process.js";
import "dotenv/config";

import { randomUUID } from "node:crypto";
import { access, constants, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { ImageJob, ImageLock, StoredImage } from "../models/image.models.js";
import { assertImageConfig, imageConfig as c, pipelineVersion } from "./config.js";
import {
  acquireLock,
  claimJob,
  cleanup,
  failJob,
  finishJob,
  ownedJob,
  prepareStaging,
  releaseLock,
  sourcePath,
  storeOutput,
} from "./queue.js";

let stopping = false;
let encoding: AbortController | undefined;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
    encoding?.abort();
  });
async function run() {
  assertImageConfig();
  await access(c.metric, constants.X_OK);
  await prepareStaging();
  await mongoose.connect(env.MONGODB_URI, {
    autoIndex: false,
    dbName: env.NODE_ENV === "test" ? undefined : "MissVBusiness",
  });
  for (const model of [ImageJob, ImageLock, StoredImage]) await model.createIndexes();
  console.log("Image worker started", { pipelineVersion, concurrency: 1 });
  while (!stopping) {
    const token = randomUUID();
    if (!(await acquireLock("image-worker", token))) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    let lost = false;
    const renewal = setInterval(
      async () => {
        try {
          const result = await ImageLock.updateOne(
            { _id: "image-worker", token, until: { $gt: new Date() } },
            { $set: { until: new Date(Date.now() + c.leaseMs), heartbeat: new Date() } },
          );
          if (!result.modifiedCount) throw new Error("Lease lost");
          await ImageJob.updateMany(
            { token, state: "processing", leaseUntil: { $gt: new Date() } },
            { $set: { leaseUntil: new Date(Date.now() + c.leaseMs) } },
          );
        } catch {
          lost = true;
          encoding?.abort();
        }
      },
      Math.floor(c.leaseMs / 3),
    );
    try {
      const job = await claimJob(token);
      if (!job) {
        await cleanup();
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      const directory = join(c.staging, `${job._id}.work-${token}`);
      await mkdir(directory, { mode: 0o700 });
      try {
        if (job.attempts > c.attempts) throw new Error("Retries exhausted");
        if (job.pipelineVersion !== pipelineVersion)
          throw new Error("Pipeline changed; upload again");
        const cached =
          job.sourceHash &&
          (await ImageJob.findOne({
            businessId: job.businessId,
            sourceHash: job.sourceHash,
            profile: job.profile,
            pipelineVersion: job.pipelineVersion,
            state: "ready",
            _id: { $ne: job._id },
          }).lean());
        const cachedImage =
          cached &&
          (await StoredImage.findOne({ _id: cached.imageId, businessId: job.businessId }));
        if (cachedImage) {
          const completed = await finishJob(job._id, token, cachedImage._id);
          if (!completed.modifiedCount) throw new Error("Lease lost before cached completion");
          await rm(sourcePath(String(job._id)), { force: true });
          await ImageJob.updateOne(
            { _id: job._id, state: "ready", token },
            { $set: { cleanedAt: new Date(), expireAt: new Date(Date.now() + c.retentionMs) } },
          );
          console.log("Image source cache reused", { id: String(job._id) });
          continue;
        }
        encoding = new AbortController();
        const metadata = await encodeInProcess(
          sourcePath(String(job._id)),
          job.profile,
          directory,
          encoding.signal,
        );
        if (lost || stopping || !(await ImageJob.exists(ownedJob(job._id, token))))
          throw new Error("Lease lost");
        const bytes = await readFile(join(directory, "output"));
        const image = await storeOutput(
          job.businessId,
          { bytes, mime: metadata.mime, width: metadata.width, height: metadata.height },
          job.profile,
        );
        const completed = await finishJob(job._id, token, image._id);
        if (!completed.modifiedCount) throw new Error("Lease lost before completion");
        await rm(sourcePath(String(job._id)), { force: true });
        await ImageJob.updateOne(
          { _id: job._id, state: "ready", token },
          { $set: { cleanedAt: new Date(), expireAt: new Date(Date.now() + c.retentionMs) } },
        );
        console.log("Image job ready", {
          id: String(job._id),
          bytes: bytes.length,
          score: metadata.score,
        });
      } catch (error) {
        console.error("Image job attempt failed", {
          id: String(job._id),
          attempt: job.attempts,
          error: String(error),
        });
        await failJob(
          job,
          token,
          "Image processing failed. Use a still image within limits; ask the administrator to check the worker and SSIMULACRA2, then retry.",
        );
      } finally {
        encoding = undefined;
        await rm(directory, { recursive: true, force: true });
      }
    } finally {
      clearInterval(renewal);
      await releaseLock("image-worker", token);
    }
  }
  await mongoose.disconnect();
}
run().catch((error) => {
  console.error("Image worker startup failed", error);
  process.exit(1);
});
