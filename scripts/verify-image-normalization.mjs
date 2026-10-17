// Offline integration check against Sharp's independently normalized pixels.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { assess, makeReference } from "../dist/images/compress.js";
import { imageConfig, processorConfig } from "../dist/images/config.js";
import { encodeRust, prepareRustProcessor, readProcessorOutput } from "../dist/images/rust.js";

const root = await mkdtemp(join(tmpdir(), "farm-normalization-"));
imageConfig.staging = root;
imageConfig.threshold = 100;
imageConfig.dimensions.avatar = 16;
processorConfig.engine = "rust";
const solid = () =>
  sharp({ create: { width: 64, height: 48, channels: 3, background: "#b3628b" } });
const rgba = Buffer.alloc(64 * 48 * 4);
for (let i = 0; i < rgba.length; i += 4) {
  rgba[i] = 180;
  rgba[i + 1] = i % 255;
  rgba[i + 2] = 65;
  rgba[i + 3] = Math.floor(i / 4) % 256;
}
const cases = [
  {
    name: "oriented",
    profile: "preserve",
    bytes: await solid().withMetadata({ orientation: 6 }).jpeg().toBuffer(),
  },
  {
    name: "p3-profile",
    profile: "preserve",
    bytes: await solid().withIccProfile("p3").png().toBuffer(),
  },
  {
    name: "cmyk",
    profile: "preserve",
    bytes: await solid().toColourspace("cmyk").jpeg().toBuffer(),
  },
  {
    name: "grayscale",
    profile: "preserve",
    bytes: await solid().toColourspace("b-w").png().toBuffer(),
  },
  {
    name: "16-bit",
    profile: "preserve",
    bytes: await solid().toColourspace("rgb16").png().toBuffer(),
  },
  {
    name: "alpha-resize",
    profile: "avatar",
    bytes: await sharp(rgba, { raw: { width: 64, height: 48, channels: 4 } })
      .png()
      .toBuffer(),
  },
  {
    name: "tiny-png-preserve",
    profile: "preserve",
    bytes: await solid().resize(8, 8).png().toBuffer(),
  },
];
const results = [];
try {
  await prepareRustProcessor();
  for (const [index, fixture] of cases.entries()) {
    const source = join(root, `${index}.source`);
    const work = join(root, `${index}.work`);
    await mkdir(work, { mode: 0o700 });
    await writeFile(source, fixture.bytes, { mode: 0o600 });
    try {
      const oracle = (await makeReference(source, fixture.profile)).reference;
      const metadata = await encodeRust(
        source,
        fixture.profile,
        work,
        new AbortController().signal,
      );
      const output = await readProcessorOutput(work, metadata);
      const baseline = await sharp(oracle)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const candidate = await sharp(output.bytes)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const dimensionsMatch =
        baseline.info.width === candidate.info.width &&
        baseline.info.height === candidate.info.height;
      const alphaMatches =
        dimensionsMatch &&
        baseline.data.every((value, i) => i % 4 !== 3 || value === candidate.data[i]);
      const score = await assess(oracle, output.bytes, work);
      let maxChannelDifference = 0;
      if (dimensionsMatch)
        for (let i = 0; i < baseline.data.length; i++)
          maxChannelDifference = Math.max(
            maxChannelDifference,
            Math.abs(baseline.data[i] - candidate.data[i]),
          );
      results.push({
        name: fixture.name,
        dimensionsMatch,
        alphaMatches,
        pixelsMatch: baseline.data.equals(candidate.data),
        score,
        maxChannelDifference,
      });
    } catch (error) {
      results.push({ name: fixture.name, error: String(error) });
    }
  }
  const report = {
    results,
    passed: results.every(
      (row) => !row.error && row.dimensionsMatch && row.alphaMatches && row.score >= 80,
    ),
    exactNormalizationPassed: results.every((row) => row.pixelsMatch),
    note: "Small synthetic normalization check; color/reference differences still require investigation before release acceptance",
  };
  if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  if (!report.passed) process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
