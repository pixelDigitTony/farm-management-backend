import mongoose from "mongoose";
import { createModel, money, objectId, schemaOptions } from "./helpers.js";

const { Schema } = mongoose;

const userSchema = new Schema(
  {
    businessId: objectId("Business", true),
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    emailNormalized: { type: String, required: true, lowercase: true, trim: true, select: false },
    emailVerifiedAt: { type: Date, default: null },
    phone: { type: String, required: true, trim: true },
    phoneNormalized: { type: String, required: true, trim: true, select: false },
    passwordHash: { type: String, required: true, select: false },
    mpinHash: { type: String, required: true, select: false },
    role: { type: String, enum: ["OWNER"], default: "OWNER" },
    status: {
      type: String,
      enum: ["PENDING_EMAIL_VERIFICATION", "ACTIVE", "LOCKED", "DISABLED"],
      default: "PENDING_EMAIL_VERIFICATION",
    },
    isActive: { type: Boolean, default: true },
    passwordSecurity: {
      failedAttempts: { type: Number, default: 0 },
      lockedUntil: { type: Date, default: null },
      passwordChangedAt: { type: Date, default: null },
    },
    mpinSecurity: {
      failedAttempts: { type: Number, default: 0 },
      lockedUntil: { type: Date, default: null },
      mpinChangedAt: { type: Date, default: null },
    },
    lastLoginAt: Date,
    lastLoginMethod: {
      type: String,
      enum: ["EMAIL_PASSWORD", "PHONE_MPIN"],
      default: null,
    },
  },
  schemaOptions,
);
userSchema.index({ emailNormalized: 1 }, { unique: true, sparse: true });
userSchema.index({ phoneNormalized: 1 }, { unique: true, sparse: true });
userSchema.index({ role: 1 }, { unique: true });
userSchema.index({ businessId: 1, status: 1 });

const emailVerificationTokenSchema = new Schema(
  {
    userId: objectId("User", true),
    emailNormalized: { type: String, required: true, lowercase: true, trim: true },
    tokenHash: { type: String, required: true, unique: true, select: false },
    purpose: { type: String, enum: ["VERIFY_EMAIL"], default: "VERIFY_EMAIL" },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    invalidatedAt: { type: Date, default: null },
    delivery: {
      // Keep CLOUDFLARE for existing delivery history created before the Resend migration.
      provider: { type: String, enum: ["RESEND", "CONSOLE", "CLOUDFLARE"], required: true },
      status: {
        type: String,
        enum: ["PENDING", "SENT", "QUEUED", "DELIVERED", "FAILED", "BOUNCED"],
        default: "PENDING",
      },
      messageId: { type: String, default: null },
      attemptCount: { type: Number, default: 0 },
      lastAttemptAt: { type: Date, default: null },
      lastErrorCode: { type: String, default: null },
      lastErrorMessage: { type: String, default: null },
    },
  },
  { ...schemaOptions, collection: "email_verification_tokens" },
);
emailVerificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
emailVerificationTokenSchema.index({ userId: 1, purpose: 1, usedAt: 1 });

const authSessionSchema = new Schema(
  {
    userId: objectId("User", true),
    businessId: objectId("Business", true),
    refreshTokenHash: { type: String, required: true, unique: true, select: false },
    loginMethod: {
      type: String,
      enum: ["EMAIL_PASSWORD", "PHONE_MPIN"],
      required: true,
    },
    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
    revokeReason: {
      type: String,
      enum: ["LOGOUT", "PASSWORD_CHANGED", "MPIN_CHANGED", "SECURITY", null],
      default: null,
    },
  },
  { ...schemaOptions, collection: "auth_sessions" },
);
authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
authSessionSchema.index({ userId: 1, revokedAt: 1 });

const businessSchema = new Schema(
  {
    businessName: { type: String, required: true, trim: true },
    ownerUserId: objectId("User"),
    currency: { type: String, enum: ["PHP"], default: "PHP" },
    timezone: { type: String, default: "Asia/Manila" },
    piggery: {
      name: { type: String, default: "Miss V Piggery" },
      address: String,
      startingDate: Date,
    },
    karenderiya: {
      name: { type: String, default: "Miss V Karenderiya" },
      address: String,
      startingDate: Date,
    },
    settings: {
      inventoryValuationMethod: {
        type: String,
        enum: ["FIFO", "WEIGHTED_AVERAGE"],
        default: "FIFO",
      },
      generalExpenseAllocation: {
        type: String,
        enum: ["GENERAL_ONLY", "EQUAL_PER_ACTIVE_PIG", "MANUAL"],
        default: "GENERAL_ONLY",
      },
      defaultTargetFoodCostPercent: { ...money, default: 35 },
      meatTransferPricingMethod: {
        type: String,
        enum: ["PRODUCTION_COST", "OWNER_SET_PRICE"],
        default: "PRODUCTION_COST",
      },
    },
  },
  schemaOptions,
);

const contactSchema = new Schema(
  {
    businessId: objectId("Business", true),
    contactCode: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    types: [
      {
        type: String,
        enum: ["SUPPLIER", "BUYER", "VETERINARIAN", "BUTCHER", "SLAUGHTERHOUSE", "OTHER"],
      },
    ],
    phone: String,
    email: String,
    address: String,
    notes: String,
    isActive: { type: Boolean, default: true },
  },
  schemaOptions,
);
contactSchema.index({ businessId: 1, contactCode: 1 }, { unique: true });

const auditLogSchema = new Schema(
  {
    businessId: objectId("Business", true),
    userId: objectId("User", true),
    action: {
      type: String,
      enum: [
        "CREATE",
        "UPDATE",
        "DELETE",
        "POST",
        "VOID",
        "ADJUST",
        "LOGIN",
        "REGISTER",
        "VERIFY_EMAIL",
        "LOGOUT",
      ],
      required: true,
    },
    targetCollection: { type: String, required: true },
    targetDocumentId: objectId(),
    changedFields: [String],
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    reason: String,
    requestMethod: {
      type: String,
      enum: ["POST", "PUT", "PATCH", "DELETE"],
    },
    requestPath: String,
    responseStatus: Number,
    outcome: { type: String, enum: ["SUCCESS", "FAILED"], default: "SUCCESS" },
    errorMessage: String,
    ipAddress: String,
    userAgent: String,
  },
  schemaOptions,
);
auditLogSchema.index({ businessId: 1, createdAt: -1 });
auditLogSchema.index({ businessId: 1, action: 1, createdAt: -1 });
auditLogSchema.index({ businessId: 1, outcome: 1, createdAt: -1 });

export const User = createModel("User", userSchema);
export const EmailVerificationToken = createModel(
  "EmailVerificationToken",
  emailVerificationTokenSchema,
);
export const AuthSession = createModel("AuthSession", authSessionSchema);
export const Business = createModel("Business", businessSchema);
export const Contact = createModel("Contact", contactSchema);
export const AuditLog = createModel("AuditLog", auditLogSchema);
