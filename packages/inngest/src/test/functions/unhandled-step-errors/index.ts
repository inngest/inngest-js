import { inngest } from "../client";

export default inngest.createFunction(
  { id: "unhandled-step-errors", retries: 1 },
  { event: "demo/unhandled.step.errors" },
  async ({ step }) => {
    await step.run("a fails", () => {
      throw new Error("A failed!");
    });

    await step.run("b never runs", () => "b");
  },
);
