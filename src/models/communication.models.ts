import { Schema } from "mongoose";
import { createModel, objectId, schemaOptions } from "./helpers.js";

const deliveryStates = [
  "QUEUED",
  "SENDING",
  "SENT",
  "DELIVERED",
  "FAILED",
  "BOUNCED",
  "DEVELOPMENT",
];
const outboxSchema = new Schema(
  {
    businessId: objectId("Business", true),
    purpose: {
      type: String,
      enum: ["VERIFICATION", "ORDER_MESSAGE", "STAFF_NOTIFICATION"],
      required: true,
    },
    entityId: objectId(undefined, true),
    userId: objectId("User"),
    key: { type: String, required: true, unique: true },
    payload: { type: String, default: "", select: false },
    state: { type: String, enum: deliveryStates, default: "QUEUED" },
    attemptCount: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    leaseUntil: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    providerMessageId: { type: String, default: null },
    rfcMessageId: { type: String, default: null },
    lastErrorCode: { type: String, default: null },
  },
  schemaOptions,
);
outboxSchema.index({ state: 1, nextAttemptAt: 1, leaseUntil: 1 });
outboxSchema.index({ providerMessageId: 1 }, { sparse: true });

const conversationSchema = new Schema(
  {
    businessId: objectId("Business", true),
    orderId: objectId("CustomerOrder", true),
    customerEmail: { type: String, default: "" },
    lastMessageAt: { type: Date, default: Date.now },
    lastSequence: { type: Number, default: 0 },
    lastExcerpt: { type: String, default: "" },
  },
  schemaOptions,
);
conversationSchema.index({ businessId: 1, orderId: 1 }, { unique: true });
conversationSchema.index({ businessId: 1, lastMessageAt: -1, _id: -1 });

const messageSchema = new Schema(
  {
    businessId: objectId("Business", true),
    conversationId: objectId("OrderConversation", true),
    orderId: objectId("CustomerOrder", true),
    sequence: { type: Number, required: true },
    direction: { type: String, enum: ["INBOUND", "OUTBOUND"], required: true },
    senderKind: { type: String, enum: ["CUSTOMER", "STAFF", "SYSTEM"], required: true },
    senderUserId: objectId("User"),
    senderName: { type: String, default: "" },
    bodyText: { type: String, default: "", maxlength: 10000 },
    quotedText: { type: String, default: "", maxlength: 10000 },
    hasAttachments: { type: Boolean, default: false },
    clientMessageId: { type: String, required: true },
    providerInboundId: { type: String },
    providerMessageId: { type: String, default: null },
    rfcMessageId: { type: String, default: null },
    inReplyTo: { type: String, default: null },
    deliveryState: { type: String, enum: [...deliveryStates, "RECEIVED"], default: "QUEUED" },
    deliveryHistory: { type: [{ state: String, at: Date, eventId: String }], default: [] },
    expiresAt: { type: Date, required: true },
  },
  schemaOptions,
);
messageSchema.index({ businessId: 1, conversationId: 1, clientMessageId: 1 }, { unique: true });
messageSchema.index({ businessId: 1, conversationId: 1, sequence: -1 });
messageSchema.index({ providerInboundId: 1 }, { unique: true, sparse: true });
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const readSchema = new Schema(
  {
    businessId: objectId("Business", true),
    conversationId: objectId("OrderConversation", true),
    userId: objectId("User", true),
    lastReadSequence: { type: Number, default: 0 },
  },
  schemaOptions,
);
readSchema.index({ businessId: 1, conversationId: 1, userId: 1 }, { unique: true });

const aliasSchema = new Schema(
  {
    businessId: objectId("Business", true),
    conversationId: objectId("OrderConversation", true),
    aliasHash: { type: String, required: true, unique: true },
    encryptedAlias: { type: String, required: true, select: false },
    senderKind: { type: String, enum: ["CUSTOMER", "STAFF"], required: true },
    permittedUserId: objectId("User"),
    revokedAt: { type: Date, default: null },
  },
  schemaOptions,
);
aliasSchema.index(
  { businessId: 1, conversationId: 1, senderKind: 1, permittedUserId: 1 },
  { unique: true },
);

const webhookSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true },
    eventType: { type: String, required: true },
    emailId: { type: String, required: true },
    payload: { type: String, required: true, select: false },
    state: {
      type: String,
      enum: ["QUEUED", "PROCESSING", "DONE", "QUARANTINED", "FAILED"],
      default: "QUEUED",
    },
    attemptCount: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    leaseUntil: { type: Date, default: null },
    reason: { type: String, default: null },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 30 * 86400000) },
  },
  schemaOptions,
);
webhookSchema.index({ state: 1, nextAttemptAt: 1, leaseUntil: 1 });
webhookSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailOutbox = createModel("EmailOutbox", outboxSchema);
export const OrderConversation = createModel("OrderConversation", conversationSchema);
export const OrderMessage = createModel("OrderMessage", messageSchema);
export const ConversationReadState = createModel("ConversationReadState", readSchema);
export const EmailReplyAlias = createModel("EmailReplyAlias", aliasSchema);
export const EmailWebhookEvent = createModel("EmailWebhookEvent", webhookSchema);
