import { serve as serveH3 } from "./h3";
import { type ServeHandler } from "./components/InngestCommHandler";
import { type SupportedFrameworkName } from "./types";

export const name: SupportedFrameworkName = "nuxt";

/**
 * In Nuxt 3, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @public
 */
export const serve: ServeHandler = serveH3;
