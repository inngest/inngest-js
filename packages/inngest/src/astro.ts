import { type APIContext } from "astro";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler";
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
  const commHandler = new InngestCommHandler({
    frameworkName,
    fetch: fetch.bind(globalThis),
    ...options,
    handler: ({ request }: APIContext) => {
      return {
        body: () => request.json(),
        headers: (key) => request.headers.get(key),
        method: () => request.method,
        url: () => {
          // Attempt to get host separately as Astro will warn if
          // not in server output mode
          const host = request.headers.get("host");
          if (!host || host.length === 0) {
            throw new Error(
              `Could not access Astro.request.headers.host. Please change your Astro config to use "server" or "hybrid" output mode.`
            );
          }
          return new URL(request.url, `https://${host || ""}`);
        },

        transformResponse: ({ body, status, headers }) => {
          return new Response(body, { status, headers });
        },
      };
    },
  });

  const requestHandler = commHandler.createHandler();
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
