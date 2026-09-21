import { randomUUID } from "node:crypto";
import { access, constants, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ImageJob, ImageLock, StoredImage } from "../models/image.models.js";
import { assertImageConfig, imageConfig as c, pipelineVersion } from "./config.js";
import { encodeInProcess } from "./process.js";
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
let running: Promise<void> | undefined;
let ready = false;
let lastError: string | null = null;
export const imageProcessingStatus = () => ({ ready, lastError });

// Uses the API's database connection. Importing this module never starts processing.
export async function startImageProcessing() {
  if (running) return;
  stopping = false;
  try {
    assertImageConfig();
    await access(c.metric, constants.X_OK);
    await prepareStaging();
    for (const model of [ImageJob, ImageLock, StoredImage]) await model.createIndexes();
    ready = true;
    lastError = null;
    running = run()
      .catch((error) => {
        ready = false;
        lastError = "Image processor stopped unexpectedly";
        console.error(lastError, error);
      })
      .finally(() => {
        running = undefined;
      });
  } catch (error) {
    ready = false;
    lastError =
      "Image processing unavailable: check persistent staging and SSIMULACRA2 configuration";
    console.error(lastError, error);
  }
}

export async function stopImageProcessing() {
  ready = false;
  stopping = true;
  encoding?.abort();
  await running;
}

async function run() {
  console.log("Backend image processor started", { pipelineVersion, concurrency: 1 });
  while (!stopping) {
    const token = randomUUID();
    if (!(await acquireLock("image-worker", token))) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    let lost = false;
    let renewing: Promise<void> | undefined;
    const renewal = setInterval(
      () => {
        if (renewing || stopping) return;
        renewing = (async () => {
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
        })().finally(() => {
          renewing = undefined;
        });
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
        if (stopping || lost) throw new Error("Image processing stopped");
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
          "Image processing failed. Use a still image within limits; ask the administrator to check backend image processing, then retry.",
        );
      } finally {
        encoding = undefined;
        await rm(directory, { recursive: true, force: true });
      }
    } catch (error) {
      console.error("Image processor iteration failed", error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } finally {
      clearInterval(renewal);
      await renewing;
      await releaseLock("image-worker", token);
    }
  }
}
