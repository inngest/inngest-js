/**
 * An adapter for DigitalOcean Functions to serve and register any declared
 * functions with Inngest, making them available to be triggered by events.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/digitalocean";
 * import { inngest } from "./src/inngest/client";
 * import fnA from "./src/inngest/fnA"; // Your own function
 *
 * const main = serve({
 *   client: inngest,
 *   functions: [fnA],
 *   // Your digitalocean hostname.  This is required otherwise your functions won't work.
 *   serveHost: "https://faas-sfo3-your-url.doserverless.co",
 *   // And your DO path, also required.
 *   servePath: "/api/v1/web/fn-your-uuid/inngest",
 * });
 *
 * // IMPORTANT: Makes the function available as a module in the project.
 * // This is required for any functions that require external dependencies.
 * module.exports.main = main;
 * ```
 *
 * @module
 */

import {
  type ActionResponse,
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler.ts";
import type { SupportedFrameworkName } from "./types.ts";

type HTTP = {
  headers: Record<string, string>;
  method: string;
  path: string;
};

type Main =
  | {
      http?: HTTP;
      // data can include any JSON-decoded post-data, and query args/saerch params.
      [data: string]: unknown;
    }
  | undefined;

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "digitalocean";

/**
 * In DigitalOcean Functions, serve and register any declared functions with
 * Inngest, making them available to be triggered by events.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/digitalocean";
 * import { inngest } from "./src/inngest/client";
 * import fnA from "./src/inngest/fnA"; // Your own function
 *
 * const main = serve({
 *   client: inngest,
 *   functions: [fnA],
 *   // Your digitalocean hostname.  This is required otherwise your functions won't work.
 *   serveHost: "https://faas-sfo3-your-url.doserverless.co",
 *   // And your DO path, also required.
 *   servePath: "/api/v1/web/fn-your-uuid/inngest",
 * });
 *
 * // IMPORTANT: Makes the function available as a module in the project.
 * // This is required for any functions that require external dependencies.
 * module.exports.main = main;
 * ```
 *
 * @public
 */
// Has explicit return type to avoid JSR-defined "slow types"
export const serve = (
  options: ServeHandlerOptions &
    Required<Pick<NonNullable<ServeHandlerOptions>, "serveHost">>,
): ((main?: Main) => Promise<ActionResponse<string>>) => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (main: Main = {}) => {
      const { http = { method: "GET", headers: {}, path: "" }, ...data } = main;

      return {
        body: () => data || {},
        headers: (key) => http?.headers?.[key],
        method: () => http.method,
        url: () => new URL(`${options.serveHost}${options.servePath || "/"}`),
        queryString: (key) => main[key] as string,
        transformResponse: (res) => res,
        transformSyncRequest: null,
        transformSyncResponse: null,
      };
    },
  });

  return handler.createHandler();
};
