import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
it("retains the legacy Sharp fingerprint when operational engine controls change", async () => {
  vi.stubEnv("IMAGE_PROCESSOR", "sharp");
  vi.stubEnv("IMAGE_UPLOADS_ENABLED", "false");
  vi.resetModules();
  const { imageConfig, pipelineVersion, processorConfig } = await import("../src/images/config.js");
  const hash = createHash("sha256")
    .update(JSON.stringify({ ...imageConfig, staging: "", metric: "" }))
    .digest("hex")
    .slice(0, 16);
  expect(pipelineVersion).toBe(`adaptive-v1-sharp-0.35.4-libjxl-0.11.1-${hash}`);
  expect(processorConfig.uploadsEnabled).toBe(false);
});
it("fingerprints Rust build and output policy without executable paths or admission", async () => {
  vi.stubEnv("IMAGE_PROCESSOR", "rust");
  vi.resetModules();
  const config = await import("../src/images/config.js");
  config.setRustPipeline({ sha256: "one", nativeVersions: "vips-test" });
  const first = config.pipelineVersion;
  config.processorConfig.binary = "/another/path";
  config.processorConfig.uploadsEnabled = false;
  config.setRustPipeline({ sha256: "one", nativeVersions: "vips-test" });
  expect(config.pipelineVersion).toBe(first);
  config.setRustPipeline({ sha256: "two", nativeVersions: "vips-test" });
  expect(config.pipelineVersion).not.toBe(first);
});
it.each([
  ["IMAGE_PROCESSOR", "typo"],
  ["IMAGE_UPLOADS_ENABLED", "yes"],
])("rejects invalid %s configuration", async (name, value) => {
  vi.stubEnv(name, value);
  vi.resetModules();
  await expect(import("../src/images/config.js")).rejects.toThrow("Invalid");
});
