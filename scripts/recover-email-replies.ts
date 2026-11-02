import { parseArgs } from "node:util";
import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import {
  recoverEmailReplies,
  validateRecoveryOptions,
} from "../src/services/email-recovery.service.js";

const { values } = parseArgs({
  options: {
    environment: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    "batch-size": { type: "string", default: "50" },
    "max-items": { type: "string", default: "500" },
    "business-id": { type: "string" },
    "order-id": { type: "string" },
    "run-id": { type: "string" },
    apply: { type: "boolean", default: false },
    requeue: { type: "boolean", default: false },
    reason: { type: "string" },
  },
});
const options = {
  environment: values.environment ?? "",
  from: values.from ?? "",
  to: values.to ?? "",
  batchSize: Number(values["batch-size"]),
  maxItems: Number(values["max-items"]),
  businessId: values["business-id"],
  orderId: values["order-id"],
  runId: values["run-id"],
  apply: values.apply,
  requeue: values.requeue,
  reason: values.reason,
};
try {
  validateRecoveryOptions(options);
  // Do not call application startup migrations or index creation in a dry run.
  await mongoose.connect(env.MONGODB_URI, {
    dbName: env.NODE_ENV === "test" ? undefined : "MissVBusiness",
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: 10000,
  });
  console.log(JSON.stringify(await recoverEmailReplies(options)));
} catch {
  console.error(
    "Email recovery failed. Check environment, date range, scope, provider/database access and run options. No raw provider or database error is printed.",
  );
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
