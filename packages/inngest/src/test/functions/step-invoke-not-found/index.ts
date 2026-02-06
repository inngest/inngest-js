import { referenceFunction } from "inngest";
import { inngest } from "../client";

export default inngest.createFunction(
  { id: "step-invoke-not-found" },
  { event: "demo/step.invoke.not-found" },
  async ({ step }) => {
    await step.invoke("invoke-non-existent-fn", {
      function: referenceFunction({ functionId: "non-existant-fn" }),
    });
  },
);
