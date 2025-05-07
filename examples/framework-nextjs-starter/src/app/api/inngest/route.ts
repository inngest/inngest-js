import { serve } from "inngest/next";
import { inngest } from "../../../lib/inngest";
import {
  simpleSleepFunction,
  multiStepStreamingFunction,
} from "../../../lib/demoFunctions";
import failingFunction from "../../../../inngest/failing-step";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [simpleSleepFunction, multiStepStreamingFunction, failingFunction],
});
