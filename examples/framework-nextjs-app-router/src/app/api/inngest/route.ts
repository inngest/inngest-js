import { serve } from "inngest/next";
import { functions, inngest } from "@/inngest";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});
