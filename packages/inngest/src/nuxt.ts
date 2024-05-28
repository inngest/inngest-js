/**
 * An adapter for Nuxt to serve and register any declared functions with
 * Inngest, making them available to be triggered by events.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/nuxt";
 * import { inngest } from "~~/inngest/client";
 * import fnA from "~~/inngest/fnA"; // Your own function
 *
 * export default defineEventHandler(
 *   serve({
 *     client: inngest,
 *     functions: [fnA],
 *   })
 * );
 * ```
 *
 * @module
 */

import {
  type InternalServeHandlerOptions,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler";
import { serve as serveH3 } from "./h3";
import { type SupportedFrameworkName } from "./types";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "nuxt";

/**
 * In Nuxt 3, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/nuxt";
 * import { inngest } from "~~/inngest/client";
 * import fnA from "~~/inngest/fnA"; // Your own function
 *
 * export default defineEventHandler(
 *   serve({
 *     client: inngest,
 *     functions: [fnA],
 *   })
 * );
 * ```
 *
 * @public
 */
export const serve = (options: ServeHandlerOptions) => {
  const optsOverrides: InternalServeHandlerOptions = {
    ...options,
    frameworkName,
  };

  return serveH3(optsOverrides);
};
