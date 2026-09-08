import express from "express";
import { app } from "../../src/app.js";
import { startTestDatabase } from "../integration/database.js";
import { seedBrowserFixtures } from "./seed.js";

if (process.env.NODE_ENV !== "test" || process.env.EMAIL_PROVIDER !== "console")
  throw new Error("The fixture server requires test mode and console email");
const stopDatabase = await startTestDatabase();
try {
  await seedBrowserFixtures();
  // Registered only after a new Testcontainer has connected and fixtures have been seeded.
  const fixtureApp = express();
  fixtureApp.get("/api/__test/fixture", (_request, response) =>
    response.json({ kind: "farm-disposable-fixture-v1" }),
  );
  fixtureApp.use(app);
  const server = fixtureApp.listen(4107, "127.0.0.1", () =>
    console.log("Disposable test API ready on 127.0.0.1:4107"),
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(async () => {
      await stopDatabase();
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} catch (error) {
  await stopDatabase();
  throw error;
}
