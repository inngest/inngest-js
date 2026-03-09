import { getInngestApp } from "@/inngest";
import { helloWorld } from "@/inngest/functions/helloWorld";
import { serve } from "inngest/next";

const inngest = getInngestApp();

// Create an API that serves zero functions
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    /* your functions will be passed here later! */
    helloWorld,
  ],
});
