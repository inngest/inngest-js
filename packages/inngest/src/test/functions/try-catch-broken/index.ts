import { NonRetriableError } from "../../../components/NonRetriableError";
import { inngest } from "../client";

export default inngest.createFunction(
  { id: "try-catch-broken", retries: 1 },
  { event: "demo/try.catch.broken" },
  async ({ step }) => {
    try {
      await step.run("failing-step", () => {
        throw new NonRetriableError("This should be caught");
      });
      return "This shouldn't be returned";
    } catch (err) {
      return "Gracefully handled error!"; // This should execute
    }
  },
);
