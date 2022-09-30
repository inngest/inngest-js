import { Response } from "cross-fetch";
import { z } from "zod";
import {
  InngestCommHandler,
  serve as defaultServe,
  ServeHandler,
} from "./express";
import { envKeys, queryKeys } from "./helpers/consts";
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
      let reqUrl: URL;
      let isIntrospection: boolean;

      try {
        reqUrl = new URL(req.url, `https://${req.headers.get("host") || ""}`);

        isIntrospection = reqUrl.searchParams.has(queryKeys.Introspect);
        reqUrl.searchParams.delete(queryKeys.Introspect);
      } catch (err) {
        return new Response(JSON.stringify(err), {
          status: 500,
          headers: {
            "x-inngest-sdk": `js/${this.frameworkName}`,
          },
        });
      }

      switch (req.method) {
        case "GET": {
          const showLandingPage = this.shouldShowLandingPage(
            process.env[envKeys.LandingPage]
          );

          if (!showLandingPage) break;

          if (isIntrospection) {
            const introspection: IntrospectRequest = {
              ...this.registerBody(reqUrl),
              hasSigningKey: Boolean(this.signingKey),
            };

            return new Response(JSON.stringify(introspection), {
              status: 200,
            });
          }

          // Grab landing page and serve
          return new Response(landing, {
            status: 200,
            headers: {
              "x-inngest-sdk": `js/${this.frameworkName}`,
              "content-type": "text/html;charset=UTF-8",
            },
          });
        }

        case "PUT": {
          // Push config to Inngest.
          const { status, message } = await this.register(reqUrl);
          return new Response(JSON.stringify({ message }), {
            status,
            headers: {
              "x-inngest-sdk": `js/${this.frameworkName}`,
            },
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

          return new Response(JSON.stringify(stepRes), {
            status: stepRes.status || 200,
            headers: {
              "x-inngest-sdk": `js/${this.frameworkName}`,
            },
          });
        }

        default:
          return new Response(null, {
            status: 405,
            headers: {
              "x-inngest-sdk": `js/${this.frameworkName}`,
            },
          });
      }

      return new Response(null, { status: 405 });
    };
  }
}

/**
 * In Remix, serve and register any declared functions with Inngest, making them
 * available to be triggered by events.
 *
 * @public
 */
export const register: ServeHandler = (nameOrInngest, fns, opts): any => {
  return defaultServe(new RemixCommHandler(nameOrInngest, fns, opts));
};
