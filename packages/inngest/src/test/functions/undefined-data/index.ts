import { inngest } from "../client";

export default inngest.createFunction(
  { id: "undefined-data" },
  { event: "demo/undefined.data" },
  async ({ step }) => {
    await step.run("step1res", () => "step1res");

    await step.run("step1", () => {
      // no-op
    });

    await Promise.all([
      step.run("step2res", () => "step2res"),
      step.run("step2nores", () => {
        // no-op
      }),
      step.run("step2res2", () => "step2res2"),
    ]);

    await step.run("step2", async () => {
      // no-op
    });

    await step.run("step3", async () => {
      // no-op
    });
  },
);
