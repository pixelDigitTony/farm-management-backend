import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  prepare: vi.fn(),
  indexes: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  claim: vi.fn(),
  cleanup: vi.fn(),
  assert: vi.fn(),
  encode: vi.fn(),
  fail: vi.fn(),
  finish: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  access: mocks.access,
  constants: { X_OK: 1 },
  mkdir: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
}));
vi.mock("../src/images/config.js", () => ({
  assertImageConfig: mocks.assert,
  imageConfig: { metric: "/metric", staging: "/staging", leaseMs: 60000, attempts: 3 },
  pipelineVersion: "test",
}));
vi.mock("../src/models/image.models.js", () => ({
  ImageJob: { createIndexes: mocks.indexes },
  ImageLock: { createIndexes: mocks.indexes },
  StoredImage: { createIndexes: mocks.indexes },
}));
vi.mock("../src/images/process.js", () => ({ encodeInProcess: mocks.encode }));
vi.mock("../src/images/queue.js", () => ({
  acquireLock: mocks.acquire,
  releaseLock: mocks.release,
  claimJob: mocks.claim,
  cleanup: mocks.cleanup,
  prepareStaging: mocks.prepare,
  failJob: mocks.fail,
  finishJob: mocks.finish,
  ownedJob: vi.fn(),
  sourcePath: vi.fn(),
  storeOutput: vi.fn(),
}));

import {
  imageProcessingStatus,
  startImageProcessing,
  stopImageProcessing,
} from "../src/images/service.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.assert.mockImplementation(() => {});
  mocks.access.mockResolvedValue(undefined);
  mocks.acquire.mockResolvedValue(true);
  mocks.claim.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  const stopped = stopImageProcessing();
  await vi.advanceTimersByTimeAsync(1100);
  await stopped;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("starts once on the existing connection and releases the lease on shutdown", async () => {
  await startImageProcessing();
  await vi.advanceTimersByTimeAsync(0);
  await startImageProcessing();
  expect(mocks.indexes).toHaveBeenCalledTimes(3);
  expect(mocks.claim).toHaveBeenCalledTimes(1);
  expect(imageProcessingStatus().ready).toBe(true);
  const stopped = stopImageProcessing();
  expect(imageProcessingStatus().ready).toBe(false);
  await vi.advanceTimersByTimeAsync(1100);
  await stopped;
  expect(mocks.release).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("disables uploads when native dependencies are missing without throwing into API startup", async () => {
  mocks.access.mockRejectedValueOnce(new Error("Missing executable"));
  await expect(startImageProcessing()).resolves.toBeUndefined();
  expect(imageProcessingStatus()).toMatchObject({ ready: false, lastError: expect.any(String) });
  expect(mocks.claim).not.toHaveBeenCalled();
});

it("waits when another instance owns the singleton lease", async () => {
  mocks.acquire.mockResolvedValue(null);
  await startImageProcessing();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.claim).not.toHaveBeenCalled();
  expect(imageProcessingStatus().ready).toBe(true);
});

it("reports a stopped loop and can restart after a database failure", async () => {
  mocks.acquire.mockRejectedValueOnce(new Error("Database disconnected"));
  await startImageProcessing();
  await vi.advanceTimersByTimeAsync(0);
  expect(imageProcessingStatus().ready).toBe(false);
  await startImageProcessing();
  expect(imageProcessingStatus().ready).toBe(true);
});

it("aborts an active encode before releasing its lease and never publishes its output", async () => {
  const job = { _id: "test-job", attempts: 1, pipelineVersion: "test", profile: "photo" };
  mocks.claim.mockResolvedValueOnce(job);
  let signal: AbortSignal | undefined;
  mocks.encode.mockImplementation((_source, _profile, _directory, abort: AbortSignal) => {
    signal = abort;
    return new Promise((_resolve, reject) => {
      abort.addEventListener("abort", () => reject(new Error("Stopped")), { once: true });
    });
  });
  await startImageProcessing();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.encode).toHaveBeenCalledOnce();
  await stopImageProcessing();
  expect(signal?.aborted).toBe(true);
  expect(mocks.fail).toHaveBeenCalledWith(job, expect.any(String), expect.any(String));
  expect(mocks.release).toHaveBeenCalledOnce();
  expect(mocks.finish).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
