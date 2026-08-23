import { env } from "../config/env.js";
import { createOpaqueToken, hashOpaqueToken } from "../lib/auth-utils.js";
import { HttpError } from "../lib/http-error.js";
import { EmailVerificationToken } from "../models/index.js";
import { emailService } from "./email.service.js";

type VerificationUser = {
  _id: unknown;
  id: string;
  name: string;
  email: string;
  emailNormalized: string;
};

export async function issueVerificationEmail(
  user: VerificationUser,
  options: { enforceRateLimit?: boolean } = {},
) {
  const now = new Date();
  if (options.enforceRateLimit !== false) {
    const latest = await EmailVerificationToken.findOne({
      userId: user._id,
      purpose: "VERIFY_EMAIL",
    })
      .sort({ createdAt: -1 })
      .lean();
    if (
      latest?.createdAt &&
      now.getTime() - new Date(latest.createdAt).getTime() <
        env.EMAIL_RESEND_COOLDOWN_SECONDS * 1000
    ) {
      throw new HttpError(
        429,
        "Please wait before requesting another verification email",
        undefined,
        "EMAIL_RESEND_COOLDOWN",
      );
    }
    const sentLastHour = await EmailVerificationToken.countDocuments({
      userId: user._id,
      purpose: "VERIFY_EMAIL",
      createdAt: { $gte: new Date(now.getTime() - 3_600_000) },
    });
    if (sentLastHour >= env.EMAIL_MAX_RESENDS_PER_HOUR) {
      throw new HttpError(
        429,
        "Too many verification emails requested. Try again later",
        undefined,
        "EMAIL_RESEND_LIMIT",
      );
    }
  }

  await EmailVerificationToken.updateMany(
    { userId: user._id, purpose: "VERIFY_EMAIL", usedAt: null, invalidatedAt: null },
    { $set: { invalidatedAt: now } },
  );
  const rawToken = createOpaqueToken();
  const expiresAt = new Date(now.getTime() + env.EMAIL_VERIFICATION_TTL_MINUTES * 60_000);
  const verificationUrl = `${env.FRONTEND_URL.replace(/\/$/, "")}/verify-email?token=${encodeURIComponent(rawToken)}`;
  const tokenRecord = await EmailVerificationToken.create({
    userId: user._id,
    emailNormalized: user.emailNormalized,
    tokenHash: hashOpaqueToken(rawToken),
    expiresAt,
    delivery: { provider: env.EMAIL_PROVIDER === "resend" ? "RESEND" : "CONSOLE" },
  });

  try {
    const delivery = await emailService.sendVerificationEmail({
      recipientName: user.name,
      recipientEmail: user.email,
      verificationUrl,
      expiresAt,
    });
    tokenRecord.delivery = {
      ...tokenRecord.delivery,
      ...delivery,
      attemptCount: 1,
      lastAttemptAt: now,
      lastErrorCode: null,
      lastErrorMessage: null,
    };
    await tokenRecord.save();
    return {
      status: delivery.status,
      ...(env.NODE_ENV !== "production" && env.EMAIL_PROVIDER === "console"
        ? { developmentVerificationUrl: verificationUrl }
        : {}),
    };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error("Email delivery failed");
    tokenRecord.delivery.status = "FAILED";
    tokenRecord.delivery.attemptCount = 1;
    tokenRecord.delivery.lastAttemptAt = now;
    tokenRecord.delivery.lastErrorCode = failure.name;
    tokenRecord.delivery.lastErrorMessage = failure.message;
    await tokenRecord.save();
    return { status: "FAILED" as const };
  }
}
