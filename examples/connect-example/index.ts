import { Inngest } from "inngest";

console.log("Starting up worker with pid", process.pid);

const inngest = new Inngest({
  id: "my-connect-js-app",
  eventKey: "abc123",
  buildId: "v1.0",
});

console.log("Connecting...");

inngest["connect"]({
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
  ],
  instanceId: "my-worker",
  signingKey: "signkey-test-12345678",
  signingKeyFallback: "signkey-test-00000000",
  //     baseUrl: "http://127.0.0.1:8288",
  rewriteGatewayEndpoint: (url) => {
    return url.replace("127.0.0.1:8289", "host.docker.internal:8289");
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
