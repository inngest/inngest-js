import { functions, inngest } from "@/inngest";
import { serve } from "inngest/next";

export default serve({
  client: inngest,
  functions,
});
