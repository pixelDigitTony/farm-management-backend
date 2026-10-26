import { EmailOutbox, EmailWebhookEvent, OrderMessage } from "../models/index.js";
import { processEmailOutbox } from "./email-outbox.service.js";
import { repairEmployeeVerification } from "./email-verification.service.js";
import { processEmailWebhooks, reconcileSentMetadata } from "./email-webhook.service.js";
import { retainDailyAnalytics } from "./landing-analytics.service.js";
import { repairOrderEmail } from "./order-messaging.service.js";

export function startEmailWorker() {
  let running: Promise<void> | undefined;
  let lastMaintenance = 0;
  let lastHealth = 0;
  const tick = () => {
    if (running) return;
    running = (async () => {
      await repairEmployeeVerification();
      await repairOrderEmail();
      await processEmailOutbox();
      await processEmailWebhooks();
      await reconcileSentMetadata();
      if (Date.now() - lastHealth > 60000) {
        const oldest = await EmailOutbox.findOne({ state: { $in: ["QUEUED", "SENDING"] } })
          .sort({ createdAt: 1 })
          .select("createdAt")
          .lean();
        const window = { createdAt: { $gte: new Date(Date.now() - 600000) } };
        const attempts = await EmailOutbox.countDocuments(window);
        const failures = await EmailOutbox.countDocuments({
          ...window,
          state: { $in: ["FAILED", "BOUNCED"] },
        });
        const oldestAgeSeconds = oldest
          ? Math.floor((Date.now() - new Date(oldest.createdAt).getTime()) / 1000)
          : 0;
        const degraded = oldestAgeSeconds > 300 || (attempts >= 20 && failures / attempts > 0.05);
        (degraded ? console.warn : console.info)(
          JSON.stringify({
            event: "email_worker_health",
            oldestAgeSeconds,
            attempts,
            failures,
            degraded,
          }),
        );
        lastHealth = Date.now();
      }
      if (Date.now() - lastMaintenance > 3600000) {
        await retainDailyAnalytics();
        const thirtyDays = new Date(Date.now() - 30 * 86400000);
        await EmailOutbox.updateMany({ updatedAt: { $lt: thirtyDays } }, { $set: { payload: "" } });
        await EmailOutbox.deleteMany({
          updatedAt: { $lt: new Date(Date.now() - 90 * 86400000) },
          state: { $nin: ["QUEUED", "SENDING"] },
        });
        await EmailWebhookEvent.deleteMany({ expiresAt: { $lt: new Date() } });
        await OrderMessage.deleteMany({ expiresAt: { $lt: new Date() } });
        lastMaintenance = Date.now();
      }
    })()
      .catch(() => console.error(JSON.stringify({ event: "email_worker_error" })))
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  tick();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
