import { Router } from "express";
import mongoose from "mongoose";
import * as v from "valibot";
import { env } from "../config/env.js";
import { HttpError } from "../lib/http-error.js";
import { getOwner } from "../middleware/auth.js";
import {
  Business,
  ConversationReadState,
  CustomerOrder,
  EmailOutbox,
  OrderConversation,
  OrderMessage,
  User,
} from "../models/index.js";
import {
  eligibleStaff,
  ensureConversation,
  inboxConfigured,
  initializeOrderEmail,
  messageDto,
  ownedOrder,
  storeOrderMessage,
  unreadCount,
} from "../services/order-messaging.service.js";
import { requireHighestRole } from "./employee.routes.js";

export const orderMessagingRouter = Router();
orderMessagingRouter.get("/email-settings", async (req, res) => {
  const owner = getOwner(req);
  const recipient = await eligibleStaff(owner.businessId);
  const business = await Business.findById(owner.businessId).select("ownerRole").lean();
  const highest = owner.role === 99 || owner.role === business?.ownerRole;
  const users = highest
    ? await User.find({
        businessId: owner.businessId,
        isActive: true,
        isApproved: true,
        status: "ACTIVE",
        emailVerifiedAt: { $ne: null },
      })
        .select("name email role")
        .lean()
    : [];
  const candidates = [];
  for (const user of users)
    if (await eligibleStaff(owner.businessId, user._id))
      candidates.push({ id: String(user._id), name: user.name, email: user.email });
  res.json({
    enabled: env.ORDER_EMAIL_INBOX_ENABLED === "true",
    configured: inboxConfigured(),
    provider: env.EMAIL_PROVIDER,
    recipient: recipient
      ? { id: String(recipient._id), name: recipient.name, email: recipient.email }
      : null,
    canConfigure: highest,
    candidates,
  });
});
orderMessagingRouter.patch("/email-settings", requireHighestRole, async (req, res) => {
  const owner = getOwner(req);
  const id = v.parse(
    v.nullable(v.pipe(v.string(), v.regex(/^[a-f\d]{24}$/i))),
    req.body.recipientUserId,
  );
  if (id && !(await eligibleStaff(owner.businessId, id)))
    throw new HttpError(422, "Choose an active verified user who can send order messages");
  await Business.updateOne({ _id: owner.businessId }, { $set: { orderEmailRecipientUserId: id } });
  res.json({ saved: true });
});
orderMessagingRouter.get("/inbox", async (req, res) => {
  const owner = getOwner(req);
  const search = String(req.query.search ?? "")
    .trim()
    .slice(0, 120);
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const filter: Record<string, unknown> = { businessId: owner.businessId };
  if (search)
    filter.$or = ["orderNumber", "customer.name", "customer.email"].map((key) => ({
      [key]: { $regex: escaped, $options: "i" },
    }));
  // Lazily initialize historical orders without sending acknowledgements for them.
  const recent = await CustomerOrder.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  const initialized = await OrderConversation.find({
    businessId: owner.businessId,
    orderId: { $in: recent.map((order) => order._id) },
  })
    .select("orderId")
    .lean();
  const initializedIds = new Set(initialized.map((item) => String(item.orderId)));
  for (const order of recent)
    if (!initializedIds.has(String(order._id))) await ensureConversation(order);
  const match: Record<string, unknown> = {
    businessId: owner.businessId,
    ...(search ? { orderId: { $in: recent.map((order) => order._id) } } : {}),
  };
  if (req.query.cursor) {
    let cursor: { at: string; id: string };
    try {
      cursor = JSON.parse(Buffer.from(String(req.query.cursor), "base64url").toString());
    } catch {
      throw new HttpError(422, "Invalid inbox cursor");
    }
    if (!mongoose.isValidObjectId(cursor.id) || !Number.isFinite(Date.parse(cursor.at)))
      throw new HttpError(422, "Invalid inbox cursor");
    match.$or = [
      { lastMessageAt: { $lt: new Date(cursor.at) } },
      { lastMessageAt: new Date(cursor.at), _id: { $lt: new mongoose.Types.ObjectId(cursor.id) } },
    ];
  }
  const rows = await OrderConversation.find(match)
    .sort({ lastMessageAt: -1, _id: -1 })
    .limit(101)
    .lean();
  const items = [];
  for (const row of rows.slice(0, 100)) {
    const order = await CustomerOrder.findOne({ _id: row.orderId, businessId: owner.businessId })
      .select("orderNumber customer status")
      .lean();
    if (!order) continue;
    const unread = await unreadCount(owner.businessId, row._id, owner.userId);
    if (req.query.unread === "true" && !unread) continue;
    items.push({
      _id: String(row._id),
      orderId: String(row.orderId),
      orderNumber: order.orderNumber,
      customer: order.customer,
      status: order.status,
      lastMessageAt: row.lastMessageAt,
      lastExcerpt: row.lastExcerpt,
      unreadCount: unread,
    });
  }
  const last = rows[99];
  res.set("Cache-Control", "no-store");
  res.json({
    enabled: env.ORDER_EMAIL_INBOX_ENABLED === "true",
    items,
    nextCursor:
      rows.length > 100 && last
        ? Buffer.from(JSON.stringify({ at: last.lastMessageAt, id: String(last._id) })).toString(
            "base64url",
          )
        : null,
  });
});
orderMessagingRouter.get("/:id/messages", async (req, res) => {
  const owner = getOwner(req);
  const order = await ownedOrder(owner.businessId, String(req.params.id));
  const conversation = await initializeOrderEmail(order);
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 30));
  const before = req.query.before ? Number(req.query.before) : null;
  if (before !== null && (!Number.isSafeInteger(before) || before < 1))
    throw new HttpError(422, "Invalid message cursor");
  const messages = await OrderMessage.find({
    businessId: owner.businessId,
    conversationId: conversation._id,
    ...(before ? { sequence: { $lt: before } } : {}),
  })
    .sort({ sequence: -1 })
    .limit(limit + 1)
    .lean();
  res.set("Cache-Control", "no-store");
  res.json({
    order: {
      _id: String(order._id),
      orderNumber: order.orderNumber,
      customer: order.customer,
      status: order.status,
    },
    configured: inboxConfigured(),
    items: messages.slice(0, limit).reverse().map(messageDto),
    nextCursor: messages.length > limit ? messages[limit - 1]!.sequence : null,
  });
});
const sendSchema = v.object({
  bodyText: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(10000)),
  clientMessageId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{16,100}$/)),
});
orderMessagingRouter.post("/:id/messages", async (req, res) => {
  if (!inboxConfigured())
    throw new HttpError(
      503,
      "Email inbox needs a configured receiving domain and feature activation",
    );
  const owner = getOwner(req);
  const order = await ownedOrder(owner.businessId, String(req.params.id));
  if (!order.customer.email)
    throw new HttpError(409, "Email messaging unavailable — no customer email was supplied");
  const input = v.parse(sendSchema, req.body);
  const staff = await User.findById(owner.userId).select("name").lean();
  const message = await storeOrderMessage(order, {
    ...input,
    senderKind: "STAFF",
    senderUserId: owner.userId,
    senderName: staff?.name,
  });
  res.status(202).json(messageDto(message));
});
orderMessagingRouter.patch("/:id/messages/read", async (req, res) => {
  const owner = getOwner(req);
  const order = await ownedOrder(owner.businessId, String(req.params.id));
  const conversation = await ensureConversation(order);
  const id = v.parse(v.pipe(v.string(), v.regex(/^[a-f\d]{24}$/i)), req.body.lastReadMessageId);
  const message = await OrderMessage.findOne({
    _id: id,
    businessId: owner.businessId,
    conversationId: conversation._id,
  }).lean();
  if (!message) throw new HttpError(404, "Message was not found");
  await ConversationReadState.updateOne(
    { businessId: owner.businessId, conversationId: conversation._id, userId: owner.userId },
    { $max: { lastReadSequence: message.sequence } },
    { upsert: true },
  );
  res.json({ saved: true });
});
orderMessagingRouter.post("/:id/messages/:messageId/retry", async (req, res) => {
  if (!inboxConfigured()) throw new HttpError(503, "Email messaging is not active");
  const owner = getOwner(req);
  const order = await ownedOrder(owner.businessId, String(req.params.id));
  const message = await OrderMessage.findOne({
    _id: req.params.messageId,
    businessId: owner.businessId,
    orderId: order._id,
    direction: "OUTBOUND",
  });
  if (!message) throw new HttpError(404, "Message was not found");
  if (message.deliveryState !== "FAILED")
    throw new HttpError(409, "This message cannot be retried");
  const job = await EmailOutbox.findOne({
    key: `order-message-${message._id}`,
    businessId: owner.businessId,
  });
  if (!job || job.providerMessageId || /EXPIRED_OR_RECONCILIATION/.test(job.lastErrorCode ?? ""))
    throw new HttpError(409, "Check provider delivery before retrying this message");
  await EmailOutbox.updateOne(
    { _id: job._id, state: "FAILED" },
    {
      $set: {
        state: "QUEUED",
        nextAttemptAt: new Date(),
        leaseUntil: null,
        attemptCount: 0,
        expiresAt: new Date(Date.now() + 86400000),
      },
    },
  );
  message.deliveryState = "QUEUED";
  await message.save();
  res.status(202).json(messageDto(message));
});
