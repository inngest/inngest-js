import { inngest } from "./client";

export const helloWorld = inngest.createFunction(
  {
    id: "hello-world",
    triggers: [{ event: "demo/event.sent" }],
    onDefer: {
      scoring: inngest.createDefer<{ name: string; status: string }>({
        handler: async ({ data, step }) => {
          console.log("Should we say it?");
          await step.run("wait-before-yelling", async () => {
            await new Promise((resolve) => setTimeout(resolve, 10_000));
          });
          console.log(`Listen up, bro! "${data.name}" is ${data.status}!!`);
          return 0.96;
        },
      }),
      analytics: inngest.createDefer<{ name: string }>({
        // Middleware-injected fields (like `appVersion` from the DI
        // middleware configured on the client) are automatically typed
        // when using `client.createDefer()`.
        handler: async ({ data, step, appVersion }) => {
          await step.run("track", async () => {
            console.log(`[v${appVersion}] Tracking analytics for ${data.name}`);
          });
          return true;
        },
      }),
    },
  },
  async ({ event, step, group }) => {
    const name = await step.run("get-name", async () => {
      return (event.data?.name as string) ?? "World";
    });

    const status = "Fooey!";
    const handle = await group.defer.scoring("score-it", { name, status });

    await group.defer.analytics("track-it", { name });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (event.data?.shouldCancel) {
      console.log("Don't say it bro!!");
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await group.defer.cancel("cancel-scoring", handle);
    }

    return {
      message: `Hello ${name}!`,
    };
  },
);
