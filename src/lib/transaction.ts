import { AsyncLocalStorage } from "node:async_hooks";
import mongoose from "mongoose";

// Nested use cases join the same transaction; they must never independently commit.
const activeTransaction = new AsyncLocalStorage<boolean>();
mongoose.set("transactionAsyncLocalStorage", true);

export async function inTransaction<T>(work: () => Promise<T>): Promise<T> {
  if (activeTransaction.getStore()) return work();
  return mongoose.connection.transaction(() => activeTransaction.run(true, work), {
    readPreference: "primary",
    readConcern: { level: "snapshot" },
    writeConcern: { w: "majority" },
  });
}
