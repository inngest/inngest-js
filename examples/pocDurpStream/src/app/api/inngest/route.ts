import { serve } from "inngest/next";
import { inngest, helloWorld } from "@/inngest";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [helloWorld],
});
