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

import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { Request, Response } from "express";
import {
  InngestCommHandler,
  type ServeHandlerOptions,
} from "./components/InngestCommHandler.ts";
import type { Either } from "./helpers/types.ts";
import type { SupportedFrameworkName } from "./types.ts";

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
// biome-ignore lint/suspicious/noExplicitAny: intentional
export const serve = (options: ServeHandlerOptions): any => {
  const handler = new InngestCommHandler({
    frameworkName,
    ...options,
    handler: (
      req: Either<VercelRequest, Request>,
      res: Either<Response, VercelResponse>,
    ) => {
      return {
        body: () => req.body,
        headers: (key) => {
          const header = req.headers[key];
          return Array.isArray(header) ? header[0] : header;
        },
        method: () => req.method || "GET",
        url: () => {
          // `req.hostname` can filter out port numbers; beware!
          const hostname = req.headers["host"] || options?.serveOrigin;

          const protocol = hostname?.includes("://")
            ? ""
            : `${req.protocol || "https"}://`;

          const url = new URL(
            req.originalUrl || req.url || "",
            `${protocol}${hostname || ""}`,
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

        /**
         * Express doesn't support a Web API `ReadableStream` being written as
         * the response body (only `node:stream` `ReadableStream`s), so we
         * manually read the stream we're given and call `res.write()` for each
         * chunk.
         *
         * See {@link https://github.com/expressjs/discussions/issues/288}.
         *
         * Alternatively, we could pipe this through a transform and create a
         * Node stream, but the feels more dangerous than just writing directly
         * to the response.
         */
        transformStreamingResponse: async ({ body, headers, status }) => {
          for (const [name, value] of Object.entries(headers)) {
            res.setHeader(name, value);
          }

          res.status(status);

          const reader = body.getReader();
          try {
            // Keep writing from the stream until it's done
            let done = false;
            while (!done) {
              const result = await reader.read();
              done = result.done;
              if (!done) {
                res.write(result.value);
              }
            }
            res.end();
          } catch (error) {
            if (error instanceof Error) {
              res.destroy(error);
            } else {
              res.destroy(new Error(String(error)));
            }
          }
        },
      };
    },
  });

  return handler.createHandler();
};
