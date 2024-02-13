import {
  type InternalServeHandlerOptions,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler";
import { serve as serveEdge } from "./edge";
import { type SupportedFrameworkName } from "./types";

export const frameworkName: SupportedFrameworkName = "bun";

/**
 * Using `Bun.serve()`, serve and register any declared functions with Inngest,
 * making them available to be triggered by events.
 *
 * @public
 */
export const serve = (options: ServeHandlerOptions) => {
  const optsOverrides: InternalServeHandlerOptions = {
    ...options,
    frameworkName,
  };

  return serveEdge(optsOverrides);
};
