import { Router } from "express";
import mongoose from "mongoose";
import { getOwner } from "../middleware/auth.js";
import { Business, User } from "../models/index.js";

export const adminRouter = Router();

adminRouter.get("/approvals", async (_request, response) => {
  const users = await User.find({ isApproved: false, isActive: true })
    .sort({ createdAt: 1 })
    .select("name email phone role status emailVerifiedAt businessId createdAt")
    .lean();
  const businesses = await Business.find({ _id: { $in: users.map((user) => user.businessId) } })
    .select("businessName")
    .lean();
  const names = new Map(
    businesses.map((business) => [String(business._id), business.businessName]),
  );
  response.json({
    items: users.map((user) => ({
      ...user,
      businessName: names.get(String(user.businessId)) ?? "Business",
    })),
  });
});

adminRouter.patch("/approvals/:id", async (request, response) => {
  if (!mongoose.isValidObjectId(request.params.id))
    return response.status(400).json({ message: "Invalid user id" });
  const admin = getOwner(request);
  const approve = request.body?.approved === true;
  const user = await User.findOne({ _id: request.params.id, role: { $ne: 99 } });
  if (!user) return response.status(404).json({ message: "Account was not found" });
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
