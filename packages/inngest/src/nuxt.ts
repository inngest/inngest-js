import {
  type InternalServeHandlerOptions,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler";
import { serve as serveH3 } from "./h3";
import { type SupportedFrameworkName } from "./types";

export const frameworkName: SupportedFrameworkName = "nuxt";

/**
 * In Nuxt 3, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
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
