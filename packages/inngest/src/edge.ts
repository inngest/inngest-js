/**
 * An adapter for any request that handles standard Web APIs such as `fetch`,
 * `Request,` and `Response` to serve and register any declared functions with
 * Inngest, making them available to be triggered by events.
 *
 * This is reused by many other adapters, but can be used directly.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/edge";
 * import functions from "~/inngest";
 *
 * export const handler = serve({ id: "my-edge-app", functions });
 * ```
 *
 * @module
 */

import type { Inngest } from "./components/Inngest.ts";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
  type SyncHandlerOptions,
} from "./components/InngestCommHandler.ts";
import { handleDurableEndpointProxyRequest } from "./components/InngestDurableEndpointProxy.ts";
import { InngestEndpointAdapter } from "./components/InngestEndpointAdapter.ts";
import type { RegisterOptions, SupportedFrameworkName } from "./types.ts";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "edge";

export type EdgeHandler = (req: Request) => Promise<Response>;

const commHandler = (
  options: RegisterOptions & { client: Inngest.Like },
  syncOptions?: SyncHandlerOptions,
) => {
  const handler = new InngestCommHandler({
    frameworkName,
    fetch: fetch.bind(globalThis),
    ...options,
    syncOptions,
    handler: (req: Request) => {
      return {
        body: () => req.text(),
        textBody: () => req.text(),
        headers: (key: string) => req.headers.get(key),
        method: () => req.method,
        url: () => new URL(req.url, `https://${req.headers.get("host") || ""}`),
        transformResponse: ({ body, status, headers }) => {
          return new Response(body, { status, headers });
        },
        experimentalTransformSyncResponse: async (data) => {
          const res = data as Response;

          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            headers[k] = v;
          });

          return {
            headers: headers,
            status: res.status,
            body: await res.clone().text(),
          };
        },
      };
    },
  });

  return handler;
};

/**
 * In an edge runtime, serve and register any declared functions with Inngest,
 * making them available to be triggered by events.
 *
 * The edge runtime is a generic term for any serverless runtime that supports
 * only standard Web APIs such as `fetch`, `Request`, and `Response`, such as
 * Cloudflare Workers, Vercel Edge Functions, and AWS Lambda@Edge.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/edge";
 * import functions from "~/inngest";
 *
 * export const handler = serve({ id: "my-edge-app", functions });
 * ```
 *
 * @public
 */
// Has explicit return type to avoid JSR-defined "slow types"
export const serve = (options: ServeHandlerOptions): EdgeHandler => {
  return commHandler(options).createHandler();
};

/**
 * Creates a durable endpoint proxy handler for edge environments.
 *
 * This handler extracts `runId` and `token` from query parameters,
 * fetches the run output from Inngest, decrypts it via middleware
 * (if configured), and returns it with CORS headers.
 */
const createDurableEndpointProxyHandler = (
  options: InngestEndpointAdapter.ProxyHandlerOptions,
): EdgeHandler => {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    const result = await handleDurableEndpointProxyRequest(
      options.client as Inngest.Any,
      {
        runId: url.searchParams.get("runId"),
        token: url.searchParams.get("token"),
        method: req.method,
      },
    );

    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
  };
};

/**
 * In an edge runtime, create a function that can wrap any endpoint to be able
 * to use steps seamlessly within that API.
 *
 * The edge runtime is a generic term for any serverless runtime that supports
 * only standard Web APIs such as `fetch`, `Request`, and `Response`, such as
 * Cloudflare Workers, Vercel Edge Functions, and AWS Lambda@Edge.
 *
 * @example
 * ```ts
 * import { Inngest, step } from "inngest";
 * import { endpointAdapter } from "inngest/edge";
 *
 * const inngest = new Inngest({
 *   id: "my-app",
 *   endpointAdapter,
 * });
 *
 * Bun.serve({
 *   routes: {
 *     "/": inngest.endpoint(async (req) => {
 *       const foo = await step.run("my-step", () => ({ foo: "bar" }));
 *
 *       return new Response(`Result: ${JSON.stringify(foo)}`);
 *     }),
 *   },
 * });
 * ```
 *
 * You can also configure a custom redirect URL and create a proxy endpoint:
 *
 * @example
 * ```ts
 * import { Inngest } from "inngest";
 * import { endpointAdapter } from "inngest/edge";
 *
 * const inngest = new Inngest({
 *   id: "my-app",
 *   endpointAdapter: endpointAdapter.withOptions({
 *     asyncRedirectUrl: "/api/inngest/poll",
 *   }),
 * });
 *
 * // Your durable endpoint
 * export const GET = inngest.endpoint(async (req) => {
 *   const result = await step.run("work", () => "done");
 *   return new Response(result);
 * });
 *
 * // Proxy endpoint at /api/inngest/poll - handles CORS and decryption
 * export const GET = inngest.endpointProxy();
 * ```
 */
export const durableEndpointAdapter = InngestEndpointAdapter.create(
  (options) => {
    return commHandler(options, options).createSyncHandler();
  },
  createDurableEndpointProxyHandler,
);

/**
 * @deprecated Use `durableEndpointAdapter` instead. This alias will be removed in a future version.
 */
export const endpointAdapter = durableEndpointAdapter;
