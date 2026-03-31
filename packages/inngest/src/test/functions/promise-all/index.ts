import { inngest } from "../client";

export default inngest.createFunction(
  { id: "promise-all", triggers: [{ event: "demo/promise.all" }] },
  async ({ step }) => {
    const [one, two] = await Promise.all([
      step.run("Step 1", () => 1),
      step.run("Step 2", () => 2),
    ]);

    return step.run("Step 3", () => one + two);
  },
);
