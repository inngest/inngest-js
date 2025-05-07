import { inngest } from "../src/lib/inngest";

export const FAILING_EVENT = "demo/failing.step";

const failingFunction = inngest.createFunction(
  { id: "demo/failing-step", retries: 1 },
  { event: FAILING_EVENT },
  async ({ step }) => {
    // first step sleeps for 5 seconds
    await step.sleep("wait-5s", "5s");

    // second step fails
    await step.run("Failing step", async () => {
      throw new Error("This step always fails!");
    });
    return "done";
  }
);

export default failingFunction;
