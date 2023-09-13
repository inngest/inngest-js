import { type ServeHandler } from "./components/InngestCommHandler";
import { serve as serveH3 } from "./h3";
import {
  type InternalRegisterOptions,
  type SupportedFrameworkName,
} from "./types";

export const name: SupportedFrameworkName = "nuxt";

/**
 * In Nuxt 3, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @public
 */
export const serve: ServeHandler = (client, functions, opts) => {
  const optsOverrides: InternalRegisterOptions = {
    ...opts,
    frameworkName: name,
  };

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return serveH3(client, functions, optsOverrides);
};
