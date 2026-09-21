// Manual browser fixture: always starts a new disposable database, never reads a saved DB URI.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mongoose from "mongoose";
import { app } from "../../src/app.js";
import { imageConfig } from "../../src/images/config.js";
import { startImageProcessing, stopImageProcessing } from "../../src/images/service.js";
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
await startImageProcessing();
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
    await stopImageProcessing();
    await stopDatabase();
    await rm(directory, { recursive: true, force: true });
    process.exit(0);
  });
