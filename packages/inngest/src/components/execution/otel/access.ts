/**
 * A file used to access client processors safely without also importing any
 * otel-specific libraries. Useful for ensuring that the otel libraries can be
 * tree-shaken if they're not used directly by the user.
 */

import { type Inngest } from "../../Inngest.js";
import { type InngestSpanProcessor } from "./processor.js";

/**
 * TODO
 */
export const clientProcessorMap = new WeakMap<
  Inngest.Any,
  InngestSpanProcessor
>();
