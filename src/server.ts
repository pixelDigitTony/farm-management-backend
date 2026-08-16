import { app } from "./app.js";
import { connectDatabase, disconnectDatabase } from "./config/database.js";
import { env, resendEmailFallbackActive } from "./config/env.js";

async function start() {
  if (resendEmailFallbackActive) {
    console.warn(
      "Resend email credentials are incomplete. Using the console email sender until Resend is configured.",
    );
  }
  await connectDatabase();
  const server = app.listen(env.PORT, () =>
    console.log(`Miss V Business API running on http://localhost:${env.PORT}`),
  );
  const shutdown = () =>
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((error) => {
  console.error("Failed to start API", error);
  process.exit(1);
});
