/**
 * An adapter for Express to serve and register any declared functions with
 * Inngest, making them available to be triggered by events.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/express";
 * import { inngest } from "./src/inngest/client";
 * import fnA from "./src/inngest/fnA"; // Your own function
 *
 * // Important:  ensure you add JSON middleware to process incoming JSON POST payloads.
 * app.use(express.json());
 * app.use(
 *   // Expose the middleware on our recommended path at `/api/inngest`.
 *   "/api/inngest",
 *   serve({ client: inngest, functions: [fnA] })
 * );
 * ```
 *
 * @module
 */

import { type VercelRequest, type VercelResponse } from "@vercel/node";
import { type Request, type Response } from "express";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler.js";
import { type Either } from "./helpers/types.js";
import { type SupportedFrameworkName } from "./types.js";

/**
 * The name of the framework, used to identify the framework in Inngest
 * dashboards and during testing.
 */
export const frameworkName: SupportedFrameworkName = "express";

/**
 * Serve and register any declared functions with Inngest, making them available
 * to be triggered by events.
 *
 * The return type is currently `any` to ensure there's no required type matches
 * between the `express` and `vercel` packages. This may change in the future to
 * appropriately infer.
 *
 * @example
 * ```ts
 * import { serve } from "inngest/express";
 * import { inngest } from "./src/inngest/client";
 * import fnA from "./src/inngest/fnA"; // Your own function
 *
 * // Important:  ensure you add JSON middleware to process incoming JSON POST payloads.
 * app.use(express.json());
 * app.use(
 *   // Expose the middleware on our recommended path at `/api/inngest`.
 *   "/api/inngest",
 *   serve({ client: inngest, functions: [fnA] })
 * );
 * ```
 *
 * @public
 */
// Has explicit return type to avoid JSR-defined "slow types"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const serve = (options: ServeHandlerOptions): any => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (
      req: Either<VercelRequest, Request>,
      res: Either<Response, VercelResponse>
    ) => {
      return {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        body: () => req.body,
        headers: (key) => {
          const header = req.headers[key];
          return Array.isArray(header) ? header[0] : header;
        },
        method: () => req.method || "GET",
        url: () => {
          // `req.hostname` can filter out port numbers; beware!
          const hostname = req.headers["host"] || options?.serveHost;

          const protocol = hostname?.includes("://")
            ? ""
            : `${req.protocol || "https"}://`;

          const url = new URL(
            req.originalUrl || req.url || "",
            `${protocol}${hostname || ""}`
          );

          return url;
        },
        queryString: (key) => {
          const qs = req.query[key];
          return Array.isArray(qs) ? qs[0] : qs;
        },
        transformResponse: ({ body, headers, status }) => {
          for (const [name, value] of Object.entries(headers)) {
            res.setHeader(name, value);
          }

          return res.status(status).send(body);
        },
      };
    },
  });

  return handler.createHandler();
};
