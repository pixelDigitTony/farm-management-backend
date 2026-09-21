import { app } from "./app.js";
import { connectDatabase, disconnectDatabase } from "./config/database.js";
import { env, resendEmailFallbackActive } from "./config/env.js";
import { startImageProcessing, stopImageProcessing } from "./images/service.js";

async function start() {
  if (resendEmailFallbackActive) {
    console.warn(
      "Resend email credentials are incomplete. Using the console email sender until Resend is configured.",
    );
  }
  await connectDatabase();
  await startImageProcessing();
  const server = app.listen(env.PORT, () =>
    console.log(`Miss V Business API running on http://localhost:${env.PORT}`),
  );
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 35_000);
    deadline.unref();
    const processing = stopImageProcessing();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([processing, closed]);
    await disconnectDatabase();
    clearTimeout(deadline);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((error) => {
  console.error("Failed to start API", error);
  process.exit(1);
});
