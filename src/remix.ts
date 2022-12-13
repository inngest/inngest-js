import { z } from "zod";
import {
  InngestCommHandler,
  serve as defaultServe,
  ServeHandler,
} from "./express";
import { envKeys, queryKeys } from "./helpers/consts";
import { devServerUrl } from "./helpers/devserver";
import { devServerHost } from "./helpers/env";
import { landing } from "./landing";
import type { IntrospectRequest } from "./types";

/**
 * app/inngest/index.server.ts
 * app/routes/api/inngest.ts
 */
class RemixCommHandler extends InngestCommHandler {
  protected override frameworkName = "remix";

  public override createHandler() {
    return async ({
      request: req,
    }: {
      request: Request;
    }): Promise<Response> => {
      /**
       * If `Response` isn't included in this environment, it's probably a Node
       * env that isn't already polyfilling. In this case, we can polyfill it
       * here to be safe.
       */
      let Res: typeof Response;

      if (typeof Response === "undefined") {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-var-requires
        Res = require("cross-fetch").Response;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        Res = Response;
      }

      const headers = { "x-inngest-sdk": this.sdkHeader.join("") };

      let reqUrl: URL;
      let isIntrospection: boolean;

      try {
        reqUrl = this.reqUrl(
          req.url,
          `https://${req.headers.get("host") || ""}`
        );
        isIntrospection = reqUrl.searchParams.has(queryKeys.Introspect);
        reqUrl.searchParams.delete(queryKeys.Introspect);
      } catch (err) {
        return new Res(JSON.stringify(err), {
          status: 500,
          headers,
        });
      }

      if (!this.signingKey && process.env[envKeys.SigningKey]) {
        this.signingKey = process.env[envKeys.SigningKey];
      }

      this._isProd =
        process.env.VERCEL_ENV === "production" ||
        process.env.CONTEXT === "production" ||
        process.env.ENVIRONMENT === "production";

      switch (req.method) {
        case "GET": {
          const showLandingPage = this.shouldShowLandingPage(
            process.env[envKeys.LandingPage]
          );

          if (this._isProd || !showLandingPage) break;

          if (isIntrospection) {
            const introspection: IntrospectRequest = {
              ...this.registerBody(reqUrl),
              devServerURL: devServerUrl(devServerHost()).href,
              hasSigningKey: Boolean(this.signingKey),
            };

            return new Res(JSON.stringify(introspection), {
              status: 200,
              headers,
            });
          }

          // Grab landing page and serve
          return new Res(landing, {
            status: 200,
            headers: {
              ...headers,
              "content-type": "text/html; charset=utf-8",
            },
          });
        }

        case "PUT": {
          // Push config to Inngest.
          const { status, message } = await this.register(
            reqUrl,
            process.env[envKeys.DevServerUrl]
          );

          return new Res(JSON.stringify({ message }), {
            status,
            headers,
          });
        }

        case "POST": {
          // Inngest is trying to run a step; confirm signed and run.
          const { fnId, stepId } = z
            .object({
              fnId: z.string().min(1),
              stepId: z.string().min(1),
            })
            .parse({
              fnId: reqUrl.searchParams.get(queryKeys.FnId),
              stepId: reqUrl.searchParams.get(queryKeys.StepId),
            });

          const stepRes = await this.runStep(fnId, stepId, await req.json());

          if (stepRes.status === 500) {
            return new Res(JSON.stringify(stepRes.error), {
              status: stepRes.status,
              headers,
            });
          }

          return new Res(JSON.stringify(stepRes.body), {
            status: stepRes.status,
            headers,
          });
        }
      }

      return new Res(null, { status: 405, headers });
    };
  }
}

/**
 * In Remix, serve and register any declared functions with Inngest, making them
 * available to be triggered by events.
 *
 * Remix requires that you export both a "loader" for serving `GET` requests,
 * and an "action" for serving other requests, therefore exporting both is
 * required.
 *
 * See {@link https://remix.run/docs/en/v1/guides/resource-routes}
 *
 * @example
 * ```ts
 * import { serve } from "inngest/remix";
 * import fns from "~/inngest";
 *
 * const handler = serve("My Remix App", fns);
 *
 * export { handler as loader, handler as action };
 * ```
 *
 * @public
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts): any => {
  return defaultServe(new RemixCommHandler(nameOrInngest, fns, opts));
};
