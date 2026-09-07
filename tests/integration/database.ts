import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { GenericContainer, Wait } from "testcontainers";

export async function startTestDatabase() {
  if (process.env.NODE_ENV !== "test")
    throw new Error("Disposable databases require NODE_ENV=test");
  const container = await new GenericContainer(process.env.TEST_MONGO_IMAGE ?? "mongo:8.0.16")
    .withCommand(["mongod", "--replSet", "rs0", "--bind_ip_all"])
    .withExposedPorts(27017)
    .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/))
    .start();
  try {
    const initialized = await container.exec([
      "mongosh",
      "--quiet",
      "--eval",
      'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})',
    ]);
    if (initialized.exitCode !== 0) throw new Error("Test replica set initialization failed");
    const ready = await container.exec([
      "mongosh",
      "--quiet",
      "--eval",
      "let n=0; while (!db.hello().isWritablePrimary && n++ < 60) sleep(500); if (!db.hello().isWritablePrimary) quit(1);",
    ]);
    if (ready.exitCode !== 0) throw new Error("Test replica set never became writable");
    const dbName = `farm_test_${randomUUID().replaceAll("-", "")}`;
    // Never consume MONGODB_URI or any application .env value here.
    await mongoose.connect(
      `mongodb://${container.getHost()}:${container.getMappedPort(27017)}/${dbName}?directConnection=true&replicaSet=rs0`,
      { autoIndex: false },
    );
    const hello = await mongoose.connection.db?.admin().command({ hello: 1 });
    if (hello?.setName !== "rs0") throw new Error("Transactions require the test replica set");
    for (const model of Object.values(mongoose.models)) await model.createIndexes();
    return async () => {
      await mongoose.disconnect();
      await container.stop();
    };
  } catch (error) {
    await mongoose.disconnect();
    await container.stop();
    throw error;
  }
}
