import { env } from "../config/env.js";
import {
  CustomerOrder,
  EmailOutbox,
  EmailReplyAlias,
  EmailWebhookEvent,
  OrderMessage,
} from "../models/index.js";
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

export function mailbox(value: string) {
  const address = value.match(/<([^<>]+)>/)?.[1] ?? value;
  return address.trim().toLowerCase();
}
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
export function inboundRisk(headers: Record<string, string>, sender?: string) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
  if (
    /auto-(?:replied|generated)/i.test(normalized["auto-submitted"] ?? "") ||
    /bulk|list|junk/i.test(normalized.precedence ?? "") ||
    /mailer-daemon|postmaster/i.test(normalized.from ?? "")
  )
    return "AUTOMATED_MESSAGE";
  if (/yes|true/i.test(normalized["x-spam-flag"] ?? "")) return "SPAM";
  const auth = normalized["authentication-results"] ?? "";
  // Missing or failed authentication is quarantined, rather than forwarded using From alone.
  if (!/\b(?:dmarc|dkim|spf)=pass\b/i.test(auth) || /\bdmarc=fail\b/i.test(auth))
    return "AUTHENTICATION_UNCONFIRMED";
  if (sender) {
    const domain = sender.split("@").at(-1)?.toLowerCase();
    const aligned = auth.split(";").some((part) => {
      const signingDomain = part
        .match(/\bheader\.(?:from|d)\s*=\s*"?([^\s;"]+)/i)?.[1]
        ?.toLowerCase();
      return (
        domain &&
        signingDomain &&
        /\b(?:dmarc|dkim)=pass\b/i.test(part) &&
        (signingDomain === domain || signingDomain.endsWith(`.${domain}`))
      );
    });
    if (!aligned) return "SENDER_AUTHENTICATION_NOT_ALIGNED";
  }
  return null;
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
      },
    },
    { upsert: true },
  );
}

async function processInbound(job: any, payload: any) {
  const mail = (await emailService.getReceived(job.emailId)) as any;
  const sender = mailbox(String(mail.from ?? payload.data.from ?? ""));
  // Route by the provider's SMTP envelope recipients, not the sender-controlled To header.
  const recipients: string[] = Array.isArray(mail.received_for) ? mail.received_for : [];
  const aliases = await EmailReplyAlias.find({
    aliasHash: { $in: recipients.map((address) => aliasHash(mailbox(address))) },
    revokedAt: null,
  }).lean();
  const alias = aliases[0];
  if (aliases.length !== 1 || !alias) {
    job.state = "QUARANTINED";
    job.reason = "UNKNOWN_OR_AMBIGUOUS_ALIAS";
    return;
  }
  const orderConversation = await (
    await import("../models/communication.models.js")
  ).OrderConversation.findOne({ _id: alias.conversationId, businessId: alias.businessId }).lean();
  const order = orderConversation
    ? await CustomerOrder.findOne({
        _id: orderConversation.orderId,
        businessId: alias.businessId,
      }).lean()
    : null;
  if (!order) {
    job.state = "QUARANTINED";
    job.reason = "ORDER_UNAVAILABLE";
    return;
  }
  const risk = inboundRisk(mail.headers ?? {}, sender);
  if (risk) {
    job.state = risk === "AUTOMATED_MESSAGE" ? "DONE" : "QUARANTINED";
    job.reason = risk;
    return;
  }
  const staff =
    alias.senderKind === "STAFF"
      ? await eligibleStaff(alias.businessId, alias.permittedUserId)
      : null;
  const expected = alias.senderKind === "STAFF" ? staff?.email : orderConversation?.customerEmail;
  if (!expected || sender !== expected.toLowerCase()) {
    job.state = "QUARANTINED";
    job.reason = "SENDER_NOT_AUTHORIZED";
    return;
  }
  const content = inboundText(mail);
  const attachments = Boolean(mail.attachments?.length || payload.data.attachments?.length);
  if (!content.bodyText && !attachments) {
    job.state = "DONE";
    job.reason = "EMPTY_MESSAGE";
    return;
  }
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
    rfcMessageId: String(mail.message_id ?? payload.data.message_id ?? "")
      .replace(/[\r\n]/g, "")
      .slice(0, 300),
    inReplyTo: String(mail.headers?.["in-reply-to"] ?? "")
      .replace(/[\r\n]/g, "")
      .slice(0, 300),
  });
  if (alias.senderKind === "CUSTOMER" && env.ORDER_EMAIL_INBOX_ENABLED === "true")
    await notifyStaff(order, await ensureConversation(order), message);
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
      if (job.eventType === "email.received") await processInbound(job, payload);
      else await processDelivery(job, payload);
    } catch {
      job.state = job.attemptCount >= 10 ? "FAILED" : "QUEUED";
      job.reason = "PROCESSING_RETRY";
      job.nextAttemptAt = new Date(Date.now() + Math.min(3600000, 15000 * 2 ** job.attemptCount));
      console.warn(
        JSON.stringify({
          event: "email_webhook_retry",
          eventId: job.eventId,
          attempt: job.attemptCount,
        }),
      );
    }
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
