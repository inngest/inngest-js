import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest";
import { contactImport, campaignSend } from "@/src/inngest/functions";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [contactImport, campaignSend],
});
