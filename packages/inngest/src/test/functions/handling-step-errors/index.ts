import { inngest } from "../client";

export default inngest.createFunction(
  { id: "handling-step-errors", retries: 1 },
  { event: "demo/handling.step.errors" },
  async ({ step }) => {
    try {
      await step.run("a", () => {
        throw new Error("Oh no!", {
          cause: new Error("This is the cause"),
        });
      });
    } catch (err) {
      await step.run("b", () => {
        return `err was: "${err.message}" and the cause was: "${err.cause.message}"`;
      });
    }

    await Promise.all([
      step.run("c succeeds", () => "c succeeds"),
      step
        .run("d fails", () => {
          throw new Error("D failed!");
        })
        .catch((err: Error) => {
          return step.run("e succeeds", () => {
            return {
              errMessage: err.message,
            };
          });
        }),
    ]);
  }
);
