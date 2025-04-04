import { inngest } from "@/inngest/client";
import { serve } from "inngest/next";
import { simpleSearchAgent } from "@/inngest/functions/simple-search";
import { stagehandAction } from "@/inngest/functions/simple-search/stagehand-tools";
import { helloWorld } from "@/inngest/functions/hello-world";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [simpleSearchAgent, stagehandAction, helloWorld],
});
