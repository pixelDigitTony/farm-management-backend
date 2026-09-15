import mongoose from "mongoose";
import { createModel, objectId, schemaOptions } from "./helpers.js";

const { Schema } = mongoose;
const image = new Schema(
  {
    businessId: objectId("Business", true),
    bytes: { type: Buffer, required: true, select: false },
    mime: String,
    width: Number,
    height: Number,
    byteLength: Number,
    sha256: String,
    profile: String,
    pipelineVersion: String,
  },
  { ...schemaOptions, writeConcern: { w: "majority", j: true } },
);
image.index({ businessId: 1, sha256: 1 }, { unique: true });
export const StoredImage = createModel("StoredImage", image);
const job = new Schema(
  {
    businessId: objectId("Business", true),
    userId: objectId("User", true),
    scope: String,
    sourceHash: String,
    profile: String,
    pipelineVersion: String,
    state: { type: String, enum: ["queued", "processing", "ready", "failed"], default: "queued" },
    imageId: objectId("StoredImage"),
    attempts: { type: Number, default: 0 },
    nextAt: { type: Date, default: Date.now },
    leaseUntil: Date,
    token: String,
    error: String,
    cleanedAt: Date,
    expireAt: Date,
  },
  { ...schemaOptions, writeConcern: { w: "majority", j: true } },
);
job.index({ state: 1, nextAt: 1, leaseUntil: 1 });
job.index({ businessId: 1, sourceHash: 1, profile: 1, pipelineVersion: 1 });
job.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
export const ImageJob = createModel("ImageJob", job);
const lock = new Schema({ _id: String, token: String, until: Date, heartbeat: Date });
export const ImageLock = createModel("ImageLock", lock);
