import type { MetadataTarget } from "inngest";
import { inngest } from "./client";

// TODO: right now, inside of the steps where we're updating the progress won't quite work as expected
// because that isn't giong to get set until that entire step finishes. Although... that is only a relevant behavior
// inside of step context without a target. And it is kind of a hacky use case anyway? Traces *are* a better
const metadataDemo = inngest.createFunction(
  { id: "otel-metadata-demo" },
  { event: "demo/metadata.triggered" },
  async ({ event, step }) => {
    await step.metadata.update("status", {
      phase: "initializing",
      message: "running this thing",
    });

    const parsed = await step.run("parse-message", async () => {
      await step.metadata.update({ phase: "parsing" });
      await step.metadata.update("progress", { percent: 20 });

      return {
        super: "cool",
      };
    });

    return {
      success: "true",
    };
  },
);

export default metadataDemo;
