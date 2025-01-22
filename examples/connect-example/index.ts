import { Inngest } from "inngest";

const inngest = new Inngest({
  id: "my-connect-js-app",
  eventKey: "abc123",
  buildId: "v1.0",
});

const abort = new AbortController();

console.log("Connecting...");

inngest
  .connect({
    functions: [
      inngest.createFunction(
        { id: "test-function" },
        { event: "connect-demo/test" },
        async ({ step }) => {
          await step.run("test", () => {
            console.log("via connect!");
            return "this works";
          });
        }
      ),
    ],
    instanceId: "my-worker",
    signingKey: "signkey-test-12345678",
    signingKeyFallback: "signkey-test-00000000",
    abortSignal: abort.signal,
    //     baseUrl: "http://127.0.0.1:8288",
  })
  .then((conn) => {
    console.log("Connected!", conn.connectionId);
  });
