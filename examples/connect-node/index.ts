import { createServer } from "http";
import { connect, ConnectionState } from "inngest/connect";
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
    signingKey: "fake-key",
  });

  const server = createServer((req, res) => {
    console.log("Got health check");
    if (
      !connection ||
      !connection.state ||
      connection.state !== ConnectionState.ACTIVE
    ) {
      res.writeHead(500);
      return;
    }
  });

  server.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
  });

  await connection.closed;
}

main();
