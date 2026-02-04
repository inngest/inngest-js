import { eventType } from "inngest";
import { z } from "zod/v3";
import { inngest } from "../client";

const name = "run-payload-wildcard-schema";

const et = eventType(`${name}/*`, {
  schema: z.object({
    nested: z.object({
      msg: z.string(),
    }),
  }),
});

export default inngest.createFunction(
  { id: name, triggers: [et] },
  async ({ event }) => {
    return event.data;
  },
);
