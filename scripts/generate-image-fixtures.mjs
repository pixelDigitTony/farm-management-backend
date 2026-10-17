// Generated non-customer fixtures. These cover codecs/patterns, not real farm photography.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";

const directory = resolve(process.argv[2] ?? "artifacts/image-fixtures");
const count = Number(process.argv[3] ?? 100);
if (!Number.isInteger(count) || count < 1 || count > 1000)
  throw new Error("Fixture count must be 1–1000");
await mkdir(directory, { recursive: true });
const fixtures = [];
for (let index = 0; index < count; index++) {
  const width = [32, 128, 320, 512, 1024][index % 5];
  const height = Math.max(1, Math.round(width * [0.6, 1, 1.5][index % 3]));
  const channels = index % 4 === 0 ? 4 : 3;
  const pixels = Buffer.alloc(width * height * channels);
  let seed = index + 12345;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const offset = (y * width + x) * channels;
      const gradient = Math.floor((255 * x) / width);
      pixels[offset] = index % 2 ? seed & 255 : gradient;
      pixels[offset + 1] = index % 3 ? (gradient + y) % 256 : 20 + (seed & 31);
      pixels[offset + 2] = x % 16 < 2 || y % 16 < 2 ? 240 : 40 + (seed & 31);
      if (channels === 4) pixels[offset + 3] = Math.floor((255 * y) / height);
    }
  const format = ["png", "jpeg", "webp", "avif"][index % 4];
  let pipeline = sharp(pixels, { raw: { width, height, channels } });
  if (index % 7 === 0) pipeline = pipeline.withMetadata({ orientation: 6 });
  const bytes = await pipeline[format]({
    quality: 85,
    ...(format === "png" ? {} : { effort: 0 }),
  }).toBuffer();
  const path = join(directory, `fixture-${String(index).padStart(3, "0")}.${format}`);
  await writeFile(path, bytes);
  fixtures.push({
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    category: `${channels === 4 ? "alpha-gradient" : index % 2 ? "noise" : "fine-grid"}-${format}`,
  });
}
await writeFile(
  join(directory, "manifest.json"),
  `${JSON.stringify({ fixtures, passes: 5, profiles: ["avatar", "photo", "display", "preserve"] }, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    directory,
    count,
    note: "Synthetic corpus; add authorized photos, ICC/CMYK/16-bit and near-limit fixtures for release acceptance",
  }),
);
