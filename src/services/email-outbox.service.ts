import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { EmailOutbox, EmailVerificationToken, OrderMessage } from "../models/index.js";
import { type EmailPayload, emailService } from "./email.service.js";

const encryptionKey = () =>
  createHash("sha256")
    .update(env.EMAIL_PAYLOAD_SECRET ?? env.JWT_SECRET)
    .digest();
export function protectEmailPayload(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}
export function readEmailPayload<T>(value: string): T {
  const buffer = Buffer.from(value, "base64url");
  const cipher = createDecipheriv("aes-256-gcm", encryptionKey(), buffer.subarray(0, 12));
  cipher.setAuthTag(buffer.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString("utf8"),
  ) as T;
}
export async function enqueueEmail(input: {
  businessId: unknown;
  entityId: unknown;
  userId?: unknown;
  key: string;
  purpose: "VERIFICATION" | "ORDER_MESSAGE" | "STAFF_NOTIFICATION";
  payload: EmailPayload;
  expiresAt?: Date;
}) {
  return EmailOutbox.findOneAndUpdate(
    { key: input.key },
    {
      $setOnInsert: {
        ...input,
        payload: protectEmailPayload(input.payload),
        expiresAt: input.expiresAt ?? new Date(Date.now() + 7 * 86400000),
      },
    },
    { upsert: true, new: true },
  );
}

export async function updateEmailDelivery(
  job: any,
  state: string,
  messageId?: string | null,
  eventId?: string,
) {
  if (job.purpose === "VERIFICATION") {
    await EmailVerificationToken.updateOne(
      { _id: job.entityId },
      {
        $set: {
          "delivery.status": state,
          "delivery.messageId": messageId ?? job.providerMessageId,
          "delivery.attemptCount": job.attemptCount,
          "delivery.lastAttemptAt": new Date(),
          "delivery.lastErrorCode": job.lastErrorCode ?? null,
        },
      },
    );
  } else if (job.purpose === "ORDER_MESSAGE") {
    const terminal = state === "BOUNCED" || state === "DELIVERED";
    await OrderMessage.updateOne(
      {
        _id: job.entityId,
        businessId: job.businessId,
        ...(!terminal
          ? { deliveryState: { $nin: ["BOUNCED", "DELIVERED"] } }
          : state === "DELIVERED"
            ? { deliveryState: { $ne: "BOUNCED" } }
            : {}),
      },
      {
        $set: {
          deliveryState: state,
          providerMessageId: messageId ?? job.providerMessageId,
          ...(job.rfcMessageId ? { rfcMessageId: job.rfcMessageId } : {}),
        },
        $push: { deliveryHistory: { state, at: new Date(), eventId } },
      },
    );
  }
}

export async function processEmailOutbox(limit = 10) {
  for (let i = 0; i < limit; i++) {
    const now = new Date();
    const job = await EmailOutbox.findOneAndUpdate(
      {
        state: { $in: ["QUEUED", "SENDING"] },
        nextAttemptAt: { $lte: now },
        $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }],
      },
      {
        $set: { state: "SENDING", leaseUntil: new Date(Date.now() + 120000) },
        $inc: { attemptCount: 1 },
      },
      { new: true, sort: { nextAttemptAt: 1 } },
    ).select("+payload");
    if (!job) break;
    try {
      // Provider idempotency keys are bounded in time: never blindly resend an uncertain old send.
      if (
        new Date(job.expiresAt).getTime() < Date.now() ||
        (job.attemptCount > 1 && Date.now() - new Date(job.createdAt).getTime() > 23 * 3600000)
      ) {
        job.state = "FAILED";
        job.lastErrorCode = "EXPIRED_OR_RECONCILIATION_REQUIRED";
        if (job.purpose === "VERIFICATION") job.payload = "";
      } else {
        if (job.purpose === "VERIFICATION") {
          const valid = await EmailVerificationToken.exists({
            _id: job.entityId,
            invalidatedAt: null,
            usedAt: null,
            expiresAt: { $gt: now },
          });
          if (!valid) {
            job.state = "FAILED";
            job.payload = "";
            job.lastErrorCode = "TOKEN_SUPERSEDED";
          }
        }
        if (job.state === "SENDING") {
          const payload = readEmailPayload<EmailPayload>(job.payload);
          const result = await emailService.send(payload, job.key);
          job.state = result.status;
          job.providerMessageId = result.messageId;
          job.lastErrorCode = null;
          // Verification links are erased after acceptance. Other payloads are retained only for explicit retry.
          if (job.purpose === "VERIFICATION") job.payload = "";
        }
      }
    } catch (error) {
      const code = error instanceof Error ? error.name : "SEND_ERROR";
      const permanent = /validation|invalid|restricted|forbidden|not_found/i.test(code);
      job.state = permanent || job.attemptCount >= 6 ? "FAILED" : "QUEUED";
      job.lastErrorCode = code.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
      job.nextAttemptAt = new Date(
        Date.now() + Math.min(3600000, 15000 * 2 ** job.attemptCount) + Math.random() * 3000,
      );
      console.warn(
        JSON.stringify({
          event: "email_send_failed",
          jobId: String(job._id),
          code: job.lastErrorCode,
        }),
      );
    }
    job.leaseUntil = null;
    await job.save();
    await updateEmailDelivery(job, job.state === "SENDING" ? "QUEUED" : job.state);
  }
}
