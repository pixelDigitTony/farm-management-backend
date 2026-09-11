import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { type NextFunction, type Request, type Response, Router } from "express";
import mongoose from "mongoose";
import * as v from "valibot";
import { normalizeEmail, normalizePhilippinePhone } from "../lib/auth-utils.js";
import { addBusinessRole, type BusinessRole, editBusinessRole } from "../lib/business-roles.js";
import { HttpError } from "../lib/http-error.js";
import { allPermissions } from "../lib/permissions.js";
import { getOwner } from "../middleware/auth.js";
import { AuditLog, Business, RegistrationInvite, User } from "../models/index.js";
import { issueVerificationEmail } from "../services/email-verification.service.js";
import { registrationSchema } from "../validation/auth.js";

const roleLevel = v.pipe(
  v.unknown(),
  v.toNumber(),
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(98),
);
const permissionsSchema = v.pipe(
  v.array(
    v.pipe(
      v.string(),
      v.check((permission) => allPermissions.includes(permission), "Unknown permission"),
    ),
  ),
  v.check(
    (permissions) =>
      permissions.every((permission) => permissions.includes(`${permission.split(":")[0]}:view`)),
    "View access is required for module actions",
  ),
);
const roleSchema = v.object({
  level: v.pipe(roleLevel, v.maxValue(97)),
  permissions: v.optional(permissionsSchema, []),
  name: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(60)),
});
const accountSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(2), v.maxLength(100)),
  email: v.pipe(v.string(), v.email()),
  phone: v.pipe(v.string(), v.trim(), v.minLength(10), v.maxLength(30)),
  password: v.pipe(v.string(), v.minLength(8), v.maxLength(100)),
  mpin: registrationSchema.entries.mpin,
  role: roleLevel,
});
const inviteSchema = v.object({
  role: roleLevel,
  expiresAt: v.optional(v.nullable(v.pipe(v.string(), v.isoTimestamp()))),
  isActive: v.optional(v.boolean(), true),
});

export async function requireHighestRole(
  request: Request,
  _response: Response,
  next: NextFunction,
) {
  try {
    const owner = getOwner(request);
    if (owner.role === 99) return next();
    const business = await Business.findById(owner.businessId).select("ownerRole");
    if (!business || owner.role !== Number(business.ownerRole))
      return next(new HttpError(403, "Only the highest business role can manage employees"));
    next();
  } catch (error) {
    next(error);
  }
}

async function normalizedIdentity(email: string, phone: string) {
  const emailNormalized = normalizeEmail(email);
  let phoneNormalized: string;
  try {
    phoneNormalized = normalizePhilippinePhone(phone);
  } catch (error) {
    throw new HttpError(422, error instanceof Error ? error.message : "Invalid phone number");
  }
  if (await User.exists({ $or: [{ emailNormalized }, { phoneNormalized }] }))
    throw new HttpError(409, "That email address or phone number is already registered");
  return { emailNormalized, phoneNormalized };
}

export const employeeRouter = Router();
employeeRouter.use(requireHighestRole);

employeeRouter.get("/", async (request, response) => {
  const owner = getOwner(request);
  const [users, business, invites] = await Promise.all([
    User.find({ businessId: owner.businessId }).sort({ role: -1, name: 1 }).lean(),
    Business.findById(owner.businessId).select("businessName roles ownerRole").lean(),
    RegistrationInvite.find({ businessId: owner.businessId }).sort({ createdAt: -1 }).lean(),
  ]);
  response.json({ users, business, invites });
});

async function changeRole(
  request: Request,
  change: (roles: BusinessRole[], ownerRole: number) => ReturnType<typeof addBusinessRole>,
) {
  const identity = getOwner(request);
  return mongoose.connection.transaction(async (session) => {
    const business = await Business.findById(identity.businessId).session(session);
    if (!business) throw new HttpError(404, "Business was not found");
    if (identity.role !== 99 && identity.role !== Number(business.ownerRole))
      throw new HttpError(409, "The owner role changed. Reload and try again");
    const updated = change(
      business.roles.map((role: BusinessRole) => ({
        level: role.level,
        name: role.name,
        permissions: role.permissions,
      })),
      Number(business.ownerRole),
    );
    business.roles = updated.roles;
    business.ownerRole = updated.ownerRole;
    await business.save({ session });
    if (updated.changes.length) {
      // Resolve all moves against the original level in one update; moves may overlap.
      const filter = {
        businessId: identity.businessId,
        role: { $in: updated.changes.map((change) => change.from) },
      };
      const pipeline = [
        {
          $set: {
            role: {
              $switch: {
                branches: updated.changes.map((change) => ({
                  case: { $eq: ["$role", change.from] },
                  // biome-ignore lint/suspicious/noThenProperty: MongoDB $switch requires this key.
                  then: change.to,
                })),
                default: "$role",
              },
            },
          },
        },
      ];
      await User.updateMany(filter, pipeline, { session, updatePipeline: true });
      await RegistrationInvite.updateMany(filter, pipeline, { session, updatePipeline: true });
    }
    return { roles: updated.roles, ownerRole: updated.ownerRole };
  });
}

employeeRouter.post("/roles", async (request, response) => {
  const input = v.parse(roleSchema, request.body);
  response
    .status(201)
    .json(
      await changeRole(request, (roles, ownerRole) => addBusinessRole(roles, ownerRole, input)),
    );
});

employeeRouter.patch("/roles/:level", async (request, response) => {
  const previousLevel = v.parse(roleLevel, request.params.level);
  const input = v.parse(
    v.object({ name: roleSchema.entries.name, level: v.optional(roleLevel) }),
    request.body,
  );
  response.json(
    await changeRole(request, (roles, ownerRole) =>
      editBusinessRole(roles, ownerRole, previousLevel, input),
    ),
  );
});

employeeRouter.put("/roles/:level/permissions", async (request, response) => {
  const owner = getOwner(request);
  const level = v.parse(roleLevel, request.params.level);
  const { permissions } = v.parse(v.object({ permissions: permissionsSchema }), request.body);
  const business = await Business.findById(owner.businessId).select("roles ownerRole");
  if (!business?.roles.some((role: { level: number }) => role.level === level))
    throw new HttpError(404, "Role was not found");
  if (level === Number(business.ownerRole))
    throw new HttpError(409, "The highest role always has full access");
  const updated = await Business.findOneAndUpdate(
    { _id: owner.businessId, ownerRole: { $ne: level }, "roles.level": level },
    { $set: { "roles.$.permissions": [...new Set(permissions)] } },
    { returnDocument: "after", runValidators: true },
  );
  if (!updated) throw new HttpError(409, "Role changed. Reload and try again");
  response.json({ roles: updated.roles });
});

employeeRouter.delete("/roles/:level", async (request, response) => {
  const owner = getOwner(request);
  const level = v.parse(roleLevel, request.params.level);
  const business = await Business.findById(owner.businessId).select("roles ownerRole");
  if (!business?.roles.some((role: { level: number }) => role.level === level))
    throw new HttpError(404, "Role was not found");
  if (level === Number(business.ownerRole))
    throw new HttpError(409, "The highest business role cannot be deleted");
  const [user, invite] = await Promise.all([
    User.exists({ businessId: owner.businessId, role: level }),
    RegistrationInvite.exists({ businessId: owner.businessId, role: level }),
  ]);
  if (user || invite)
    throw new HttpError(
      409,
      "Reassign accounts and reassign or delete registration links using this role before deleting it",
    );
  await Business.updateOne(
    { _id: owner.businessId, ownerRole: { $ne: level } },
    { $pull: { roles: { level } } },
  );
  response.json({ message: "Role deleted" });
});

employeeRouter.post("/accounts", async (request, response) => {
  const owner = getOwner(request);
  const input = v.parse(accountSchema, request.body);
  const business = await Business.findById(owner.businessId).select("roles ownerRole");
  if (!business?.roles.some((role: { level: number }) => role.level === input.role))
    throw new HttpError(422, "Select an existing business role");
  const normalized = await normalizedIdentity(input.email, input.phone);
  const user = await User.create({
    businessId: owner.businessId,
    name: input.name,
    email: normalized.emailNormalized,
    emailNormalized: normalized.emailNormalized,
    phone: input.phone.trim(),
    phoneNormalized: normalized.phoneNormalized,
    passwordHash: await bcrypt.hash(input.password, 12),
    mpinHash: await bcrypt.hash(input.mpin, 12),
    role: input.role,
    isApproved: true,
    approvedAt: new Date(),
    approvedBy: owner.userId,
    status: "PENDING_EMAIL_VERIFICATION",
  });
  const emailDelivery = await issueVerificationEmail(user, { enforceRateLimit: false });
  response.status(201).json({ user, emailDelivery });
});

employeeRouter.patch("/accounts/:id", async (request, response) => {
  const owner = getOwner(request);
  const role = v.parse(roleLevel, request.body?.role);
  const business = await Business.findById(owner.businessId).select("roles");
  if (!business?.roles.some((item: { level: number }) => item.level === role))
    throw new HttpError(422, "Select an existing business role");
  const user = await User.findOneAndUpdate(
    { _id: request.params.id, businessId: owner.businessId, role: { $ne: 99 } },
    { role },
    { new: true, runValidators: true },
  );
  if (!user) throw new HttpError(404, "Employee was not found");
  response.json(user);
});

employeeRouter.post("/invites", async (request, response) => {
  const owner = getOwner(request);
  const input = v.parse(inviteSchema, request.body);
  const business = await Business.findById(owner.businessId).select("roles");
  if (!business?.roles.some((item: { level: number }) => item.level === input.role))
    throw new HttpError(422, "Select an existing business role");
  const invite = await RegistrationInvite.create({
    businessId: owner.businessId,
    createdBy: owner.userId,
    tokenId: randomBytes(24).toString("base64url"),
    role: input.role,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    isActive: input.isActive,
  });
  response.status(201).json(invite);
});

employeeRouter.patch("/invites/:id", async (request, response) => {
  const owner = getOwner(request);
  const input = v.parse(inviteSchema, request.body);
  const business = await Business.findById(owner.businessId).select("roles");
  if (!business?.roles.some((item: { level: number }) => item.level === input.role))
    throw new HttpError(422, "Select an existing business role");
  const invite = await RegistrationInvite.findOneAndUpdate(
    { _id: request.params.id, businessId: owner.businessId },
    {
      role: input.role,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      isActive: input.isActive,
    },
    { new: true, runValidators: true },
  );
  if (!invite) throw new HttpError(404, "Registration link was not found");
  response.json(invite);
});

employeeRouter.delete("/invites/:id", async (request, response) => {
  const owner = getOwner(request);
  const invite = await RegistrationInvite.findOneAndDelete({
    _id: request.params.id,
    businessId: owner.businessId,
  });
  if (!invite) throw new HttpError(404, "Registration link was not found");
  response.json({ message: "Registration link deleted" });
});

employeeRouter.post("/invites/:id/regenerate", async (request, response) => {
  const owner = getOwner(request);
  const invite = await RegistrationInvite.findOneAndUpdate(
    { _id: request.params.id, businessId: owner.businessId },
    { tokenId: randomBytes(24).toString("base64url") },
    { new: true },
  );
  if (!invite) throw new HttpError(404, "Registration link was not found");
  response.json(invite);
});

export const invitePublicRouter = Router();
invitePublicRouter.get("/:tokenId", async (request, response) => {
  const invite = await RegistrationInvite.findOne({ tokenId: request.params.tokenId }).lean();
  const valid = Boolean(
    invite?.isActive && (!invite.expiresAt || new Date(invite.expiresAt) > new Date()),
  );
  response.json({ valid });
});

invitePublicRouter.post("/:tokenId/register", async (request, response) => {
  const invite = await RegistrationInvite.findOne({
    tokenId: request.params.tokenId,
    isActive: true,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  });
  if (!invite) throw new HttpError(404, "This registration link is invalid or expired");
  const input = v.parse(
    v.omit(registrationSchema, ["businessName", "openingBalance"]),
    request.body,
  );
  const normalized = await normalizedIdentity(input.email, input.phone);
  const user = await User.create({
    businessId: invite.businessId,
    name: input.ownerName,
    email: normalized.emailNormalized,
    emailNormalized: normalized.emailNormalized,
    phone: input.phone.trim(),
    phoneNormalized: normalized.phoneNormalized,
    passwordHash: await bcrypt.hash(input.password, 12),
    mpinHash: await bcrypt.hash(input.mpin, 12),
    role: invite.role,
    isApproved: true,
    approvedAt: new Date(),
    approvedBy: invite.createdBy,
    status: "PENDING_EMAIL_VERIFICATION",
  });
  invite.registrationCount += 1;
  await Promise.all([
    invite.save(),
    AuditLog.create({
      businessId: invite.businessId,
      userId: user._id,
      action: "REGISTER",
      targetCollection: "users",
      targetDocumentId: user._id,
      reason: "REGISTRATION_INVITE",
      ipAddress: request.ip,
      userAgent: request.get("user-agent"),
    }),
  ]);
  const emailDelivery = await issueVerificationEmail(user, { enforceRateLimit: false });
  response
    .status(201)
    .json({ message: "Registration completed. Verify your email to sign in.", emailDelivery });
});
