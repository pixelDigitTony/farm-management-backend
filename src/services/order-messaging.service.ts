import { createHash, randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { HttpError } from "../lib/http-error.js";
import { effectivePermissions } from "../lib/permissions.js";
import {
  Business,
  ConversationReadState,
  CustomerOrder,
  EmailOutbox,
  EmailReplyAlias,
  OrderConversation,
  OrderMessage,
  User,
} from "../models/index.js";
import { enqueueEmail, protectEmailPayload, readEmailPayload } from "./email-outbox.service.js";

export const aliasHash = (value: string) =>
  createHash("sha256").update(value.toLowerCase()).digest("hex");
export function inboxConfigured() {
  return env.ORDER_EMAIL_INBOX_ENABLED === "true" && Boolean(env.EMAIL_RECEIVING_DOMAIN);
}
export async function ownedOrder(businessId: unknown, id: string) {
  if (!mongoose.isValidObjectId(id)) throw new HttpError(404, "Order was not found");
  const order = await CustomerOrder.findOne({ _id: id, businessId }).lean();
  if (!order) throw new HttpError(404, "Order was not found");
  return order;
}
export async function ensureConversation(order: any) {
  const conversation = await OrderConversation.findOneAndUpdate(
    { businessId: order.businessId, orderId: order._id },
    {
      $setOnInsert: {
        businessId: order.businessId,
        orderId: order._id,
        customerEmail: order.customer.email,
        lastMessageAt: order.createdAt,
      },
    },
    { new: true, upsert: true },
  );
  if (!order.emailConversationInitialized)
    await CustomerOrder.updateOne(
      { _id: order._id, businessId: order.businessId },
      { $set: { emailConversationInitialized: true } },
    );
  return conversation;
}
async function replyAddress(conversation: any, kind: "CUSTOMER" | "STAFF", userId?: unknown) {
  const filter = {
    businessId: conversation.businessId,
    conversationId: conversation._id,
    senderKind: kind,
    permittedUserId: userId ?? null,
  };
  const raw = `reply-${randomBytes(24).toString("hex")}@${env.EMAIL_RECEIVING_DOMAIN}`;
  const alias = await EmailReplyAlias.findOneAndUpdate(
    filter,
    {
      $setOnInsert: {
        ...filter,
        aliasHash: aliasHash(raw),
        encryptedAlias: protectEmailPayload(raw),
      },
    },
    { new: true, upsert: true },
  ).select("+encryptedAlias");
  if (alias.revokedAt) throw new HttpError(409, "This email reply address has been revoked");
  return readEmailPayload<string>(alias.encryptedAlias);
}
export async function eligibleStaff(businessId: unknown, userId?: unknown) {
  const business = await Business.findById(businessId).lean();
  if (!business) return null;
  const chosen = userId ?? business.orderEmailRecipientUserId;
  const filter = {
    businessId,
    isActive: true,
    isApproved: true,
    status: "ACTIVE",
    emailVerifiedAt: { $ne: null },
  };
  const users = chosen
    ? await User.find({ ...filter, _id: chosen }).lean()
    : await User.find({ ...filter, role: business.ownerRole })
        .limit(2)
        .lean();
  const user = users[0];
  if (users.length !== 1 || !user) return null;
  const highest = user.role === 99 || user.role === business.ownerRole;
  const role = business.roles.find((entry: any) => entry.level === user.role);
  const permissions = effectivePermissions(role, highest);
  return permissions.includes("orders:view") && permissions.includes("orders:edit") ? user : null;
}
export async function queueOrderMessage(order: any, conversation: any, message: any) {
  if (message.direction !== "OUTBOUND" || !inboxConfigured() || !conversation.customerEmail) return;
  const address = await replyAddress(conversation, "CUSTOMER");
  const prior = await OrderMessage.find({
    businessId: order.businessId,
    conversationId: conversation._id,
    sequence: { $lt: message.sequence },
    rfcMessageId: { $ne: null },
  })
    .sort({ sequence: -1 })
    .limit(8)
    .lean();
  const previous = prior[0];
  const headers = previous?.rfcMessageId
    ? {
        "In-Reply-To": previous.rfcMessageId,
        References: prior
          .map((item) => item.rfcMessageId)
          .reverse()
          .join(" ")
          .slice(-2400),
      }
    : undefined;
  await enqueueEmail({
    businessId: order.businessId,
    entityId: message._id,
    purpose: "ORDER_MESSAGE",
    key: `order-message-${message._id}`,
    payload: {
      to: conversation.customerEmail,
      subject: `${previous ? "Re: " : ""}Order ${order.orderNumber}`,
      text: message.bodyText,
      replyTo: address,
      headers,
    },
  });
}
export async function storeOrderMessage(
  order: any,
  input: {
    bodyText: string;
    clientMessageId: string;
    senderKind: "STAFF" | "SYSTEM" | "CUSTOMER";
    senderUserId?: unknown;
    senderName?: string;
    direction?: "INBOUND" | "OUTBOUND";
    providerInboundId?: string;
    rfcMessageId?: string;
    inReplyTo?: string;
    quotedText?: string;
    hasAttachments?: boolean;
  },
) {
  const conversation = await ensureConversation(order);
  const filter = {
    businessId: order.businessId,
    conversationId: conversation._id,
    clientMessageId: input.clientMessageId,
  };
  let existing = await OrderMessage.findOne(filter);
  if (existing && existing.bodyText !== input.bodyText)
    throw new HttpError(409, "This message key already belongs to different text");
  if (!existing) {
    const next = await OrderConversation.findOneAndUpdate(
      { _id: conversation._id, businessId: order.businessId },
      { $inc: { lastSequence: 1 } },
      { new: true },
    );
    try {
      existing = await OrderMessage.create({
        ...filter,
        ...input,
        orderId: order._id,
        sequence: next?.lastSequence,
        direction: input.direction ?? "OUTBOUND",
        deliveryState: input.direction === "INBOUND" ? "RECEIVED" : "QUEUED",
        expiresAt: new Date(Date.now() + env.ORDER_MESSAGE_RETENTION_DAYS * 86400000),
      });
    } catch (error: any) {
      if (error.code !== 11000) throw error;
      existing = await OrderMessage.findOne(filter);
      if (!existing) throw error;
    }
  }
  await OrderConversation.updateOne(
    {
      _id: conversation._id,
      businessId: order.businessId,
      lastMessageAt: { $lte: existing.createdAt },
    },
    { $set: { lastMessageAt: existing.createdAt, lastExcerpt: existing.bodyText.slice(0, 120) } },
  );
  await queueOrderMessage(order, conversation, existing);
  return existing;
}
export async function initializeOrderEmail(order: any) {
  const conversation = await ensureConversation(order);
  if (order.emailNotificationPending && inboxConfigured()) {
    if (conversation.customerEmail)
      await storeOrderMessage(order, {
        clientMessageId: `ack-${order._id}`,
        senderKind: "SYSTEM",
        bodyText: `Thank you, ${order.customer.name}. We received order ${order.orderNumber}. Reply to this email if you have any questions about your order.`,
      });
    await CustomerOrder.updateOne(
      { _id: order._id, businessId: order.businessId },
      { $set: { emailNotificationPending: false } },
    );
  }
  return conversation;
}
export async function repairOrderEmail() {
  if (!inboxConfigured()) return;
  const pending = await CustomerOrder.find({ emailNotificationPending: true })
    .sort({ createdAt: 1 })
    .limit(20)
    .lean();
  for (const order of pending) await initializeOrderEmail(order);
  const historical = await CustomerOrder.find({ emailConversationInitialized: { $ne: true } })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  for (const order of historical) await ensureConversation(order);
  const queued = await OrderMessage.find({ direction: "OUTBOUND", deliveryState: "QUEUED" })
    .sort({ createdAt: 1 })
    .limit(30)
    .lean();
  for (const message of queued) {
    if (await EmailOutbox.exists({ key: `order-message-${message._id}` })) continue;
    const order = await ownedOrder(message.businessId, String(message.orderId));
    await queueOrderMessage(order, await ensureConversation(order), message);
  }
}
export async function notifyStaff(order: any, conversation: any, message: any) {
  const staff = await eligibleStaff(order.businessId);
  if (!staff) return;
  const replyTo = await replyAddress(conversation, "STAFF", staff._id);
  await enqueueEmail({
    businessId: order.businessId,
    entityId: message._id,
    userId: staff._id,
    purpose: "STAFF_NOTIFICATION",
    key: `notify-${message._id}-${staff._id}`,
    payload: {
      to: staff.email,
      subject: `Customer reply · ${order.orderNumber}`,
      text: `${order.customer.name} wrote:\n\n${message.bodyText}\n\nReply to this email to send a response to the customer, or open Customer Orders in the app.`,
      replyTo,
    },
  });
}
export function messageDto(message: any) {
  return {
    _id: String(message._id),
    sequence: message.sequence,
    bodyText: message.bodyText,
    quotedText: message.quotedText,
    hasAttachments: message.hasAttachments,
    direction: message.direction,
    senderKind: message.senderKind,
    senderName: message.senderName,
    deliveryState: message.deliveryState,
    createdAt: message.createdAt,
  };
}
export async function unreadCount(businessId: unknown, conversationId: unknown, userId: unknown) {
  const read = await ConversationReadState.findOne({ businessId, conversationId, userId }).lean();
  return OrderMessage.countDocuments({
    businessId,
    conversationId,
    direction: "INBOUND",
    sequence: { $gt: read?.lastReadSequence ?? 0 },
  });
}
