import "dotenv/config";
import mongoose from "mongoose";
import { inactiveAccess } from "../src/lib/landing-access.js";
import { LandingPage } from "../src/models/index.js";

if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
await mongoose.connect(process.env.MONGODB_URI);
try {
  for (const mode of ["IMMEDIATE", "INACTIVE"] as const) {
    const live = { isPublished: true, isArchived: { $ne: true }, publishedSnapshot: { $ne: null } };
    const result = await LandingPage.updateMany(
      { publicAccess: { $exists: false }, ...(mode === "IMMEDIATE" ? live : { $nor: [live] }) },
      { $set: { publicAccess: { ...inactiveAccess(), mode } }, $inc: { revision: 1 } },
    );
    console.log(`${mode}: ${result.modifiedCount} pages`);
  }
} finally {
  await mongoose.disconnect();
}
