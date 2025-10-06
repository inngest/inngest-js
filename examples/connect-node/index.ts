import { connect } from "inngest/connect";
import { functions, inngest } from "./inngest";

async function main() {
  const connection = await connect({
    apps: [
      {
        client: inngest,
        functions: functions,
      },
    ],
    instanceId: "connect-node",
  });

  await connection.closed;
}

main();
