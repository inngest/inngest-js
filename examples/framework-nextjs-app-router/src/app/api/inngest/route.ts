import { functions, inngest } from "@/inngest";
import { serve } from "inngest/next";

/**
 * Set `runtime = "edge"` to opt into the edge runtime for streaming.
 *
 * See https://innge.st/streaming.
 */
export const runtime = "nodejs";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
});
