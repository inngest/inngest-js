import { serve } from "inngest/next";
import { inngest } from "../../../lib/inngest";
import {
  simpleSleepFunction,
  multiStepStreamingFunction,
  failingFunction,
  throttledFunction,
} from "../../../lib/demo-functions";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    simpleSleepFunction,
    multiStepStreamingFunction,
    failingFunction,
    throttledFunction,
  ],
});
