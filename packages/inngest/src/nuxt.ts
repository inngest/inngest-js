/**
 * An adapter for Nuxt to serve and register any declared functions with
 * Inngest, making them available to be triggered by events.
 *
 * @module
 */

import type {
  InternalServeHandlerOptions,
  ServeHandlerOptions,
} from "./components/InngestCommHandler.ts";
import { serve as serveH3 } from "./h3.ts";
import type { SupportedFrameworkName } from "./types.ts";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "nuxt";

/**
 * In Nuxt 3, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @public
 */
// Has explicit return type to avoid JSR-defined "slow types"
export const serve = (
  options: ServeHandlerOptions,
): ReturnType<typeof serveH3> => {
  const optsOverrides: InternalServeHandlerOptions = {
    ...options,
    frameworkName,
  };

  return serveH3(optsOverrides);
};
