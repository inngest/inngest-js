import {
  ConnectionState,
  connect,
} from "../../packages/inngest/src/connect.ts";
import { functions, inngest } from "./inngest/index.ts";

async function main() {
  console.log("Connecting scratch app worker...");

  const connection = await connect({
    apps: [{ client: inngest, functions }],
    instanceId: "scratch-connect-worker",
  });

  console.log("Connected scratch app worker");

  const statusLog = setInterval(() => {
    if (connection.state !== ConnectionState.ACTIVE) {
      console.log("Connection state:", connection.state);
    }
  }, 1000);

  await connection.closed;

  clearInterval(statusLog);
  console.log("Scratch app worker closed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
