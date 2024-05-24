import { type ServeHandlerOptions } from "./components/InngestCommHandler";
import { serve as serveEdge } from "./edge";
import { type SupportedFrameworkName } from "./types";

export const frameworkName: SupportedFrameworkName = "astro";

/**
 * In Astro, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @example
 * ```ts
 * export const { GET, POST, PUT } = serve({
 *   client: inngest,
 *   functions: [fn1, fn2],
 * });
 * ```
 *
 * @public
 */
export const serve = (options: ServeHandlerOptions) => {
  const requestHandler = serveEdge(options);
  type RequestHandler = typeof requestHandler;

  return Object.defineProperties(requestHandler, {
    GET: { value: requestHandler },
    POST: { value: requestHandler },
    PUT: { value: requestHandler },
  }) as RequestHandler & {
    GET: RequestHandler;
    POST: RequestHandler;
    PUT: RequestHandler;
  };
};
