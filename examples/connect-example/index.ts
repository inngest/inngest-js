import { Inngest } from "inngest";
import { connect } from "inngest/connect";

console.log("Starting up worker with pid", process.pid);

const inngest = new Inngest({
  id: "my-connect-js-app",
  eventKey: "abc123",
  appVersion: "v1.0",
});

console.log("Connecting...");

connect({
  apps: [
    {
      client: inngest,
      functions: [
        inngest.createFunction(
          { id: "test-function" },
          { event: "connect-demo/test" },
          async ({ step }) => {
            await step.run("test", async () => {
              console.log("via connect!");
              await new Promise((resolve) => setTimeout(resolve, 10000));
              console.log("function done");
              return "this works";
            });
          }
        ),
        inngest.createFunction(
          { id: "hello-world" },
          { event: "connect-demo/hello-world" },
          async ({ step }) => {
            return { success: true };
          }
        ),
      ],
    },
  ],
  instanceId: "my-worker",
  rewriteGatewayEndpoint: (endpoint) => {
    return endpoint.replace("connect-gateway:8080", "localhost:8100");
  },
}).then(async (conn) => {
  console.log("Connected!");

  const statusLog = setInterval(() => {
    console.log(conn.state);
  }, 1000);

  await conn.closed;

  console.log("Closed, clearing");
  clearInterval(statusLog);
});
