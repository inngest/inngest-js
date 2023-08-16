import { inngest } from "../client";

export default inngest.createFunction(
  { name: "Promise.race" },
  { event: "demo/promise.race" },
  async ({ step }) => {
    const winner = await Promise.race([
      step.run("Step A", () => "A"),
      step.run("Step B", () => "B"),
    ]);

    await step.run("Step C", () => `${winner} is the winner!`);
  }
);
