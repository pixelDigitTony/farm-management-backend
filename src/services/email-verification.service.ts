import { env } from "../config/env.js";
import { createOpaqueToken, hashOpaqueToken } from "../lib/auth-utils.js";
import { HttpError } from "../lib/http-error.js";
import { inTransaction } from "../lib/transaction.js";
import { Business, EmailVerificationToken, User } from "../models/index.js";
import { verificationPayload } from "./email.service.js";
import { enqueueEmail } from "./email-outbox.service.js";

type VerificationUser = {
  _id: unknown;
  id: string;
  name: string;
  email: string;
  emailNormalized: string;
  businessId?: unknown;
};
export async function issueVerificationEmail(
  user: VerificationUser,
  options: { enforceRateLimit?: boolean } = {},
) {
  const now = new Date();
  const claim = await User.findOneAndUpdate(
    {
      _id: user._id,
      $or: [{ verificationIssueLeaseUntil: null }, { verificationIssueLeaseUntil: { $lt: now } }],
    },
    { $set: { verificationIssueLeaseUntil: new Date(Date.now() + 60000) } },
    { new: true },
  );
  if (!claim)
    throw new HttpError(
      429,
      "A verification email is already being requested",
      { retryAfterSeconds: 60 },
      "EMAIL_RESEND_COOLDOWN",
    );
  try {
    if (options.enforceRateLimit !== false) {
      const latest = await EmailVerificationToken.findOne({
        userId: user._id,
        purpose: "VERIFY_EMAIL",
      })
        .sort({ createdAt: -1 })
        .lean();
      const retryAfterSeconds = latest
        ? Math.max(
            0,
            Math.ceil(
              (new Date(latest.createdAt).getTime() +
                env.EMAIL_RESEND_COOLDOWN_SECONDS * 1000 -
                now.getTime()) /
                1000,
            ),
          )
        : 0;
      if (retryAfterSeconds)
        throw new HttpError(
          429,
          "Please wait before requesting another verification email",
          { retryAfterSeconds },
          "EMAIL_RESEND_COOLDOWN",
        );
      const count = await EmailVerificationToken.countDocuments({
        userId: user._id,
        purpose: "VERIFY_EMAIL",
        createdAt: { $gte: new Date(now.getTime() - 3600000) },
      });
      if (count >= env.EMAIL_MAX_RESENDS_PER_HOUR)
        throw new HttpError(
          429,
          "Too many verification emails requested. Try again later",
          { retryAfterSeconds: 3600 },
          "EMAIL_RESEND_LIMIT",
        );
    }
    const raw = createOpaqueToken();
    const expiresAt = new Date(now.getTime() + env.EMAIL_VERIFICATION_TTL_MINUTES * 60000);
    const verificationUrl = `${env.FRONTEND_URL.replace(/\/$/, "")}/verify-email?token=${encodeURIComponent(raw)}`;
    try {
      const business = await Business.findById(user.businessId ?? claim.businessId)
        .select("businessName")
        .lean();
      await inTransaction(async () => {
        await EmailVerificationToken.updateMany(
          { userId: user._id, purpose: "VERIFY_EMAIL", usedAt: null, invalidatedAt: null },
          { $set: { invalidatedAt: now } },
        );
        const token = await EmailVerificationToken.create({
          userId: user._id,
          emailNormalized: user.emailNormalized,
          tokenHash: hashOpaqueToken(raw),
          expiresAt,
          delivery: {
            provider: env.EMAIL_PROVIDER === "resend" ? "RESEND" : "CONSOLE",
            status: "QUEUED",
          },
        });
        await enqueueEmail({
          businessId: claim.businessId,
          userId: user._id,
          entityId: token._id,
          purpose: "VERIFICATION",
          key: `verification-${token.id}`,
          expiresAt,
          payload: verificationPayload({
            recipientName: user.name,
            recipientEmail: user.email,
            verificationUrl,
            expiresAt,
            businessName: business?.businessName,
          }),
        });
        await User.updateOne(
          { _id: user._id },
          { $set: { verificationNotificationPending: false } },
        );
      });
      return {
        status: env.EMAIL_PROVIDER === "console" ? ("DEVELOPMENT" as const) : ("QUEUED" as const),
        requestedAt: now,
        ...(env.NODE_ENV !== "production" && env.EMAIL_PROVIDER === "console"
          ? { developmentVerificationUrl: verificationUrl }
          : {}),
      };
    } catch {
      return { status: "FAILED" as const, requestedAt: now };
    }
  } finally {
    await User.updateOne({ _id: user._id }, { $set: { verificationIssueLeaseUntil: null } });
  }
}

export async function verificationSummaries(userIds: unknown[]) {
  const records = await EmailVerificationToken.find({
    userId: { $in: userIds },
    purpose: "VERIFY_EMAIL",
  })
    .sort({ createdAt: -1 })
    .lean();
  const summaries = new Map<
    string,
    { status: string; requestedAt: Date; retryAt: Date; retryAfterSeconds: number }
  >();
  for (const record of records) {
    const key = String(record.userId);
    if (!summaries.has(key))
      summaries.set(key, {
        status:
          record.delivery.provider === "CONSOLE" && record.delivery.status !== "FAILED"
            ? "DEVELOPMENT"
            : record.delivery.status,
        requestedAt: record.createdAt,
        retryAt: new Date(
          new Date(record.createdAt).getTime() + env.EMAIL_RESEND_COOLDOWN_SECONDS * 1000,
        ),
        retryAfterSeconds: Math.max(
          0,
          Math.ceil(
            (new Date(record.createdAt).getTime() +
              env.EMAIL_RESEND_COOLDOWN_SECONDS * 1000 -
              Date.now()) /
              1000,
          ),
        ),
      });
  }
  return summaries;
}

export function employeeDto(user: any, emailDelivery?: unknown) {
  return {
    _id: String(user._id),
    id: String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    emailVerified: Boolean(user.emailVerifiedAt),
    emailDelivery,
  };
}

export async function repairEmployeeVerification() {
  const pending = await User.find({
    verificationNotificationPending: true,
    emailVerifiedAt: null,
    isActive: true,
    status: "PENDING_EMAIL_VERIFICATION",
  })
    .select("+emailNormalized")
    .limit(10);
  for (const user of pending) {
    try {
      await issueVerificationEmail(user, { enforceRateLimit: false });
    } catch {
      /* A concurrent creation request may hold the issuance lease. */
    }
  }
}
