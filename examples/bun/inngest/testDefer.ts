import { inngest } from "./client";

export const testDefer = inngest.createFunction(
  { id: "test-defer", triggers: [{ event: "test/defer" }] },
  async ({ event, step, group }) => {
    let foo: string | undefined;

    const result = await step.run("main-work", () => {
      console.log("Main work executing:", event.data?.message);
      return { processed: true, input: event.data?.message };
    });

    // Register a deferred group that runs after the function completes.
    // Returns a value — this should be the deferred run's output.
    group.defer("send-analytics", async ({ result: fnResult }) => {
      const analyticsResult = await step.run("log-analytics", () => {
        console.log("Analytics: function completed with result:", fnResult);
        console.log("Analytics: foo =", foo);
        return { analytics: "sent", parentResult: fnResult, foo };
      });

      // Return a value — this becomes the deferred run's function output
      return { deferOutput: "analytics-done", analyticsResult };
    });

    // Register another deferred group with a return value
    group.defer("cleanup", async ({ result: fnResult, error: fnError }) => {
      const cleanResult = await step.run("cleanup-temp", () => {
        console.log("Cleanup: removing temporary data");
        console.log("Cleanup: foo =", foo);
        console.log("Cleanup: fnResult =", fnResult);
        return { cleaned: true, foo };
      });

      return { deferOutput: "cleanup-done", cleanResult };
    });

    const extra = await step.run("extra-work", () => {
      console.log("Extra work after registering defers");
      return "extra done";
    });

    // Mutate foo AFTER all steps and defer registrations.
    // The defer callbacks should see this value because they run
    // after the function completes (closures capture final state).
    foo = `mutated-after-all-steps:${result.input}`;

    return { ...result, extra };
  },
);
