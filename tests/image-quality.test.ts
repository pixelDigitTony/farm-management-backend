import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import { assess, compressImage, validateSource } from "../src/images/compress.js";
import { imageConfig as c } from "../src/images/config.js";

it("rejects APNG chunks even when the decoder would return a still first frame", async () => {
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from([0, 0, 0, 8]),
    Buffer.from("acTL"),
    Buffer.alloc(12),
  ]);
  await expect(validateSource(bytes)).rejects.toThrow("Animated");
});
it.runIf(Boolean(process.env.SSIMULACRA2_BIN))(
  "uses the real metric, validates transparency and fails if even lossless exceeds policy",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "quality-real-"));
    const previous = c.maxOutput;
    try {
      const bytes = await sharp({
        create: { width: 32, height: 24, channels: 4, background: "#aa776680" },
      })
        .png()
        .toBuffer();
      const source = join(directory, "source");
      await writeFile(source, bytes);
      const chosen = await compressImage(source, "preserve", directory);
      expect(chosen.score).toBe(100);
      expect(chosen.bytes.length).toBeLessThanOrEqual(bytes.length);
      const noAlpha = await sharp(bytes).flatten().png().toBuffer();
      expect(await assess(bytes, noAlpha, directory)).toBe(-Infinity);
      const wrongSize = await sharp(bytes).resize(16, 12).png().toBuffer();
      await expect(assess(bytes, wrongSize, directory)).rejects.toThrow("dimensions");
      c.maxOutput = 1;
      await expect(compressImage(source, "preserve", directory)).rejects.toThrow("No image meets");
    } finally {
      c.maxOutput = previous;
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
