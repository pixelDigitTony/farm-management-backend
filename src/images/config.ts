import { createHash } from "node:crypto";
import { resolve } from "node:path";

function integer(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}`);
  return value;
}
export const imageConfig = {
  staging: process.env.IMAGE_STAGING_DIR ? resolve(process.env.IMAGE_STAGING_DIR) : "",
  metric: process.env.SSIMULACRA2_BIN ?? "",
  maxBytes: integer("IMAGE_MAX_BYTES", 20 * 1024 * 1024),
  maxPixels: integer("IMAGE_MAX_PIXELS", 24_000_000),
  maxFrames: integer("IMAGE_MAX_FRAMES", 1, 1, 1),
  maxOutput: integer("IMAGE_MAX_OUTPUT_BYTES", 12 * 1024 * 1024, 1, 14 * 1024 * 1024),
  stagingBytes: integer("IMAGE_STAGING_BYTES", 1024 * 1024 * 1024),
  queueLimit: integer("IMAGE_QUEUE_LIMIT", 40),
  leaseMs: integer("IMAGE_LEASE_MS", 60_000, 10_000),
  timeoutMs: integer("IMAGE_TIMEOUT_MS", 180_000),
  attempts: integer("IMAGE_MAX_ATTEMPTS", 3),
  graceMs: integer("IMAGE_CLEANUP_GRACE_MS", 3600_000, 60_000),
  retentionMs: integer("IMAGE_JOB_RETENTION_MS", 7 * 86400_000),
  threshold: integer("IMAGE_QUALITY_THRESHOLD", 80, 1, 100),
  avifMin: integer("IMAGE_AVIF_MIN", 45, 1, 100),
  avifMax: integer("IMAGE_AVIF_MAX", 75, 1, 100),
  webpMin: integer("IMAGE_WEBP_MIN", 70, 1, 100),
  webpMax: integer("IMAGE_WEBP_MAX", 92, 1, 100),
  effort: integer("IMAGE_EFFORT", 6, 0, 6),
  concurrency: integer("IMAGE_CONCURRENCY", 1, 1, 1),
  dimensions: {
    avatar: integer("IMAGE_AVATAR_PX", 512),
    photo: integer("IMAGE_PHOTO_PX", 1600),
    display: integer("IMAGE_DISPLAY_PX", 2400),
    preserve: 0,
  },
};
if (imageConfig.avifMin > imageConfig.avifMax || imageConfig.webpMin > imageConfig.webpMax)
  throw new Error("Invalid image quality bounds");
export type ImageProfile = keyof typeof imageConfig.dimensions;
export const pipelineVersion =
  "adaptive-v1-sharp-0.35.4-libjxl-0.11.1-" +
  createHash("sha256")
    .update(JSON.stringify({ ...imageConfig, staging: "", metric: "" }))
    .digest("hex")
    .slice(0, 16);
export function assertImageConfig() {
  if (!imageConfig.staging || !imageConfig.metric)
    throw new Error(
      "Configure persistent IMAGE_STAGING_DIR and pinned SSIMULACRA2_BIN; see deploy/IMAGES.md",
    );
}
