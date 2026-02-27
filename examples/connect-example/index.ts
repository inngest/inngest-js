import { Inngest } from "inngest";
import { connect } from "inngest/connect";

console.log("Starting up worker with pid", process.pid);

const app1 = new Inngest({
  id: "my-connect-js-app-1",
  eventKey: "abc123",
  appVersion: "v1.0",
});

const app2 = new Inngest({
  id: "my-connect-js-app-2",
  eventKey: "abc123",
  appVersion: "v1.0",
});

console.log("Connecting...");

connect({
  apps: [
    {
      client: app1,
      functions: [
        app1.createFunction(
          { id: "test-function", triggers: [{ event: "connect-demo/test" }] },
          async ({ step }) => {
            await step.run("test", async () => {
              console.log("via connect!");
              await new Promise((resolve) => setTimeout(resolve, 10000));
              console.log("function done");
              return "this works";
            });
          }
        ),
        app1.createFunction(
          { id: "hello-world", triggers: [{ event: "connect-demo/hello-world" }] },
          async ({ step }) => {
            return { success: true };
          }
        ),
      ],
    },
    {
      client: app2,
      functions: [
        app2.createFunction(
          { id: "hello-world", triggers: [{ event: "connect-demo/hello-world" }] },
          async ({ step }) => {
            return { success: true };
          }
        ),
      ],
    },
  ],
  instanceId: "my-worker",
}).then(async (conn) => {
  console.log("Connected!");

  const statusLog = setInterval(() => {
    console.log(conn.state);
  }, 1000);

  await conn.closed;

  console.log("Closed, clearing");
  clearInterval(statusLog);
});
