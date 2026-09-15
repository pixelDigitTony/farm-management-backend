// Manual browser fixture: always starts a new disposable database, never reads a saved DB URI.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mongoose from "mongoose";
import { app } from "../../src/app.js";
import { imageConfig } from "../../src/images/config.js";
import { startTestDatabase } from "../integration/database.js";
import { seedBrowserFixtures } from "./seed.js";

if (
  process.env.NODE_ENV !== "test" ||
  process.env.EMAIL_PROVIDER !== "console" ||
  !process.env.SSIMULACRA2_BIN
)
  throw new Error("Require test mode, console email and pinned SSIMULACRA2_BIN");
const directory = await mkdtemp(join(tmpdir(), "farm-image-browser-"));
imageConfig.staging = directory;
const stopDatabase = await startTestDatabase();
await seedBrowserFixtures();
if (!mongoose.connection.name.startsWith("farm_test_"))
  throw new Error("Refusing existing database");
const host = mongoose.connection.getClient().options.hosts[0];
if (!host) throw new Error("Missing Testcontainer address");
const worker = spawn(process.execPath, ["dist/images/worker.js"], {
  env: {
    ...process.env,
    IMAGE_STAGING_DIR: directory,
    MONGODB_URI: `mongodb://${host.toString()}/${mongoose.connection.name}?directConnection=true&replicaSet=rs0`,
  },
  stdio: "inherit",
});
const server = app.listen(4139, "127.0.0.1", () =>
  console.log("Disposable image browser API on 4139"),
);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeAllConnections();
    const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    worker.kill("SIGTERM");
    if (worker.exitCode === null) await exited;
    await stopDatabase();
    await rm(directory, { recursive: true, force: true });
    process.exit(0);
  });
