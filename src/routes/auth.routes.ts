import bcrypt from "bcryptjs";
import { type Request, type Response, Router } from "express";
import { parse } from "valibot";
import { hashOpaqueToken, normalizeEmail, normalizePhilippinePhone } from "../lib/auth-utils.js";
import { HttpError } from "../lib/http-error.js";
import { getOwner, requireOwner } from "../middleware/auth.js";
import {
  loginLimiter,
  registrationLimiter,
  verificationLimiter,
} from "../middleware/rate-limit.js";
import {
  AuditLog,
  Business,
  CashAccount,
  EmailVerificationToken,
  SlaughterSetting,
  User,
} from "../models/index.js";
import {
  createSession,
  publicOwner,
  revokeSession,
  rotateSession,
} from "../services/auth-session.service.js";
import { issueVerificationEmail } from "../services/email-verification.service.js";
import {
  loginSchema,
  registrationSchema,
  resendVerificationSchema,
  verifyEmailSchema,
} from "../validation/auth.js";

export const authRouter = Router();
const dummyHash = bcrypt.hashSync("not-a-real-credential", 12);
const maxFailedAttempts = 5;
const lockDurationMs = 15 * 60_000;

authRouter.get("/setup-status", async (_request, response) => {
  const initialized = (await User.estimatedDocumentCount()) > 0;
  response.json({ initialized, registrationAvailable: !initialized });
});

async function register(request: Request, response: Response) {
  if ((await User.estimatedDocumentCount()) > 0) {
    throw new HttpError(
      409,
      "Owner registration is already complete",
      undefined,
      "REGISTRATION_CLOSED",
    );
  }
  const input = parse(registrationSchema, request.body);
  const emailNormalized = normalizeEmail(input.email);
  let phoneNormalized: string;
  try {
    phoneNormalized = normalizePhilippinePhone(input.phone);
  } catch (error) {
    throw new HttpError(422, error instanceof Error ? error.message : "Invalid phone number");
  }

  const business = await Business.create({ businessName: input.businessName });
  let owner: InstanceType<typeof User>;
  try {
    owner = await User.create({
      businessId: business._id,
      name: input.ownerName,
      email: emailNormalized,
      emailNormalized,
      phone: input.phone.trim(),
      phoneNormalized,
      passwordHash: await bcrypt.hash(input.password, 12),
      mpinHash: await bcrypt.hash(input.mpin, 12),
      status: "PENDING_EMAIL_VERIFICATION",
    });
    business.ownerUserId = owner._id;
    await business.save();
    await Promise.all([
      CashAccount.create({
        businessId: business._id,
        accountCode: "CASH",
        name: "Cash on hand",
        accountType: "CASH",
        openingBalance: input.openingBalance,
        currentBalanceCached: input.openingBalance,
      }),
      createDefaultSlaughterSetting(business._id),
      AuditLog.create({
        businessId: business._id,
        userId: owner._id,
        action: "REGISTER",
        targetCollection: "users",
        targetDocumentId: owner._id,
        ipAddress: request.ip,
        userAgent: request.get("user-agent"),
      }),
    ]);
  } catch (error) {
    await Promise.all([
      AuditLog.deleteMany({ businessId: business._id }),
      CashAccount.deleteMany({ businessId: business._id }),
      SlaughterSetting.deleteMany({ businessId: business._id }),
      User.deleteMany({ businessId: business._id }),
      Business.deleteOne({ _id: business._id }),
    ]);
    throw error;
  }

  const emailDelivery = await issueVerificationEmail(owner, { enforceRateLimit: false });
  response.status(201).json({
    message:
      emailDelivery.status === "FAILED"
        ? "Registration completed, but the verification email could not be sent. Please resend it."
        : "Registration completed. Check your email to activate the owner account.",
    email: owner.email,
    emailDelivery,
  });
}

authRouter.post("/register", registrationLimiter, register);
authRouter.post("/setup", registrationLimiter, register);

authRouter.post("/verify-email", verificationLimiter, async (request, response) => {
  const { token } = parse(verifyEmailSchema, request.body);
  const now = new Date();
  const tokenRecord = await EmailVerificationToken.findOneAndUpdate(
    {
      tokenHash: hashOpaqueToken(token),
      purpose: "VERIFY_EMAIL",
      usedAt: null,
      invalidatedAt: null,
      expiresAt: { $gt: now },
    },
    { $set: { usedAt: now } },
    { new: true },
  );
  if (!tokenRecord) {
    throw new HttpError(
      400,
      "This verification link is invalid or expired",
      undefined,
      "INVALID_VERIFICATION_TOKEN",
    );
  }
  const owner = await User.findById(tokenRecord.userId).select("+emailNormalized");
  if (!owner || owner.emailNormalized !== tokenRecord.emailNormalized) {
    throw new HttpError(
      400,
      "This verification link is invalid or expired",
      undefined,
      "INVALID_VERIFICATION_TOKEN",
    );
  }
  owner.emailVerifiedAt = now;
  owner.status = "ACTIVE";
  await owner.save();
  await Promise.all([
    EmailVerificationToken.updateMany(
      { userId: owner._id, usedAt: null, invalidatedAt: null },
      { $set: { invalidatedAt: now } },
    ),
    AuditLog.create({
      businessId: owner.businessId,
      userId: owner._id,
      action: "VERIFY_EMAIL",
      targetCollection: "users",
      targetDocumentId: owner._id,
      ipAddress: request.ip,
      userAgent: request.get("user-agent"),
    }),
  ]);
  response.json({ message: "Email verified. You can now sign in." });
});

authRouter.post("/resend-verification", verificationLimiter, async (request, response) => {
  const { email } = parse(resendVerificationSchema, request.body);
  const owner = await User.findOne({
    emailNormalized: normalizeEmail(email),
    isActive: true,
  }).select("+emailNormalized");
  const genericMessage = "If the account is awaiting verification, a new email has been requested.";
  if (!owner || owner.emailVerifiedAt) return response.json({ message: genericMessage });
  await issueVerificationEmail(owner);
  response.json({ message: genericMessage });
});

authRouter.post("/login", loginLimiter, async (request, response) => {
  const input = parse(loginSchema, request.body);
  const method = input.method;
  let normalizedIdentifier: string;
  try {
    normalizedIdentifier =
      method === "EMAIL_PASSWORD"
        ? normalizeEmail(input.email)
        : normalizePhilippinePhone(input.phone);
  } catch {
    normalizedIdentifier = "invalid";
  }
  const owner = await User.findOne({
    ...(method === "EMAIL_PASSWORD"
      ? { emailNormalized: normalizedIdentifier }
      : { phoneNormalized: normalizedIdentifier }),
    isActive: true,
  }).select("+passwordHash +mpinHash +emailNormalized +phoneNormalized");
  const securityKey = method === "EMAIL_PASSWORD" ? "passwordSecurity" : "mpinSecurity";
  const security = owner?.[securityKey];
  if (security?.lockedUntil && new Date(security.lockedUntil) > new Date()) {
    throw new HttpError(
      429,
      "Too many failed attempts. Try again later",
      undefined,
      "LOGIN_TEMPORARILY_LOCKED",
    );
  }
  const suppliedCredential = method === "EMAIL_PASSWORD" ? input.password : input.mpin;
  const savedHash =
    method === "EMAIL_PASSWORD" ? owner?.passwordHash || dummyHash : owner?.mpinHash || dummyHash;
  const valid = await bcrypt.compare(suppliedCredential, savedHash);
  if (!owner || !valid) {
    if (owner) await recordFailedAttempt(owner, securityKey);
    throw new HttpError(401, "Incorrect credentials", undefined, "INVALID_CREDENTIALS");
  }
  if (!owner.emailVerifiedAt) {
    throw new HttpError(
      403,
      "Verify your email before signing in",
      undefined,
      "EMAIL_NOT_VERIFIED",
    );
  }
  if (owner.status !== "ACTIVE") {
    throw new HttpError(403, "This account is unavailable", undefined, "ACCOUNT_UNAVAILABLE");
  }
  owner.set(`${securityKey}.failedAttempts`, 0);
  owner.set(`${securityKey}.lockedUntil`, null);
  owner.lastLoginAt = new Date();
  owner.lastLoginMethod = method;
  await owner.save();
  const token = await createSession(owner, method, request, response);
  await AuditLog.create({
    businessId: owner.businessId,
    userId: owner._id,
    action: "LOGIN",
    targetCollection: "users",
    targetDocumentId: owner._id,
    ipAddress: request.ip,
    userAgent: request.get("user-agent"),
  });
  response.json({ token, owner: publicOwner(owner) });
});

authRouter.post("/refresh", async (request, response) => {
  response.json(await rotateSession(request, response));
});

authRouter.post("/logout", async (request, response) => {
  const session = await revokeSession(request, response);
  if (session) {
    await AuditLog.create({
      businessId: session.businessId,
      userId: session.userId,
      action: "LOGOUT",
      targetCollection: "auth_sessions",
      targetDocumentId: session._id,
      ipAddress: request.ip,
      userAgent: request.get("user-agent"),
    });
  }
  response.status(204).send();
});

authRouter.get("/me", requireOwner, async (request, response) => {
  const ownerIdentity = getOwner(request);
  const owner = await User.findOne({
    _id: ownerIdentity.userId,
    businessId: ownerIdentity.businessId,
    isActive: true,
    status: "ACTIVE",
  });
  if (!owner) throw new HttpError(401, "Authentication required");
  response.json({ owner: publicOwner(owner) });
});

async function recordFailedAttempt(
  owner: InstanceType<typeof User>,
  securityKey: "passwordSecurity" | "mpinSecurity",
) {
  const attempts = Number(owner.get(`${securityKey}.failedAttempts`) ?? 0) + 1;
  owner.set(`${securityKey}.failedAttempts`, attempts >= maxFailedAttempts ? 0 : attempts);
  if (attempts >= maxFailedAttempts) {
    owner.set(`${securityKey}.lockedUntil`, new Date(Date.now() + lockDurationMs));
  }
  await owner.save();
}

function createDefaultSlaughterSetting(businessId: unknown) {
  return SlaughterSetting.create({
    businessId,
    name: "Default slaughter setup",
    isDefault: true,
    costItems: [
      { code: "SLAUGHTER", name: "Slaughter fee", calculationMethod: "FLAT", defaultRate: 0 },
      { code: "BUTCHER", name: "Butcher / cutting", calculationMethod: "FLAT", defaultRate: 0 },
      { code: "TRANSPORT", name: "Transport", calculationMethod: "MANUAL", defaultRate: 0 },
    ],
    meatParts: [
      "Belly / Liempo",
      "Shoulder / Kasim",
      "Ham / Pigue",
      "Loin / Lomo",
      "Ribs",
      "Head",
      "Legs / Pata",
      "Offal",
      "Fat",
      "Bones",
      "Blood",
    ].map((name, index) => ({
      code: `PART-${index + 1}`,
      name,
      classification: name === "Bones" ? "BYPRODUCT" : "MEAT",
      isUsableForCooking: true,
      isActive: true,
    })),
  });
}
