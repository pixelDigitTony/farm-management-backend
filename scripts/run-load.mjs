import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const baseURL = "http://127.0.0.1:4107/api";
// Refuse to reuse any listener, even another fixture server.
try {
  await fetch(`${baseURL}/health`, { signal: AbortSignal.timeout(1000) });
  throw new Error("Port 4107 is occupied; stop that server before running isolated load tests");
} catch (error) {
  if (!(error instanceof TypeError) || error.cause?.code !== "ECONNREFUSED") throw error;
}
const server = spawn(
  process.execPath,
  ["node_modules/tsx/dist/cli.mjs", "tests/support/server.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "test",
      EMAIL_PROVIDER: "console",
      JWT_SECRET: "isolated-load-secret-not-for-production",
    },
  },
);
let startupError;
server.on("error", (error) => {
  startupError = error;
});
let workload;
let stopping = false;
function stop() {
  stopping = true;
  workload?.kill("SIGTERM");
  server.kill("SIGTERM");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  let ready = false;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (stopping) throw new Error("Load test interrupted");
    if (startupError) throw startupError;
    if (server.exitCode !== null)
      throw new Error("Disposable fixture server exited during startup");
    try {
      const response = await fetch(`${baseURL}/__test/fixture`, {
        signal: AbortSignal.timeout(1000),
      });
      ready = response.ok && (await response.json()).kind === "farm-disposable-fixture-v1";
    } catch {
      /* Server is not ready yet. */
    }
    if (ready) break;
    await delay(500);
  }
  if (!ready) throw new Error("Disposable fixture server did not become ready");
  await mkdir("artifacts", { recursive: true });
  const code = await new Promise((resolve, reject) => {
    workload = spawn(
      "k6",
      ["run", "--summary-export=artifacts/load-summary.json", "tests/performance/api.k6.js"],
      {
        stdio: "inherit",
        env: { ...process.env, BASE_URL: baseURL },
      },
    );
    workload.once("error", reject);
    workload.once("close", resolve);
  });
  process.exitCode = code ?? 1;
} finally {
  stop();
}
