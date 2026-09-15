// Database-free benchmark. Run after npm run build with SSIMULACRA2_BIN configured.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  assess,
  compressImage,
  decode,
  getMetricPeakBytes,
  makeReference,
} from "../dist/images/compress.js";

const directory = await mkdtemp(join(tmpdir(), "farm-benchmark-"));
const results = [];
try {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error("Pass authorized local image paths");
  for (const [index, file] of files.entries()) {
    const work = join(directory, String(index));
    await mkdir(work);
    const source = join(work, "source");
    await writeFile(source, await readFile(file));
    const { reference } = await makeReference(source, "photo");
    const baselineStart = performance.now();
    const baseline = await decode(reference).webp({ quality: 80, effort: 6 }).toBuffer();
    const baselineEncodingMs = performance.now() - baselineStart;
    const baselineScore = await assess(reference, baseline, work);
    const start = performance.now();
    const chosen = await compressImage(source, "photo", work);
    results.push({
      file: basename(file),
      width: chosen.width,
      height: chosen.height,
      originalBytes: (await readFile(file)).length,
      webp80Bytes: baseline.length,
      webp80Score: baselineScore,
      webp80EncodingMs: baselineEncodingMs,
      adaptiveBytes: chosen.bytes.length,
      adaptiveScore: chosen.score,
      adaptiveMime: chosen.mime,
      adaptiveTotalMs: performance.now() - start,
      metricPeakBytes: getMetricPeakBytes(),
      nodePeakRssKiB: process.resourceUsage().maxRSS,
      candidates: chosen.evaluated,
    });
  }
  console.log(
    JSON.stringify(
      {
        machine: {
          platform: platform(),
          arch: arch(),
          cpu: cpus()[0]?.model,
          node: process.version,
        },
        note: "Node peak RSS is cumulative and excludes the external metric process. Docker metric is separately limited to 768 MiB; timings include Docker invocation overhead. UI screenshots are not representative product photography.",
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
