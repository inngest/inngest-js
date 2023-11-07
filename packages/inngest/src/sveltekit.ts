import { type RequestEvent } from "@sveltejs/kit";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler";
import { processEnv } from "./helpers/env";
import { type SupportedFrameworkName } from "./types";

export const frameworkName: SupportedFrameworkName = "sveltekit";

/**
 * Using SvelteKit, serve and register any declared functions with Inngest,
 * making them available to be triggered by events.
 *
 * @example
 * ```ts
 * export const { GET, POST, PUT } = serve(...);
 * ```
 *
 * @public
 */
export const serve = (options: ServeHandlerOptions) => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (method: string, event: RequestEvent) => {
      return {
        method: () => method,
        body: () => event.request.json(),
        headers: (key) => event.request.headers.get(key),
        url: () => {
          const protocol =
            processEnv("NODE_ENV") === "development" ? "http" : "https";

          return new URL(
            event.request.url,
            `${protocol}://${
              event.request.headers.get("host") || options.serveHost || ""
            }`
          );
        },
        transformResponse: ({ body, headers, status }) => {
          return new Response(body, { status, headers });
        },
      };
    },
  });

  const baseFn = handler.createHandler();

  return {
    GET: baseFn.bind(null, "GET"),
    POST: baseFn.bind(null, "POST"),
    PUT: baseFn.bind(null, "PUT"),
  };
};
