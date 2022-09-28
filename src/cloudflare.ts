import { z } from "zod";
import {
  InngestCommHandler,
  serve as defaultServe,
  ServeHandler,
} from "./express";
import { fnIdParam, stepIdParam } from "./helpers/consts";

class CloudflareCommHandler extends InngestCommHandler {
  protected override frameworkName = "remix";

  public override createHandler() {
    return async ({
      request: req,
    }: {
      request: Request;
    }): Promise<Response> => {
      let reqUrl: URL;

      try {
        reqUrl = new URL(req.url, `https://${req.headers.get("host") || ""}`);
      } catch (err) {
        return new Response(JSON.stringify(err), {
          status: 500,
        });
      }

      switch (req.method) {
        case "PUT": {
          // Push config to Inngest.
          const { status, message } = await this.register(reqUrl);
          return new Response(JSON.stringify({ message }), { status });
        }

        case "POST": {
          // Inngest is trying to run a step; confirm signed and run.
          const { fnId, stepId } = z
            .object({
              fnId: z.string().min(1),
              stepId: z.string().min(1),
            })
            .parse({
              fnId: reqUrl.searchParams.get(fnIdParam),
              stepId: reqUrl.searchParams.get(stepIdParam),
            });

          const stepRes = await this.runStep(fnId, stepId, await req.json());

          if (stepRes.status === 500) {
            return new Response(JSON.stringify(stepRes.error), {
              status: stepRes.status,
            });
          }

          return new Response(JSON.stringify(stepRes.body), {
            status: stepRes.status,
          });
        }

        default:
          return new Response(null, { status: 405 });
      }
    };
  }
}

/**
 * In Cloudflare, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @public
 */
export const register: ServeHandler = (
  nameOrInngest,
  signingKey,
  fns,
  opts
): any => {
  return defaultServe(
    new CloudflareCommHandler(nameOrInngest, signingKey, fns, opts)
  );
};
