import { functions, inngest } from "@/inngest";
import { serve } from "inngest/next";

/**
 * Try to automatically choose the edge runtime if `INNGEST_STREAMING` is set.
 *
 * See https://innge.st/streaming.
 */
export const runtime =
  process.env.INNGEST_STREAMING?.toLowerCase() === "force" ? "edge" : "nodejs";

export default serve({
  client: inngest,
  functions,
});
