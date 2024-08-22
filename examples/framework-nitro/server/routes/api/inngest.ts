import { serve } from "inngest/h3";
import { functions, inngest } from "~~/inngest";

export default eventHandler(
  serve({
    client: inngest,
    functions,
  })
);
