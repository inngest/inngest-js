import OpenAI from "openai";

import { extendedTracesMiddleware } from "../../../packages/inngest/src/experimental";
import { Inngest } from "../../../packages/inngest/src/index.ts";

export const openaiClient = new OpenAI();

export const inngest = new Inngest({
  id: "temp-sandbox",
  middleware: [extendedTracesMiddleware()],
});
