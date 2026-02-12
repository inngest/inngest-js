import { inngest } from "../client";

const cronInvokeFn = inngest.createFunction(
  { id: "step-invoke-cron", triggers: [{ cron: "59 23 31 12 *" }] },
  async ({ step }) => {
    await step.sleep("wait-a-moment", "1s");

    return {
      cronInvokeDone: true,
    };
  },
);

const eventInvokeFn = inngest.createFunction(
  { id: "step-invoke-event", triggers: [{ event: "demo/step.invoke.other" }] },
  async ({ step }) => {
    await step.sleep("wait-a-moment", "1s");

    return {
      eventInvokeDone: true,
    };
  },
);

const mainFn = inngest.createFunction(
  { id: "step-invoke", triggers: [{ event: "demo/step.invoke" }] },
  async ({ step }) => {
    return Promise.all([
      step.invoke("event-fn", { function: eventInvokeFn }),
      step.invoke("cron-fn", { function: cronInvokeFn }),
    ]);
  },
);

export default [mainFn, eventInvokeFn, cronInvokeFn];
