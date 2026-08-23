import mongoose from "mongoose";
import { env } from "./env.js";

export async function connectDatabase() {
  mongoose.set("strictQuery", true);
  await mongoose.connect(env.MONGODB_URI, { dbName: "MissVBusiness", autoIndex: false });
  await migrateNumericRoles();
  await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
}

async function migrateNumericRoles() {
  const database = mongoose.connection.db;
  if (!database) return;
  const users = database.collection("users");
  const businesses = database.collection("businesses");
  await users.updateMany(
    { role: "OWNER" },
    {
      $set: {
        role: 0,
        isApproved: true,
        approvedAt: new Date(),
      },
    },
  );
  await users.updateMany(
    { isApproved: { $exists: false } },
    { $set: { isApproved: true, approvedAt: new Date() } },
  );
  const legacyRoleIndex = (await users.indexes()).find((index) => index.name === "role_1");
  if (legacyRoleIndex) await users.dropIndex("role_1");
  for await (const business of businesses.find({
    $or: [
      { businessNameNormalized: { $exists: false } },
      { roles: { $exists: false } },
      { ownerRole: { $exists: false } },
    ],
  })) {
    await businesses.updateOne(
      { _id: business._id },
      {
        $set: {
          businessNameNormalized: String(business.businessName ?? "Business")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, " "),
          roles: business.roles ?? [{ level: 0, name: "Owner" }],
          ownerRole: business.ownerRole ?? 0,
        },
      },
    );
  }
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
