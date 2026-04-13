import type { DeferCtx } from "inngest";
import { inngest } from "./client";

export const helloWorld = inngest.createFunction(
  {
    id: "hello-world",
    triggers: [{ event: "demo/event.sent" }],
    defers: {
      scoring: {
        handler: async ({
          data,
          step,
        }: DeferCtx<{ name: string; status: string }>) => {
          console.log("Should we say it?");
          await step.run("wait-before-yelling", async () => {
            await new Promise((resolve) => setTimeout(resolve, 10_000));
          });
          console.log(`Listen up, bro! "${data.name}" is ${data.status}!!`);
        },
      },
      analytics: {
        // Middleware-injected fields (like `appVersion` from the DI
        // middleware configured on the client) are available at runtime
        // but require a manual type intersection until automatic
        // middleware type flow is supported for defer handlers.
        handler: async ({
          data,
          step,
          appVersion,
        }: DeferCtx<{ name: string }> & { appVersion: string }) => {
          await step.run("track", async () => {
            console.log(
              `[v${appVersion}] Tracking analytics for ${data.name}`,
            );
          });
        },
      },
    },
  },
  async ({ event, step, group }) => {
    const name = await step.run("get-name", async () => {
      return event.name;
    });

    const status = "Fooey!";
    const handle = await group.defer.scoring({ name, status });

    await group.defer.analytics({ name });

    if (event.data?.shouldCancel) {
      console.log("Don't say it bro!!");
      await handle.cancel();
    }

    return {
      message: `Hello ${name}!`,
    };
  },
);
