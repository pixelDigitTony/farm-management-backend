import { env } from "../config/env.js";
import { inTransaction } from "../lib/transaction.js";
import {
  CustomerOrder,
  EmailOutbox,
  EmailReplyAlias,
  EmailWebhookEvent,
  OrderConversation,
  OrderMessage,
} from "../models/index.js";
import {
  INBOUND_POLICY_VERSION,
  inboundRisk,
  mailbox,
  parseReceivedEmail,
  recipientCandidates,
} from "./inbound-email.js";

export { inboundRisk, mailbox } from "./inbound-email.js";

import { emailService } from "./email.service.js";
import {
  protectEmailPayload,
  readEmailPayload,
  updateEmailDelivery,
} from "./email-outbox.service.js";
import {
  aliasHash,
  eligibleStaff,
  ensureConversation,
  notifyStaff,
  storeOrderMessage,
} from "./order-messaging.service.js";

export function inboundText(input: { text?: string | null; html?: string | null }) {
  const plain = (
    input.text ||
    (input.html ?? "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]*>/g, " ")
  )
    .replace(/\r\n/g, "\n")
    .trim();
  const split = plain.search(/\n(?:On .{1,200}wrote:|>)/);
  return {
    bodyText: (split >= 0 ? plain.slice(0, split) : plain).slice(0, 10000),
    quotedText: split >= 0 ? plain.slice(split).slice(0, 10000) : "",
  };
}
export async function saveWebhook(eventId: string, event: any) {
  if (
    !/^email\.(received|sent|delivered|bounced|failed|delivery_delayed|complained|suppressed)$/.test(
      event.type ?? "",
    )
  )
    return;
  const emailId = event.data?.email_id;
  if (typeof emailId !== "string" || emailId.length > 200) return;
  await EmailWebhookEvent.updateOne(
    { eventId },
    {
      $setOnInsert: {
        eventId,
        emailId,
        eventType: event.type,
        payload: protectEmailPayload(event),
        source: "WEBHOOK",
        notificationPolicy: "LIVE",
      },
    },
    { upsert: true },
  );
}

export async function inspectInbound(value: unknown) {
  const mail = parseReceivedEmail(value);
  const candidates = recipientCandidates(mail);
  const aliases = await EmailReplyAlias.find({
    aliasHash: { $in: [...candidates.keys()].map(aliasHash) },
    revokedAt: null,
  }).lean();
  const alias = aliases.length === 1 ? aliases[0] : null;
  if (!alias) return { mail, reason: "UNKNOWN_OR_AMBIGUOUS_ALIAS" };
  const conversation = await OrderConversation.findOne({
    _id: alias.conversationId,
    businessId: alias.businessId,
  }).lean();
  const order = conversation
    ? await CustomerOrder.findOne({
        _id: conversation.orderId,
        businessId: alias.businessId,
      }).lean()
    : null;
  if (!order) return { mail, reason: "ORDER_UNAVAILABLE" };
  const association = {
    businessId: alias.businessId,
    conversationId: alias.conversationId,
    orderId: order._id,
  };
  const provenance = [
    ...new Set(
      [...candidates]
        .filter(([address]) => aliasHash(address) === alias.aliasHash)
        .flatMap(([, fields]) => fields),
    ),
  ];
  const risk = inboundRisk(mail.headers ?? {}, mail.authentication);
  const staff =
    alias.senderKind === "STAFF"
      ? await eligibleStaff(alias.businessId, alias.permittedUserId)
      : null;
  const expected = alias.senderKind === "STAFF" ? staff?.email : conversation?.customerEmail;
  const reason =
    risk ??
    (!expected || mailbox(mail.from) !== mailbox(expected) ? "SENDER_NOT_AUTHORIZED" : null);
  return { mail, alias, order, staff, association, provenance, reason };
}
async function processInbound(job: any) {
  const inspection = await inspectInbound(await emailService.getReceived(job.emailId));
  job.policyVersion = INBOUND_POLICY_VERSION;
  if (inspection.association) Object.assign(job, inspection.association);
  job.recipientProvenance = inspection.provenance ?? [];
  const { mail, alias, order, staff } = inspection;
  if (inspection.reason || !alias || !order) {
    job.reason = inspection.reason;
    job.state = inspection.reason === "AUTOMATED_MESSAGE" ? "DONE" : "QUARANTINED";
    return;
  }
  // Historical staff mail must never be sent again by a customer-reply import.
  if (
    (job.source === "PROVIDER_BACKFILL" || job.notificationPolicy === "SUPPRESS") &&
    alias.senderKind !== "CUSTOMER"
  ) {
    job.state = "QUARANTINED";
    job.reason = "STAFF_BACKFILL_UNSUPPORTED";
    return;
  }
  const content = inboundText(mail);
  const attachments = mail.attachments.length > 0;
  if (!content.bodyText && !attachments) {
    job.state = "DONE";
    job.reason = "EMPTY_MESSAGE";
    return;
  }
  const receivedAt = mail.created_at
    ? new Date(mail.created_at)
    : (job.receivedAt ?? job.createdAt);
  if (!Number.isFinite(receivedAt.getTime())) throw new Error("INVALID_RECEIPT_TIME");
  job.receivedAt = receivedAt;
  // Commit the message, sequence and notification intent together. A concurrent import
  // or callback observes the first persisted message's notification policy on retry.
  await inTransaction(async () => {
    const message = await storeOrderMessage(order, {
      ...content,
      bodyText: content.bodyText || "Attachment received; viewing is not available here.",
      clientMessageId: `inbound-${job.emailId}`,
      providerInboundId: job.emailId,
      senderKind: alias.senderKind,
      senderUserId: staff?._id,
      senderName: staff?.name ?? order.customer.name,
      direction: alias.senderKind === "CUSTOMER" ? "INBOUND" : "OUTBOUND",
      hasAttachments: attachments,
      receivedAt,
      recovered: job.source === "PROVIDER_BACKFILL" || job.notificationPolicy === "SUPPRESS",
      notificationPolicy: job.notificationPolicy ?? "LIVE",
      rfcMessageId: String(mail.message_id ?? "")
        .replace(/[\r\n]/g, "")
        .slice(0, 300),
      inReplyTo: String(
        Object.entries(mail.headers ?? {}).find(
          ([key]) => key.toLowerCase() === "in-reply-to",
        )?.[1] ?? "",
      )
        .replace(/[\r\n]/g, "")
        .slice(0, 300),
    });
    if (
      alias.senderKind === "CUSTOMER" &&
      message.notificationPolicy !== "SUPPRESS" &&
      env.ORDER_EMAIL_INBOX_ENABLED === "true"
    )
      await notifyStaff(order, await ensureConversation(order), message);
  });
  job.reason = null;
  job.state = "DONE";
}
async function processDelivery(job: any, event: any) {
  const outbox = await EmailOutbox.findOne({ providerMessageId: job.emailId });
  if (!outbox) throw new Error("Delivery event awaiting send reconciliation");
  const status =
    event.type === "email.delivered"
      ? "DELIVERED"
      : ["email.bounced", "email.complained", "email.suppressed"].includes(event.type)
        ? "BOUNCED"
        : event.type === "email.failed"
          ? "FAILED"
          : event.type === "email.sent"
            ? "SENT"
            : null;
  if (status) {
    const rank: Record<string, number> = {
      QUEUED: 0,
      SENDING: 1,
      SENT: 2,
      FAILED: 3,
      DELIVERED: 4,
      BOUNCED: 5,
    };
    if ((rank[status] ?? 0) >= (rank[outbox.state] ?? 0)) {
      outbox.state = status;
      if (event.data?.message_id)
        outbox.rfcMessageId = String(event.data.message_id)
          .replace(/[\r\n]/g, "")
          .slice(0, 300);
      await outbox.save();
      await updateEmailDelivery(outbox, status, job.emailId, job.eventId);
    }
  }
  job.state = "DONE";
}
export async function processEmailWebhooks(limit = 10) {
  for (let index = 0; index < limit; index++) {
    const now = new Date();
    const job = await EmailWebhookEvent.findOneAndUpdate(
      {
        state: { $in: ["QUEUED", "PROCESSING"] },
        nextAttemptAt: { $lte: now },
        $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }],
      },
      {
        $set: { state: "PROCESSING", leaseUntil: new Date(Date.now() + 120000) },
        $inc: { attemptCount: 1 },
      },
      { new: true, sort: { nextAttemptAt: 1 } },
    ).select("+payload");
    if (!job) break;
    try {
      const payload = readEmailPayload<any>(job.payload);
      if (job.eventType === "email.received") await processInbound(job);
      else await processDelivery(job, payload);
    } catch (error) {
      job.state = job.attemptCount >= 10 ? "FAILED" : "QUEUED";
      const code = error instanceof Error ? error.message : "";
      job.reason = [
        "PROVIDER_PERMISSION_DENIED",
        "PROVIDER_EMAIL_UNAVAILABLE",
        "INVALID_RECEIVED_EMAIL",
        "INVALID_RECEIPT_TIME",
      ].includes(code)
        ? code
        : "PROCESSING_RETRY";
      job.nextAttemptAt = new Date(Date.now() + Math.min(3600000, 15000 * 2 ** job.attemptCount));
      console.warn(
        JSON.stringify({
          event: "email_webhook_retry",
          eventId: job.eventId,
          attempt: job.attemptCount,
        }),
      );
    }
    if (job.state === "DONE") job.processedAt = new Date();
    job.leaseUntil = null;
    await job.save();
  }
}
export async function reconcileSentMetadata() {
  const pending = await EmailOutbox.find({
    state: { $in: ["SENT", "DELIVERED"] },
    providerMessageId: { $ne: null },
    rfcMessageId: null,
  }).limit(10);
  for (const job of pending) {
    try {
      const mail = (await emailService.getSent(job.providerMessageId)) as any;
      if (mail.message_id) {
        job.rfcMessageId = String(mail.message_id)
          .replace(/[\r\n]/g, "")
          .slice(0, 300);
        await job.save();
        await OrderMessage.updateOne(
          { _id: job.entityId, businessId: job.businessId },
          { $set: { rfcMessageId: job.rfcMessageId } },
        );
      }
    } catch {
      /* Retry metadata lookup on the next worker cycle; do not resend. */
    }
  }
}
