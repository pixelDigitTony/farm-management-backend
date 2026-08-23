import { env } from "../config/env.js";
import { createOpaqueToken, hashOpaqueToken } from "../lib/auth-utils.js";
import { EmailVerificationToken } from "../models/index.js";
import { emailService } from "./email.service.js";

type RecoveryKind = "PASSWORD" | "MPIN";
type RecoveryUser = {
  _id: unknown;
  name: string;
  email: string;
  emailNormalized: string;
};

export async function issueCredentialRecovery(user: RecoveryUser, kind: RecoveryKind) {
  const now = new Date();
  const purpose = kind === "PASSWORD" ? "RESET_PASSWORD" : "RESET_MPIN";
  await EmailVerificationToken.updateMany(
    { userId: user._id, purpose, usedAt: null, invalidatedAt: null },
    { $set: { invalidatedAt: now } },
  );
  const rawToken = createOpaqueToken();
  const expiresAt = new Date(now.getTime() + env.CREDENTIAL_RESET_TTL_MINUTES * 60_000);
  const resetUrl = `${env.FRONTEND_URL.replace(/\/$/, "")}/reset-credential?kind=${kind.toLowerCase()}&token=${encodeURIComponent(rawToken)}`;
  const tokenRecord = await EmailVerificationToken.create({
    userId: user._id,
    emailNormalized: user.emailNormalized,
    tokenHash: hashOpaqueToken(rawToken),
    purpose,
    expiresAt,
    delivery: { provider: env.EMAIL_PROVIDER === "resend" ? "RESEND" : "CONSOLE" },
  });
  try {
    const delivery = await emailService.sendCredentialResetEmail({
      recipientName: user.name,
      recipientEmail: user.email,
      resetUrl,
      expiresAt,
      credentialLabel: kind === "PASSWORD" ? "password" : "MPIN",
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
  } catch (error) {
    const failure = error instanceof Error ? error : new Error("Email delivery failed");
    tokenRecord.delivery.status = "FAILED";
    tokenRecord.delivery.attemptCount = 1;
    tokenRecord.delivery.lastAttemptAt = now;
    tokenRecord.delivery.lastErrorCode = failure.name;
    tokenRecord.delivery.lastErrorMessage = failure.message;
    await tokenRecord.save();
  }
}
