import { serve } from "inngest/nitro";
import { functions, inngest } from "~~/inngest";

export default eventHandler(
  serve({
    client: inngest,
    functions,
  })
);
