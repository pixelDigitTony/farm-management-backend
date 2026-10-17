import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { imageConfig as c, type ImageProfile } from "./config.js";

const exec = promisify(execFile);
sharp.cache(false);
sharp.concurrency(1);
export const decode = (input: string | Buffer) =>
  sharp(input, { limitInputPixels: c.maxPixels, failOn: "warning", animated: true }).timeout({
    seconds: Math.ceil(c.timeoutMs / 1000),
  });
export async function validateSource(source: string | Buffer) {
  const input = typeof source === "string" ? await readFile(source) : source;
  if (input.length > c.maxBytes) throw new Error("Image exceeds upload byte limit");
  // libvips may decode only the first APNG frame, so inspect the actual PNG chunks too.
  if (input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    for (let offset = 8; offset + 12 <= input.length; ) {
      const length = input.readUInt32BE(offset);
      if (input.toString("ascii", offset + 4, offset + 8) === "acTL")
        throw new Error("Animated images are not supported");
      offset += length + 12;
    }
  }
  const m = await decode(source).metadata();
  if (
    !["jpeg", "png", "webp", "heif"].includes(m.format ?? "") ||
    (m.format === "heif" && m.compression !== "av1")
  )
    throw new Error("Use a still JPEG, PNG, WebP or AVIF image");
  if ((m.pages ?? 1) > c.maxFrames) throw new Error("Animated images are not supported");
  if (!m.width || !m.height || m.width * m.height > c.maxPixels)
    throw new Error("Image exceeds decoded pixel limit");
  return m;
}
let metricPeakBytes = 0;
export const getMetricPeakBytes = () => metricPeakBytes;
export async function metric(reference: string, candidate: string) {
  if (!c.metric) throw new Error("SSIMULACRA2_BIN is required; install pinned libjxl 0.11.1");
  const { stdout, stderr } = await exec(c.metric, [reference, candidate], {
    timeout: Math.min(c.timeoutMs, 30_000),
    maxBuffer: 4096,
  });
  metricPeakBytes = Math.max(
    metricPeakBytes,
    Number(/IMAGE_METRIC_PEAK_BYTES=(\d+)/.exec(stderr)?.[1] ?? 0),
  );
  const score = Number(stdout.trim());
  if (!stdout.trim() || !Number.isFinite(score))
    throw new Error("SSIMULACRA2 failed to return a score");
  return score;
}
export type Candidate = { bytes: Buffer; mime: string; score: number; quality?: number };
export function smallestPassing(candidates: Candidate[], threshold = c.threshold) {
  return candidates
    .filter((x) => x.score >= threshold && x.bytes.length <= c.maxOutput)
    .sort((a, b) => a.bytes.length - b.bytes.length)[0];
}
export async function makeReference(source: string, profile: ImageProfile) {
  const metadata = await validateSource(source);
  let pipeline = decode(source).rotate().toColourspace("srgb");
  const size = c.dimensions[profile];
  if (size)
    pipeline = pipeline.resize({
      width: size,
      height: size,
      fit: "inside",
      withoutEnlargement: true,
    });
  const reference = await pipeline.png().toBuffer();
  return { metadata, reference };
}
export async function assess(reference: Buffer, bytes: Buffer, directory: string) {
  const ref = await decode(reference).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const test = await decode(bytes)
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (ref.info.width !== test.info.width || ref.info.height !== test.info.height)
    throw new Error("Candidate dimensions changed");
  // Alpha must be preserved exactly; scores alone cannot protect transparent pixels.
  for (let i = 3; i < ref.data.length; i += 4) if (ref.data[i] !== test.data[i]) return -Infinity;
  const scores: number[] = [];
  for (const background of ["#ffffff", "#111111"]) {
    const a = join(directory, "reference.png");
    const b = join(directory, "decoded.png");
    await writeFile(a, await decode(reference).flatten({ background }).png().toBuffer());
    await writeFile(b, await decode(bytes).flatten({ background }).png().toBuffer());
    scores.push(await metric(a, b));
  }
  return Math.min(...scores);
}
async function reusableAssessment(reference: Buffer, directory: string) {
  const ref = await decode(reference).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const paths: string[] = [];
  for (const [index, background] of ["#ffffff", "#111111"].entries()) {
    const path = join(directory, `reference-${index}.png`);
    await writeFile(path, await decode(reference).flatten({ background }).png().toBuffer());
    paths.push(path);
  }
  return async (bytes: Buffer) => {
    const candidate = await decode(bytes)
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (candidate.info.width !== ref.info.width || candidate.info.height !== ref.info.height)
      throw new Error("Candidate dimensions changed");
    for (let i = 3; i < ref.data.length; i += 4)
      if (ref.data[i] !== candidate.data[i]) return -Infinity;
    const scores: number[] = [];
    for (const [index, background] of ["#ffffff", "#111111"].entries()) {
      const path = join(directory, "decoded.png");
      await writeFile(
        path,
        await sharp(candidate.data, { raw: candidate.info })
          .flatten({ background })
          .png()
          .toBuffer(),
      );
      const referencePath = paths[index];
      if (!referencePath) throw new Error("Missing reference background");
      scores.push(await metric(referencePath, path));
    }
    return Math.min(...scores);
  };
}
export async function compressImage(
  source: string,
  profile: ImageProfile,
  directory: string,
  mode: "baseline" | "tuned" = "baseline",
) {
  const start = performance.now();
  let encodingMs = 0;
  let assessmentMs = 0;
  const { metadata: m, reference } = await makeReference(source, profile);
  const dimensions = await decode(reference).metadata();
  if (!dimensions.width || !dimensions.height) throw new Error("Reference dimensions missing");
  const normalizeMs = performance.now() - start;
  const assessBytes =
    mode === "tuned"
      ? await reusableAssessment(reference, directory)
      : (bytes: Buffer) => assess(reference, bytes, directory);
  const evaluated: { mime: string; score: number; quality?: number; byteLength: number }[] = [];
  const candidates: Candidate[] = [];
  let best: Candidate | undefined;
  const evaluate = async (bytes: Buffer, mime: string, quality?: number) => {
    const began = performance.now();
    const score = await assessBytes(bytes);
    assessmentMs += performance.now() - began;
    const candidate = { bytes, mime, score, quality };
    evaluated.push({ mime, score, quality, byteLength: bytes.length });
    if (mode === "baseline") candidates.push(candidate);
    if (
      score >= c.threshold &&
      bytes.length <= c.maxOutput &&
      (!best || bytes.length < best.bytes.length)
    )
      best = candidate;
    return score;
  };
  // Even lossless routes require a functioning metric, never silently bypass validation.
  await evaluate(reference, "image/png");
  if (profile !== "preserve") {
    for (const codec of ["avif", "webp"] as const) {
      let low = codec === "avif" ? c.avifMin : c.webpMin;
      let high = codec === "avif" ? c.avifMax : c.webpMax;
      for (let trial = 0; trial < 3 && low <= high; trial++) {
        const quality = Math.round((low + high) / 2);
        const began = performance.now();
        const bytes = await decode(reference)[codec]({ quality, effort: c.effort }).toBuffer();
        encodingMs += performance.now() - began;
        const score = await evaluate(bytes, `image/${codec}`, quality);
        if (score >= c.threshold) high = quality - 1;
        else low = quality + 1;
      }
    }
  }
  // Only metadata-free, already normalized and correctly sized originals qualify.
  if (
    ["png", "webp", "heif", "jpeg"].includes(m.format ?? "") &&
    !m.exif &&
    !m.icc &&
    !m.xmp &&
    !m.iptc &&
    !m.orientation &&
    m.space === "srgb" &&
    m.width === dimensions.width &&
    m.height === dimensions.height &&
    (profile !== "preserve" || m.format === "png")
  ) {
    const bytes = await readFile(source);
    await evaluate(bytes, m.format === "heif" ? "image/avif" : `image/${m.format}`);
  }
  const chosen = mode === "baseline" ? smallestPassing(candidates) : best;
  if (!chosen)
    throw new Error(
      "No image meets quality and storage limits; use a smaller source or preservation profile",
    );
  return {
    ...chosen,
    width: dimensions.width,
    height: dimensions.height,
    evaluated,
    timingsMs: {
      normalize: normalizeMs,
      encode: encodingMs,
      assessment: assessmentMs,
      total: performance.now() - start,
    },
  };
}
