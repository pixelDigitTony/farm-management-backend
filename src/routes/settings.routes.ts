import bcrypt from "bcryptjs";
import { Router } from "express";
import * as v from "valibot";
import { normalizeEmail, normalizePhilippinePhone } from "../lib/auth-utils.js";
import { HttpError } from "../lib/http-error.js";
import { getOwner } from "../middleware/auth.js";
import { AuthSession, Business, SlaughterSetting, User } from "../models/index.js";
import { issueVerificationEmail } from "../services/email-verification.service.js";
import {
  emailChangeSchema,
  mpinChangeSchema,
  passwordChangeSchema,
  phoneChangeSchema,
} from "../validation/auth.js";

const optionalText = v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200)));
const settingsSchema = v.object({
  ownerName: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(100)),
  businessName: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(120)),
  piggeryName: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(120)),
  piggeryAddress: optionalText,
  karenderiyaName: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(120)),
  karenderiyaAddress: optionalText,
  inventoryValuationMethod: v.picklist(["FIFO", "WEIGHTED_AVERAGE"]),
  generalExpenseAllocation: v.picklist(["GENERAL_ONLY", "EQUAL_PER_ACTIVE_PIG", "MANUAL"]),
  defaultTargetFoodCostPercent: v.pipe(
    v.unknown(),
    v.toNumber(),
    v.number(),
    v.gtValue(0),
    v.maxValue(100),
  ),
  meatTransferPricingMethod: v.picklist(["PRODUCTION_COST", "OWNER_SET_PRICE"]),
});

const slaughterSettingsSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(120)),
  costItems: v.array(
    v.object({
      code: v.string(),
      name: v.pipe(v.string(), v.trim(), v.minLength(1)),
      calculationMethod: v.picklist(["FLAT", "PER_LIVE_KG", "PER_CARCASS_KG", "MANUAL"]),
      defaultRate: v.pipe(v.unknown(), v.toNumber(), v.number(), v.minValue(0)),
      isActive: v.optional(v.boolean(), true),
    }),
  ),
  meatParts: v.array(
    v.object({
      code: v.string(),
      name: v.pipe(v.string(), v.trim(), v.minLength(1)),
      classification: v.picklist(["MEAT", "BYPRODUCT", "WASTE"]),
      defaultExternalPricePerKg: v.pipe(v.unknown(), v.toNumber(), v.number(), v.minValue(0)),
      defaultKarenderiyaPricePerKg: v.pipe(v.unknown(), v.toNumber(), v.number(), v.minValue(0)),
      isUsableForCooking: v.optional(v.boolean(), true),
      isActive: v.optional(v.boolean(), true),
    }),
  ),
});

export const settingsRouter = Router();

settingsRouter.get("/", async (request, response) => {
  const owner = getOwner(request);
  const [business, user, slaughter] = await Promise.all([
    Business.findById(owner.businessId).lean(),
    User.findById(owner.userId).select("+pendingEmail").lean(),
    SlaughterSetting.findOne({ businessId: owner.businessId, isDefault: true }).lean(),
  ]);
  response.json({ business, user, slaughter });
});

settingsRouter.patch("/business", async (request, response) => {
  const owner = getOwner(request);
  const input = v.parse(settingsSchema, request.body);
  const [business, user] = await Promise.all([
    Business.findByIdAndUpdate(
      owner.businessId,
      {
        businessName: input.businessName,
        "piggery.name": input.piggeryName,
        "piggery.address": input.piggeryAddress,
        "karenderiya.name": input.karenderiyaName,
        "karenderiya.address": input.karenderiyaAddress,
        "settings.inventoryValuationMethod": input.inventoryValuationMethod,
        "settings.generalExpenseAllocation": input.generalExpenseAllocation,
        "settings.defaultTargetFoodCostPercent": input.defaultTargetFoodCostPercent,
        "settings.meatTransferPricingMethod": input.meatTransferPricingMethod,
      },
      { new: true, runValidators: true },
    ),
    User.findByIdAndUpdate(owner.userId, { name: input.ownerName }, { new: true }),
  ]);
  response.json({ business, user });
});

async function requireCurrentPassword(userId: unknown, password: string) {
  const user = await User.findById(userId).select(
    "+passwordHash +emailNormalized +phoneNormalized +pendingEmail +pendingEmailNormalized",
  );
  if (!user || !(await bcrypt.compare(password, user.passwordHash)))
    throw new HttpError(401, "Current password is incorrect", undefined, "INVALID_CREDENTIAL");
  return user;
}

async function revokeOwnerSessions(userId: unknown, reason: "PASSWORD_CHANGED" | "MPIN_CHANGED") {
  await AuthSession.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokeReason: reason } },
  );
}

settingsRouter.patch("/account/password", async (request, response) => {
  const owner = getOwner(request);
  const input = v.parse(passwordChangeSchema, request.body);
  const user = await requireCurrentPassword(owner.userId, input.currentPassword);
  if (await bcrypt.compare(input.newPassword, user.passwordHash))
    throw new HttpError(422, "New password must be different from the current password");
  user.passwordHash = await bcrypt.hash(input.newPassword, 12);
  user.passwordSecurity.failedAttempts = 0;
  user.passwordSecurity.lockedUntil = null;
  user.passwordSecurity.passwordChangedAt = new Date();
  await user.save();
  await revokeOwnerSessions(user._id, "PASSWORD_CHANGED");
  response.json({ message: "Password changed. Sign in again with your new password." });
});

settingsRouter.patch("/account/mpin", async (request, response) => {
  const owner = getOwner(request);
  const input = v.parse(mpinChangeSchema, request.body);
  const user = await User.findById(owner.userId).select("+mpinHash");
  if (!user || !(await bcrypt.compare(input.currentMpin, user.mpinHash)))
    throw new HttpError(401, "Current MPIN is incorrect", undefined, "INVALID_CREDENTIAL");
  if (await bcrypt.compare(input.newMpin, user.mpinHash))
    throw new HttpError(422, "New MPIN must be different from the current MPIN");
  user.mpinHash = await bcrypt.hash(input.newMpin, 12);
  user.mpinSecurity.failedAttempts = 0;
  user.mpinSecurity.lockedUntil = null;
  user.mpinSecurity.mpinChangedAt = new Date();
  await user.save();
  await revokeOwnerSessions(user._id, "MPIN_CHANGED");
  response.json({ message: "MPIN changed. Sign in again with your new MPIN." });
});

settingsRouter.patch("/account/email", async (request, response) => {
  const owner = getOwner(request);
  const input = v.parse(emailChangeSchema, request.body);
  const user = await requireCurrentPassword(owner.userId, input.currentPassword);
  const emailNormalized = normalizeEmail(input.newEmail);
  if (emailNormalized === user.emailNormalized)
    throw new HttpError(422, "Enter a different email address");
  if (
    await User.exists({
      _id: { $ne: user._id },
      $or: [{ emailNormalized }, { pendingEmailNormalized: emailNormalized }],
    })
  )
    throw new HttpError(409, "That email address is already in use");
  user.pendingEmail = input.newEmail.trim();
  user.pendingEmailNormalized = emailNormalized;
  await user.save();
  const delivery = await issueVerificationEmail({
    _id: user._id,
    id: user.id,
    name: user.name,
    email: user.pendingEmail,
    emailNormalized,
  });
  response.json({
    message:
      delivery.status === "FAILED"
        ? "Email change saved, but the verification email could not be sent. Your current email remains active."
        : "Verification sent to the new email. Your current email remains active until verification.",
    pendingEmail: user.pendingEmail,
  });
});

settingsRouter.patch("/account/phone", async (request, response) => {
  const owner = getOwner(request);
  const input = v.parse(phoneChangeSchema, request.body);
  const user = await requireCurrentPassword(owner.userId, input.currentPassword);
  let phoneNormalized: string;
  try {
    phoneNormalized = normalizePhilippinePhone(input.newPhone);
  } catch (error) {
    throw new HttpError(422, error instanceof Error ? error.message : "Invalid phone number");
  }
  if (phoneNormalized === user.phoneNormalized)
    throw new HttpError(422, "Enter a different phone number");
  if (await User.exists({ _id: { $ne: user._id }, phoneNormalized }))
    throw new HttpError(409, "That phone number is already in use");
  user.phone = input.newPhone.trim();
  user.phoneNormalized = phoneNormalized;
  await user.save();
  response.json({ message: "Phone number changed successfully.", phone: user.phone });
});

settingsRouter.put("/slaughter", async (request, response) => {
  const owner = getOwner(request);
  const input = v.parse(slaughterSettingsSchema, request.body);
  const setting = await SlaughterSetting.findOneAndUpdate(
    { businessId: owner.businessId, isDefault: true },
    { ...input, businessId: owner.businessId, isDefault: true },
    { new: true, upsert: true, runValidators: true },
  );
  response.json(setting);
});
