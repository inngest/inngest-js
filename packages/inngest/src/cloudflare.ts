import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler";
import { type SupportedFrameworkName } from "./types";

export const frameworkName: SupportedFrameworkName = "cloudflare-pages";

/**
 * In Cloudflare, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @public
 */
export const serve = (options: ServeHandlerOptions) => {
  const handler = new InngestCommHandler({
    frameworkName,

    /**
     * Assume that we want to override the `fetch` implementation with the one
     * globally available in the Cloudflare env. Specifying it here will
     * ensure we avoid trying to load a Node-compatible version later.
     */
    fetch: fetch.bind(globalThis),
    ...options,
    handler: ({
      request: req,
      env,
    }: {
      request: Request;
      env: Record<string, string | undefined>;
    }) => {
      return {
        body: () => req.json(),
        headers: (key) => req.headers.get(key),
        method: () => req.method,
        env: () => env,
        url: () => new URL(req.url, `https://${req.headers.get("host") || ""}`),
        transformResponse: ({ body, status, headers }) => {
          return new Response(body, {
            status,
            headers,
          });
        },
      };
    },
  });

  return handler.createHandler();
};
