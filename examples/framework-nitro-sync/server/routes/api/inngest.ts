import { defineEventHandler } from "h3";
import { serve } from "inngest/nitro";
import { functions, inngest } from "../../..//inngest";

export default defineEventHandler(
  serve({
    client: inngest,
    functions,
  }),
);
