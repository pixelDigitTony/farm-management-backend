// Run in the backend Docker image. Does not connect to any database.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { metric } from "../dist/images/compress.js";
import { encodeInProcess } from "../dist/images/process.js";

const directory = await mkdtemp(join(tmpdir(), "farm-image-smoke-"));
try {
  const source = join(directory, "source.png");
  const pixels = Buffer.alloc(256 * 192 * 3);
  for (let y = 0; y < 192; y++) {
    for (let x = 0; x < 256; x++) {
      const offset = (y * 256 + x) * 3;
      pixels[offset] = x;
      pixels[offset + 1] = y;
      pixels[offset + 2] = Math.floor((x + y) / 2);
    }
  }
  await sharp(pixels, { raw: { width: 256, height: 192, channels: 3 } })
    .png()
    .toFile(source);
  const identityScore = await metric(source, source);
  assert(identityScore >= 99.9, `Unexpected identity score: ${identityScore}`);
  const outputDirectory = join(directory, "encoded");
  await mkdir(outputDirectory);
  const result = await encodeInProcess(
    source,
    "photo",
    outputDirectory,
    new AbortController().signal,
  );
  const output = await readFile(join(outputDirectory, "output"));
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.width, 256);
  assert.equal(metadata.height, 192);
  assert(result.score >= 80);
  console.log(
    JSON.stringify(
      {
        verified: true,
        identityScore,
        mime: result.mime,
        score: result.score,
        originalBytes: (await readFile(source)).length,
        optimizedBytes: output.length,
        width: metadata.width,
        height: metadata.height,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
