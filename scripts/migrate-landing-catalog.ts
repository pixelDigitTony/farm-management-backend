import "dotenv/config";
import mongoose from "mongoose";
import { migrateLandingCatalog } from "../src/services/landing-catalog-migration.js";

const apply = process.argv.includes("--apply");
if (!process.env.MONGODB_URI)
  throw new Error("Configure MONGODB_URI before running this migration");
await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
try {
  console.log(JSON.stringify(await migrateLandingCatalog(apply), null, 2));
} finally {
  await mongoose.disconnect();
}
