import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compressImage } from "./compress.js";
import type { ImageProfile } from "./config.js";

const [source, profile, directory] = process.argv.slice(2);
try {
  if (!source || !directory || !profile) throw new Error("Missing encoding arguments");
  const result = await compressImage(source, profile as ImageProfile, directory);
  await writeFile(join(directory, "output"), result.bytes, { mode: 0o600 });
  const { bytes: _, ...metadata } = result;
  process.send?.({ ok: true, ...metadata });
} catch (error) {
  // Only explicit processing messages cross the process boundary; native error details stay local.
  console.error("Image encoding failed", error);
  process.send?.({ ok: false });
  process.exitCode = 1;
}
