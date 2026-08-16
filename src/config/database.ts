import mongoose from "mongoose";
import { env } from "./env.js";

export async function connectDatabase() {
  mongoose.set("strictQuery", true);
  await mongoose.connect(env.MONGODB_URI, { dbName: "MissVBusiness" });
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
