import { env } from "../config/env.js";
import { EmailWebhookEvent, EmailWorkerHealth } from "../models/index.js";
import { emailService } from "./email.service.js";

let inspection:
  | { expiresAt: number; promise: Promise<boolean | null>; endpoint?: string }
  | undefined;
function inspectProvider() {
  if (
    !inspection ||
    inspection.expiresAt < Date.now() ||
    inspection.endpoint !== env.EMAIL_WEBHOOK_URL
  ) {
    inspection = {
      expiresAt: Date.now() + 60000,
      endpoint: env.EMAIL_WEBHOOK_URL,
      promise: emailService.receivingWebhookConfigured(env.EMAIL_WEBHOOK_URL).catch(() => null),
    };
  }
  return inspection.promise;
}
export async function emailHealth(businessId: unknown, administrator: boolean, orderId?: unknown) {
  const filter = { businessId, eventType: "email.received", ...(orderId ? { orderId } : {}) };
  const [pending, failed, review, oldest, last, worker] = await Promise.all([
    EmailWebhookEvent.countDocuments({ ...filter, state: { $in: ["QUEUED", "PROCESSING"] } }),
    EmailWebhookEvent.countDocuments({ ...filter, state: "FAILED" }),
    EmailWebhookEvent.countDocuments({ ...filter, state: "QUARANTINED" }),
    EmailWebhookEvent.findOne({ ...filter, state: { $in: ["QUEUED", "PROCESSING"] } })
      .sort({ createdAt: 1 })
      .select("createdAt")
      .lean(),
    EmailWebhookEvent.findOne({
      ...filter,
      state: "DONE",
      reason: null,
      source: "WEBHOOK",
      notificationPolicy: { $ne: "SUPPRESS" },
    })
      .sort({ processedAt: -1 })
      .select("processedAt")
      .lean(),
    EmailWorkerHealth.findOne({ key: "email" }).lean(),
  ]);
  const checks = {
    enabled: env.ORDER_EMAIL_INBOX_ENABLED === "true",
    provider: env.EMAIL_PROVIDER === "resend",
    receivingDomain: Boolean(env.EMAIL_RECEIVING_DOMAIN),
    signingSecret: Boolean(env.RESEND_WEBHOOK_SECRET),
    payloadSecret: Boolean(env.EMAIL_PAYLOAD_SECRET),
  };
  const configured = Object.values(checks).every(Boolean);
  const providerReady = configured ? await inspectProvider() : null;
  const oldestPendingAgeSeconds = oldest
    ? Math.max(0, Math.floor((Date.now() - oldest.createdAt.getTime()) / 1000))
    : 0;
  const workerFresh = worker?.heartbeatAt
    ? Date.now() - worker.heartbeatAt.getTime() < 90000
    : null;
  const status =
    !configured || providerReady === false
      ? "INCOMPLETE"
      : failed ||
          review ||
          oldestPendingAgeSeconds > 300 ||
          workerFresh === false ||
          worker?.inboundOk === false
        ? "DEGRADED"
        : last?.processedAt && workerFresh && providerReady === true && env.EMAIL_WEBHOOK_URL
          ? "HEALTHY"
          : "UNVERIFIED";
  const reasons = [
    ...Object.entries(checks)
      .filter(([, value]) => !value)
      .map(([key]) => `MISSING_${key.toUpperCase()}`),
    ...(configured && providerReady === false ? ["RECEIVING_WEBHOOK_MISSING"] : []),
    ...(configured && providerReady === null ? ["PROVIDER_INSPECTION_UNAVAILABLE"] : []),
    ...(!env.EMAIL_WEBHOOK_URL ? ["WEBHOOK_URL_UNCONFIRMED"] : []),
    ...(workerFresh !== true ? ["WORKER_UNCONFIRMED"] : []),
  ];
  return {
    status,
    pending,
    failed,
    review,
    oldestPendingAgeSeconds,
    lastProcessedAt: last?.processedAt ?? null,
    ...(administrator ? { checks, reasons, workerHeartbeatAt: worker?.heartbeatAt ?? null } : {}),
  };
}
