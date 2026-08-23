import { Router } from "express";
import mongoose from "mongoose";
import { HttpError } from "../lib/http-error.js";
import { getOwner } from "../middleware/auth.js";
import { AuthSession, Business, EmailVerificationToken, User } from "../models/index.js";

export const adminRouter = Router();

type LeanOwner = {
  _id: unknown;
  name: string;
  email: string;
  phone: string;
  role: number;
  status: string;
  isActive: boolean;
  isApproved: boolean;
  emailVerifiedAt?: Date | null;
  createdAt?: Date;
  lastLoginAt?: Date | null;
};

type LeanBusiness = {
  _id: unknown;
  ownerUserId?: unknown;
  businessName: string;
  isArchived?: boolean;
  archivedAt?: Date | null;
  createdAt?: Date;
};

export function accountState(owner: LeanOwner | undefined, business: LeanBusiness) {
  if (Number(owner?.role) === 99) return "SUPER_ADMIN";
  if (business.isArchived) return "ARCHIVED";
  if (!owner?.isActive || owner.status === "DISABLED") return "DISABLED";
  if (!owner.emailVerifiedAt) return "PENDING_EMAIL";
  if (!owner.isApproved || owner.status === "PENDING_ADMIN_APPROVAL") return "PENDING_APPROVAL";
  if (owner.status === "LOCKED") return "LOCKED";
  return "ACTIVE";
}

async function ownerAccounts() {
  const businesses = (await Business.find()
    .sort({ createdAt: -1 })
    .select("businessName ownerUserId isArchived archivedAt createdAt")
    .lean()) as unknown as LeanBusiness[];
  const ownerIds = businesses.map((business) => business.ownerUserId).filter(Boolean);
  const owners = (await User.find({ _id: { $in: ownerIds } })
    .select(
      "name email phone role status isActive isApproved emailVerifiedAt createdAt lastLoginAt",
    )
    .lean()) as unknown as LeanOwner[];
  const ownersById = new Map(owners.map((owner) => [String(owner._id), owner]));

  return businesses.map((business) => {
    const owner = ownersById.get(String(business.ownerUserId));
    return {
      businessId: String(business._id),
      ownerId: owner ? String(owner._id) : null,
      businessName: business.businessName,
      name: owner?.name ?? "Owner unavailable",
      email: owner?.email ?? "",
      phone: owner?.phone ?? "",
      role: Number(owner?.role ?? 0),
      status: accountState(owner, business),
      accountStatus: owner?.status ?? "DISABLED",
      isApproved: owner?.isApproved === true,
      emailVerified: Boolean(owner?.emailVerifiedAt),
      isArchived: business.isArchived === true,
      archivedAt: business.archivedAt ?? null,
      createdAt: owner?.createdAt ?? business.createdAt,
      lastLoginAt: owner?.lastLoginAt ?? null,
    };
  });
}

adminRouter.get("/approvals", async (_request, response) => {
  const accounts = await ownerAccounts();
  response.json({
    items: accounts.filter(
      (account) =>
        !account.isApproved &&
        (account.status === "PENDING_APPROVAL" || account.status === "PENDING_EMAIL"),
    ),
  });
});

adminRouter.get("/accounts", async (_request, response) => {
  response.json({ items: await ownerAccounts() });
});

adminRouter.patch("/approvals/:id", async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id))
    return response.status(400).json({ message: "Invalid user id" });
  const admin = getOwner(request);
  const approve = request.body?.approved === true;
  const user = await User.findOne({ _id: request.params.id, role: { $ne: 99 } });
  if (!user) return response.status(404).json({ message: "Account was not found" });
  const business = await Business.findOne({
    _id: user.businessId,
    ownerUserId: user._id,
    isArchived: { $ne: true },
  });
  if (!business) throw new HttpError(409, "The owner business is unavailable or archived");
  if (approve) {
    user.isApproved = true;
    user.approvedAt = new Date();
    user.approvedBy = admin.userId;
    user.status = user.emailVerifiedAt ? "ACTIVE" : "PENDING_EMAIL_VERIFICATION";
  } else {
    user.isApproved = false;
    user.isActive = false;
    user.status = "DISABLED";
  }
  await user.save();
  response.json({ message: approve ? "Account approved" : "Account rejected", user });
});

adminRouter.patch("/accounts/:businessId/archive", async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.businessId))
    throw new HttpError(400, "Invalid business id");
  const admin = getOwner(request);
  const archived = request.body?.archived === true;
  const business = await Business.findById(request.params.businessId);
  if (!business) throw new HttpError(404, "Business account was not found");
  const owner = business.ownerUserId ? await User.findById(business.ownerUserId) : null;
  if (Number(owner?.role) === 99 || String(owner?._id) === String(admin.userId))
    throw new HttpError(403, "The super-admin account cannot be archived");

  business.isArchived = archived;
  business.archivedAt = archived ? new Date() : null;
  business.archivedBy = archived ? admin.userId : undefined;
  await business.save();
  if (archived) {
    await AuthSession.updateMany(
      { businessId: business._id, revokedAt: null },
      { $set: { revokedAt: new Date(), revokeReason: "SECURITY" } },
    );
  }
  response.json({ message: archived ? "Business account archived" : "Business account restored" });
});

adminRouter.delete("/accounts/:businessId", async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.businessId))
    throw new HttpError(400, "Invalid business id");
  const admin = getOwner(request);
  const business = await Business.findById(request.params.businessId).select(
    "businessName ownerUserId",
  );
  if (!business) throw new HttpError(404, "Business account was not found");
  const owner = business.ownerUserId ? await User.findById(business.ownerUserId) : null;
  if (Number(owner?.role) === 99 || String(owner?._id) === String(admin.userId))
    throw new HttpError(403, "The super-admin account cannot be deleted");
  if (request.body?.confirmation !== business.businessName)
    throw new HttpError(422, "Type the exact company name to confirm permanent deletion");

  await mongoose.connection.transaction(async (session) => {
    const users = await User.find({ businessId: business._id })
      .select("_id")
      .session(session)
      .lean();
    await EmailVerificationToken.deleteMany(
      { userId: { $in: users.map((user) => user._id) } },
      { session },
    );
    const businessModels = getBusinessScopedModels();
    for (const model of businessModels) {
      await model.deleteMany({ businessId: business._id }, { session });
    }
    await Business.deleteOne({ _id: business._id }, { session });
  });

  response.status(204).send();
});

export function getBusinessScopedModels() {
  return Object.values(mongoose.models).filter(
    (model) => model.modelName !== Business.modelName && model.schema.path("businessId"),
  );
}
