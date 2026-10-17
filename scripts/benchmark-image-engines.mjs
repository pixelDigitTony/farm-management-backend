// Offline only: no dotenv, database access, upload or application-record mutations.
// Usage: node scripts/benchmark-image-engines.mjs manifest.json [report.json]
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { assess, compressImage, makeReference } from "../dist/images/compress.js";
import { imageConfig, pipelineVersion, processorConfig } from "../dist/images/config.js";
import {
  encodeRust,
  prepareRustProcessor,
  readProcessorOutput,
  rustBuild,
} from "../dist/images/rust.js";

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("Pass an authorized fixture manifest JSON path");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!Array.isArray(manifest.fixtures) || !manifest.fixtures.length)
  throw new Error("Manifest requires fixtures: [{path,sha256,category}]");
const engines = manifest.engines ?? ["baseline", "tuned", "rust"];
if (!engines.every((engine) => ["baseline", "tuned", "rust"].includes(engine)))
  throw new Error("Invalid engine");
const passes = manifest.passes ?? 5;
if (!Number.isInteger(passes) || passes < 1 || passes > 100) throw new Error("Invalid pass count");
const profiles = manifest.profiles ?? ["avatar", "photo", "display", "preserve"];
if (!profiles.every((profile) => Object.hasOwn(imageConfig.dimensions, profile)))
  throw new Error("Invalid profile");
const root = await mkdtemp(join(tmpdir(), "farm-engine-benchmark-"));
imageConfig.staging = root;
const results = [];
try {
  if (engines.includes("rust")) {
    processorConfig.engine = "rust";
    await prepareRustProcessor();
  }
  for (const fixture of manifest.fixtures) {
    const path = resolve(fixture.path);
    const bytes = await readFile(path);
    if (
      typeof fixture.sha256 !== "string" ||
      createHash("sha256").update(bytes).digest("hex") !== fixture.sha256
    )
      throw new Error(`Fixture hash mismatch: ${path}`);
    for (const profile of profiles) {
      // Same Sharp-normalized oracle for every engine, rather than scoring Rust against itself.
      const oracle = (await makeReference(path, profile)).reference;
      // Include one warm-up per engine; rotate ordering deterministically across measured passes.
      for (let pass = -1; pass < passes; pass++) {
        const ordered = engines.map(
          (_, i) => engines[(i + pass + engines.length) % engines.length],
        );
        for (const engine of ordered) {
          const work = join(root, `${results.length}-${profile}-${engine}-${pass}`);
          await mkdir(work, { mode: 0o700 });
          const source = join(root, "fixture.source");
          await writeFile(source, bytes, { mode: 0o600 });
          const start = performance.now();
          const cpu = process.cpuUsage();
          try {
            let output;
            let diagnostics;
            if (engine === "rust") {
              processorConfig.engine = "rust";
              diagnostics = await encodeRust(source, profile, work, new AbortController().signal);
              output = await readProcessorOutput(work, diagnostics);
            } else {
              processorConfig.engine = "sharp";
              diagnostics = await compressImage(
                source,
                profile,
                work,
                engine === "tuned" ? "tuned" : "baseline",
              );
              output = diagnostics;
            }
            const totalMs = performance.now() - start;
            const score = await assess(oracle, output.bytes, work);
            const alpha = await sharp(output.bytes).ensureAlpha().raw().toBuffer();
            const referenceAlpha = await sharp(oracle).ensureAlpha().raw().toBuffer();
            const alphaMatches =
              alpha.length === referenceAlpha.length &&
              alpha.every((value, index) => index % 4 !== 3 || value === referenceAlpha[index]);
            results.push({
              fixture: fixture.category ?? fixture.path,
              sourceHash: fixture.sha256,
              engine,
              profile,
              pass,
              totalMs,
              timingsMs: diagnostics.timingsMs,
              byteLength: output.bytes.length,
              mime: output.mime,
              score,
              alphaMatches,
              qualityPassed: score >= imageConfig.threshold && alphaMatches,
              nodeCpuMicroseconds: process.cpuUsage(cpu),
              nodePeakRssKiB: process.resourceUsage().maxRSS,
            });
          } catch (error) {
            results.push({
              fixture: fixture.path,
              sourceHash: fixture.sha256,
              engine,
              profile,
              pass,
              error: String(error),
            });
          } finally {
            await rm(work, { recursive: true, force: true });
          }
        }
      }
    }
  }
  const measured = results.filter((row) => row.pass >= 0);
  const percentile = (items, p) => items[Math.max(0, Math.ceil(items.length * p) - 1)];
  const summary = engines.map((engine) => {
    const samples = measured
      .filter((row) => row.engine === engine && !row.error)
      .map((row) => row.totalMs)
      .sort((a, b) => a - b);
    return {
      engine,
      samples: samples.length,
      failures: measured.filter((row) => row.engine === engine && (row.error || !row.qualityPassed))
        .length,
      p50: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      p99: percentile(samples, 0.99),
    };
  });
  const byEngine = Object.fromEntries(summary.map((row) => [row.engine, row]));
  const sizeRatios = measured
    .filter((row) => row.engine === "rust" && !row.error)
    .map((row) => {
      const baseline = measured.find(
        (other) =>
          other.engine === "baseline" &&
          other.sourceHash === row.sourceHash &&
          other.profile === row.profile &&
          other.pass === row.pass,
      );
      return baseline && !baseline.error ? row.byteLength / baseline.byteLength : undefined;
    })
    .filter((ratio) => ratio !== undefined);
  const gates = {
    qualityPassed: measured.every((row) => !row.error && row.qualityPassed),
    latencyPassed:
      byEngine.rust && byEngine.baseline && byEngine.tuned
        ? byEngine.rust.failures === 0 &&
          byEngine.baseline.failures === 0 &&
          byEngine.tuned.failures === 0 &&
          byEngine.rust.samples === byEngine.baseline.samples &&
          byEngine.rust.samples === byEngine.tuned.samples &&
          byEngine.rust.p95 <= byEngine.baseline.p95 * 0.7 &&
          byEngine.rust.p95 <= byEngine.tuned.p95 * 0.8
        : null,
    sizePassed: sizeRatios.length
      ? sizeRatios.every((ratio) => ratio <= 1.1) &&
        sizeRatios.reduce((a, b) => a + b, 0) / sizeRatios.length <= 1.03
      : null,
    minimumCorpus: manifest.fixtures.length >= 100 && passes >= 5 && profiles.length === 4,
    adoptionReady: false,
    pending: [
      "target-hardware profile/category latency and confidence analysis",
      "representative photo and boundary-case corpus",
      "combined cgroup resources/API load",
      "disposable DB recovery and browser verification",
    ],
  };
  const report = {
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      node: process.version,
    },
    sharpVersions: sharp.versions,
    rustBuild: rustBuild(),
    pipelineVersion,
    manifest: resolve(manifestPath),
    summary,
    gates,
    results,
    limitations: [
      "Offline processing only; excludes network, queue, database and UI latency",
      "Node RSS/CPU exclude native child/metric processes; not a release resource gate",
      "Sharp modes execute in the harness; Rust includes child startup and independent output validation",
      "Target cgroup memory, load/recovery and representative photography gates require separate verification",
    ],
  };
  const json = JSON.stringify(report, null, 2);
  if (process.argv[3]) await writeFile(process.argv[3], `${json}\n`);
  console.log(JSON.stringify({ summary, gates, report: process.argv[3] ?? null }));
} finally {
  await rm(root, { recursive: true, force: true });
}
