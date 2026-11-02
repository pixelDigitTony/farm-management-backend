import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { EmailRecoveryRun, EmailWebhookEvent, OrderMessage } from "../models/index.js";
import { emailService } from "./email.service.js";
import { protectEmailPayload } from "./email-outbox.service.js";
import { inspectInbound } from "./email-webhook.service.js";

export type RecoveryOptions = {
  environment: string;
  from: string;
  to: string;
  batchSize: number;
  maxItems: number;
  businessId?: string;
  orderId?: string;
  apply?: boolean;
  requeue?: boolean;
  reason?: string;
  runId?: string;
};
export function validateRecoveryOptions(options: RecoveryOptions) {
  if (options.environment !== env.NODE_ENV) throw new Error("ENVIRONMENT_MISMATCH");
  if (
    !Number.isFinite(Date.parse(options.from)) ||
    !Number.isFinite(Date.parse(options.to)) ||
    Date.parse(options.from) > Date.parse(options.to)
  )
    throw new Error("INVALID_DATE_RANGE");
  if (
    !Number.isInteger(options.batchSize) ||
    options.batchSize < 1 ||
    options.batchSize > 100 ||
    !Number.isInteger(options.maxItems) ||
    options.maxItems < 1 ||
    options.maxItems > 10000
  )
    throw new Error("INVALID_BATCH_SIZE");
  for (const id of [options.businessId, options.orderId])
    if (id && !/^[a-f\d]{24}$/i.test(id)) throw new Error("INVALID_SCOPE");
  if (options.requeue && (!options.reason?.trim() || options.reason.length > 200))
    throw new Error("REQUEUE_REASON_REQUIRED");
  if (options.runId && !/^[a-zA-Z\d_-]{16,100}$/.test(options.runId))
    throw new Error("INVALID_RUN_ID");
}
export async function recoverEmailReplies(options: RecoveryOptions) {
  validateRecoveryOptions(options);
  const runId = options.runId ?? randomUUID();
  const identity = {
    environment: options.environment,
    from: options.from,
    to: options.to,
    businessId: options.businessId ?? null,
    orderId: options.orderId ?? null,
    requeue: Boolean(options.requeue),
    reason: options.reason ?? null,
  };
  const leaseToken = randomUUID();
  let leased = false;
  let cursor: string | undefined;
  let counts = {
    scanned: 0,
    alreadyStored: 0,
    recoverable: 0,
    needsReview: 0,
    unavailable: 0,
    failedRetrieval: 0,
    enqueued: 0,
    excluded: 0,
  };
  try {
    if (options.apply) {
      const run = await EmailRecoveryRun.findOneAndUpdate(
        { runId },
        { $setOnInsert: { runId, options: identity, counts } },
        { new: true, upsert: true },
      ).lean();
      if (JSON.stringify(run.options) !== JSON.stringify(identity))
        throw new Error("RUN_OPTIONS_CHANGED");
      if (run.state === "COMPLETE")
        return { runId, counts: run.counts, complete: true, dryRun: false };
      const claimed = await EmailRecoveryRun.findOneAndUpdate(
        { runId, $or: [{ leaseUntil: null }, { leaseUntil: { $lt: new Date() } }] },
        { $set: { leaseToken, leaseUntil: new Date(Date.now() + 120000) } },
        { new: true },
      ).lean();
      if (!claimed) throw new Error("RECOVERY_RUN_BUSY");
      leased = true;
      cursor = claimed.cursor;
      counts = claimed.counts;
    }
    let processed = 0;
    let complete = false;
    while (processed < options.maxItems && !complete) {
      const page = await emailService.listReceived(
        cursor,
        Math.min(options.batchSize, options.maxItems - processed),
      );
      if (!page.data.length) {
        if (page.has_more) throw new Error("INVALID_PROVIDER_PAGINATION");
        complete = true;
      }
      for (const entry of page.data) {
        if (!entry.id || entry.id === cursor) throw new Error("INVALID_PROVIDER_PAGINATION");
        processed++;
        counts.scanned++;
        const at = Date.parse(entry.created_at);
        if (!Number.isFinite(at)) counts.unavailable++;
        else if (at >= Date.parse(options.from) && at <= Date.parse(options.to)) {
          if (await OrderMessage.exists({ providerInboundId: entry.id })) counts.alreadyStored++;
          else {
            let inspection: Awaited<ReturnType<typeof inspectInbound>> | undefined;
            try {
              inspection = await inspectInbound(await emailService.getReceived(entry.id));
            } catch (error) {
              if (error instanceof Error && error.message === "PROVIDER_EMAIL_UNAVAILABLE")
                counts.unavailable++;
              else counts.failedRetrieval++;
            }
            if (inspection) {
              const association = inspection.association;
              const excluded =
                (options.businessId && String(association?.businessId) !== options.businessId) ||
                (options.orderId && String(association?.orderId) !== options.orderId);
              if (excluded) counts.excluded++;
              else {
                const reason =
                  inspection.reason ??
                  (inspection.alias?.senderKind !== "CUSTOMER"
                    ? "STAFF_BACKFILL_UNSUPPORTED"
                    : null);
                if (reason) counts.needsReview++;
                else counts.recoverable++;
                const existing = await EmailWebhookEvent.findOne({
                  emailId: entry.id,
                  eventType: "email.received",
                })
                  .sort({ createdAt: 1 })
                  .lean();
                if (options.apply) {
                  if (!existing) {
                    const result = await EmailWebhookEvent.updateOne(
                      { eventId: `backfill-${entry.id}` },
                      {
                        $setOnInsert: {
                          eventId: `backfill-${entry.id}`,
                          emailId: entry.id,
                          eventType: "email.received",
                          payload: protectEmailPayload({
                            type: "email.received",
                            data: { email_id: entry.id },
                          }),
                          source: "PROVIDER_BACKFILL",
                          notificationPolicy: "SUPPRESS",
                          receivedAt: new Date(at),
                          ...association,
                          replayAudit: [{ at: new Date(), reason: "PROVIDER_BACKFILL", runId }],
                        },
                      },
                      { upsert: true },
                    );
                    counts.enqueued += result.upsertedCount;
                  } else if (
                    options.requeue &&
                    ["FAILED", "QUARANTINED"].includes(existing.state)
                  ) {
                    const result = await EmailWebhookEvent.updateOne(
                      { _id: existing._id, state: existing.state, leaseUntil: null },
                      {
                        $set: {
                          state: "QUEUED",
                          reason: null,
                          nextAttemptAt: new Date(),
                          attemptCount: 0,
                          notificationPolicy: "SUPPRESS",
                          expiresAt: new Date(Date.now() + 30 * 86400000),
                        },
                        $push: { replayAudit: { at: new Date(), reason: options.reason, runId } },
                      },
                    );
                    counts.enqueued += result.modifiedCount;
                  }
                }
              }
            }
          }
        } else counts.excluded++;
        cursor = entry.id;
        // Save after each item. A crash before this checkpoint safely revisits deduplicated work.
        if (options.apply) {
          const checkpoint = await EmailRecoveryRun.updateOne(
            { runId, leaseToken },
            { $set: { cursor, counts, leaseUntil: new Date(Date.now() + 120000) } },
          );
          if (!checkpoint.matchedCount) throw new Error("RECOVERY_LEASE_LOST");
        }
      }
      complete = !page.has_more;
    }
    if (options.apply)
      await EmailRecoveryRun.updateOne(
        { runId, leaseToken },
        { $set: { counts, cursor, state: complete ? "COMPLETE" : "RUNNING" } },
      );
    return { runId, counts, complete, dryRun: !options.apply, checkpoint: cursor ?? null };
  } finally {
    if (leased)
      await EmailRecoveryRun.updateOne(
        { runId, leaseToken },
        { $set: { leaseUntil: null, leaseToken: null } },
      );
  }
}
