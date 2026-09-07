import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  [
    "node_modules/dependency-cruiser/bin/dependency-cruise.mjs",
    "src",
    "--config",
    ".dependency-cruiser.cjs",
    "--output-type",
    "json",
  ],
  { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
);
if (result.error) throw result.error;
if (!result.stdout) {
  console.error(result.stderr);
  process.exit(1);
}
const report = JSON.parse(result.stdout);
if (!report.modules?.length)
  throw new Error("Architecture scan found no modules; check parser compatibility");
const errors = report.summary?.violations?.filter((v) => v.rule.severity === "error") ?? [];
console.log(`Architecture: ${report.modules.length} modules scanned; ${errors.length} errors`);
for (const error of errors) console.error(JSON.stringify(error));
if (result.status || errors.length) process.exit(1);
