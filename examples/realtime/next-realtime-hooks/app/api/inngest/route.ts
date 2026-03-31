import { getInngestApp } from "@/inngest";
import { helloWorld } from "@/inngest/functions/helloWorld";
import { serve } from "inngest/next";

const inngest = getInngestApp();

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [helloWorld],
});
