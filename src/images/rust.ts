import { createHash } from "node:crypto";
import { constants, lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import sharp from "sharp";
import { runImageBinary } from "./child.js";
import {
  imageConfig as c,
  type ImageProfile,
  pipelineVersion,
  processorConfig,
  setRustPipeline,
} from "./config.js";

let build: Record<string, unknown> | undefined;
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export const rustBuild = () => build;
export async function prepareRustProcessor() {
  if (!isAbsolute(processorConfig.binary)) throw new Error("IMAGE_RUST_BIN must be absolute");
  const result = await runImageBinary(
    processorConfig.binary,
    ["--self-test"],
    undefined,
    new AbortController().signal,
    30000,
  );
  if (
    !object(result) ||
    result.ok !== true ||
    result.protocolVersion !== 1 ||
    typeof result.buildVersion !== "string" ||
    typeof result.nativeVersions !== "string"
  )
    throw new Error("Rust image processor self-test failed");
  const sha256 = createHash("sha256")
    .update(await readFile(processorConfig.binary))
    .digest("hex");
  const metricSha256 = createHash("sha256")
    .update(await readFile(c.metric))
    .digest("hex");
  build = {
    buildVersion: result.buildVersion,
    nativeVersions: result.nativeVersions,
    sha256,
    metricSha256,
  };
  setRustPipeline(build);
}

export async function assertAttemptPaths(source: string, directory: string) {
  const root = await realpath(c.staging);
  for (const path of [source, directory]) {
    const info = await lstat(path);
    const resolved = await realpath(path);
    const inside = relative(root, resolved);
    if (
      !inside ||
      inside === ".." ||
      inside.startsWith(`..${sep}`) ||
      isAbsolute(inside) ||
      info.isSymbolicLink()
    )
      throw new Error("Image attempt path escapes staging");
    if (path === source ? !info.isFile() : !info.isDirectory())
      throw new Error("Invalid image attempt path");
  }
}

export async function encodeRust(
  source: string,
  profile: ImageProfile,
  directory: string,
  signal: AbortSignal,
) {
  await assertAttemptPaths(source, directory);
  return runImageBinary(
    processorConfig.binary,
    [],
    {
      protocolVersion: 1,
      jobId: basename(source, ".source"),
      attemptId: basename(directory),
      pipelineVersion,
      sourcePath: source,
      workDir: directory,
      profile,
      policy: {
        maxBytes: c.maxBytes,
        maxPixels: c.maxPixels,
        maxFrames: c.maxFrames,
        maxOutput: c.maxOutput,
        threshold: c.threshold,
        avifMin: c.avifMin,
        avifMax: c.avifMax,
        webpMin: c.webpMin,
        webpMax: c.webpMax,
        effort: c.effort,
        edge: c.dimensions[profile],
        timeoutMs: c.timeoutMs,
        metricPath: c.metric,
      },
    },
    signal,
    c.timeoutMs,
  );
}

// Verify the output independently, including size before allocating or decoding it.
export async function readProcessorOutput(directory: string, metadata: unknown) {
  if (
    !object(metadata) ||
    metadata.ok !== true ||
    typeof metadata.mime !== "string" ||
    !["image/jpeg", "image/png", "image/webp", "image/avif"].includes(metadata.mime) ||
    !Number.isSafeInteger(metadata.width) ||
    !Number.isSafeInteger(metadata.height) ||
    Number(metadata.width) < 1 ||
    Number(metadata.height) < 1 ||
    Number(metadata.width) * Number(metadata.height) > c.maxPixels ||
    typeof metadata.score !== "number" ||
    !Number.isFinite(metadata.score) ||
    metadata.score < c.threshold
  )
    throw new Error("Invalid image processor metadata");
  if (
    processorConfig.engine === "rust" &&
    (metadata.protocolVersion !== 1 ||
      metadata.pipelineVersion !== pipelineVersion ||
      !object(metadata.timingsMs) ||
      Object.values(metadata.timingsMs).some(
        (x) => typeof x !== "number" || !Number.isFinite(x) || x < 0,
      ))
  )
    throw new Error("Image processor protocol or policy mismatch");
  const path = join(directory, "output");
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > c.maxOutput ||
    dirname(await realpath(path)) !== (await realpath(directory))
  )
    throw new Error("Invalid image output file");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const current = await file.stat();
    if (!current.isFile() || current.size !== stat.size) throw new Error("Image output changed");
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("Incomplete image output");
      offset += bytesRead;
    }
  } finally {
    await file.close();
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (
    processorConfig.engine === "rust" &&
    (metadata.byteLength !== bytes.length || metadata.sha256 !== hash)
  )
    throw new Error("Image output integrity mismatch");
  const inspected = await sharp(bytes, {
    limitInputPixels: c.maxPixels,
    animated: true,
    failOn: "warning",
  }).metadata();
  const mime =
    inspected.format === "heif" && inspected.compression === "av1"
      ? "image/avif"
      : `image/${inspected.format}`;
  if (
    mime !== metadata.mime ||
    inspected.width !== metadata.width ||
    inspected.height !== metadata.height ||
    (inspected.pages ?? 1) !== 1
  )
    throw new Error("Image output does not match metadata");
  return { bytes, mime, width: Number(metadata.width), height: Number(metadata.height) };
}
