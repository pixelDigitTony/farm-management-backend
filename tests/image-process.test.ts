import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, expect, it } from "vitest";
import { runImageBinary } from "../src/images/child.js";
import { imageConfig, pipelineVersion, processorConfig } from "../src/images/config.js";
import { assertAttemptPaths, readProcessorOutput } from "../src/images/rust.js";

const directories: string[] = [];
const original = { staging: imageConfig.staging, engine: processorConfig.engine };
afterEach(async () => {
  imageConfig.staging = original.staging;
  processorConfig.engine = original.engine;
  delete process.env.FARM_TEST_SECRET;
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "image-process-"));
  directories.push(path);
  return path;
}
const run = (script: string, signal = new AbortController().signal, timeout = 3000) =>
  runImageBinary(process.execPath, ["-e", script], { policy: "test" }, signal, timeout);

it("passes JSON without application credentials and waits for successful exit", async () => {
  process.env.FARM_TEST_SECRET = "must-not-cross-boundary";
  await expect(
    run(
      "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.stringify({request:JSON.parse(s),secretPresent:!!process.env.FARM_TEST_SECRET})))",
    ),
  ).resolves.toEqual({ request: { policy: "test" }, secretPresent: false });
  await expect(run("console.log(JSON.stringify({ok:true}));process.exit(1)")).rejects.toThrow();
});
it("rejects malformed, multiple and oversized responses", async () => {
  await expect(run("console.log('not-json')")).rejects.toThrow("Invalid");
  await expect(run("console.log('{}');console.log('{}')")).rejects.toThrow("Invalid");
  await expect(
    run("process.stdout.write('x'.repeat(70000));setInterval(()=>{},1000)"),
  ).rejects.toThrow();
});
it("terminates a hung process on deadline or cancellation", async () => {
  await expect(run("setInterval(()=>{},1000)", undefined, 100)).rejects.toThrow();
  const control = new AbortController();
  const result = run("setInterval(()=>{},1000)", control.signal);
  setTimeout(() => control.abort(), 100);
  await expect(result).rejects.toThrow();
});
it("rejects output with mismatched dimensions, fingerprint, hash or actual format", async () => {
  processorConfig.engine = "rust";
  const work = await directory();
  const bytes = await sharp({ create: { width: 8, height: 4, channels: 4, background: "#ab6788" } })
    .png()
    .toBuffer();
  await writeFile(join(work, "output"), bytes);
  const result = {
    ok: true,
    protocolVersion: 1,
    pipelineVersion,
    mime: "image/png",
    width: 8,
    height: 4,
    score: 100,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    timingsMs: { total: 1 },
  };
  await expect(readProcessorOutput(work, result)).resolves.toMatchObject({ bytes, width: 8 });
  for (const patch of [
    { width: 7 },
    { mime: "image/webp" },
    { pipelineVersion: "other" },
    { sha256: "bad" },
    { byteLength: 1 },
    { timingsMs: { total: -1 } },
    { score: 79 },
  ])
    await expect(readProcessorOutput(work, { ...result, ...patch })).rejects.toThrow();
});
it("confines source and attempt paths to the staging tree", async () => {
  const root = await directory();
  const outside = await directory();
  imageConfig.staging = root;
  const source = join(root, "source");
  const work = join(root, "attempt");
  await writeFile(source, "file");
  await mkdir(work);
  await expect(assertAttemptPaths(source, work)).resolves.toBeUndefined();
  await expect(assertAttemptPaths(source, outside)).rejects.toThrow("escapes");
  if (process.platform !== "win32") {
    const link = join(root, "linked");
    await symlink(outside, link);
    await expect(assertAttemptPaths(source, link)).rejects.toThrow();
  }
});
