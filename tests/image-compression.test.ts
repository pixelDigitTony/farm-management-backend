import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { makeReference, metric, smallestPassing, validateSource } from "../src/images/compress.js";
import { imageConfig } from "../src/images/config.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "image-unit-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
it("rejects spoofed images and unsupported animation", async () => {
  await expect(validateSource(Buffer.from("<svg/>"))).rejects.toThrow();
  // Two-frame GIF fixture, rejected regardless of the MIME header or extension.
  await expect(
    validateSource(
      Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
    ),
  ).rejects.toThrow("still");
});
it("rejects decoded pixels before allocating a reference", async () => {
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#fff" } })
    .png()
    .toBuffer();
  const previous = imageConfig.maxPixels;
  imageConfig.maxPixels = 100;
  try {
    await expect(validateSource(bytes)).rejects.toThrow();
  } finally {
    imageConfig.maxPixels = previous;
  }
});
it("rotates once, strips metadata and does not upscale", async () => {
  const source = join(dir, "oriented.jpg");
  await sharp({ create: { width: 30, height: 20, channels: 3, background: "#ab4567" } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toFile(source);
  const { reference } = await makeReference(source, "photo");
  const m = await sharp(reference).metadata();
  expect([m.width, m.height]).toEqual([20, 30]);
  expect(m.exif).toBeUndefined();
});
it("resizes photos but retains exact preservation dimensions and alpha", async () => {
  const source = join(dir, "alpha.png");
  await sharp({ create: { width: 600, height: 300, channels: 4, background: "#ff000080" } })
    .png()
    .toFile(source);
  const avatar = await sharp((await makeReference(source, "avatar")).reference).metadata();
  expect([avatar.width, avatar.height, avatar.hasAlpha]).toEqual([512, 256, true]);
  const preserved = await sharp((await makeReference(source, "preserve")).reference).metadata();
  expect([preserved.width, preserved.height]).toEqual([600, 300]);
});
it("selects the smallest passing candidate without assuming monotonic size or scores", () => {
  const candidate = (length: number, score: number) => ({
    bytes: Buffer.alloc(length),
    score,
    mime: "image/webp",
  });
  const efficient = candidate(20, 100);
  expect(
    smallestPassing([candidate(100, 90), candidate(10, 79), efficient, candidate(80, 81)]),
  ).toBe(efficient);
  expect(smallestPassing([candidate(10, 79)])).toBeUndefined();
});
it("fails clearly without the quality tool", async () => {
  const previous = imageConfig.metric;
  imageConfig.metric = "";
  try {
    await expect(metric("unused", "unused")).rejects.toThrow("SSIMULACRA2_BIN");
  } finally {
    imageConfig.metric = previous;
  }
});
