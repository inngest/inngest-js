import { eventType } from "inngest";
import { z } from "zod/v3";
import { inngest } from "../client";

const name = "wait-payload-schema";


const et = eventType(`${name}/resolve`, {
  schema: z.object({
    nested: z.object({
      msg: z.string(),
    }),
  }),
});

export default inngest.createFunction(
  { id: name },
  { event: name },
  async ({ step }) => {
    const matched = await step.waitForEvent("wait", {
      event: et,
      timeout: "1m",
    })
  
    return matched?.data;
  },
);
