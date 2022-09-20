import { Response } from "cross-fetch";
import { z } from "zod";
import { corsOrigin, fnIdParam, stepIdParam } from "../helpers/consts";
import {
  InngestCommHandler,
  register as defaultRegister,
  RegisterHandler,
} from "./default";

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
       * Specifically for CORS (browser->site requests), only allow PUT requests
       * from the dashboard.
       */
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 200,
          headers: {
            "Access-Control-Allow-Origin": corsOrigin,
            "Access-Control-Allow-Methods": "PUT",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      let reqUrl: URL;

      try {
        reqUrl = new URL(req.url, `https://${req.headers.get("host") || ""}`);
      } catch (err) {
        return new Response(JSON.stringify(err), {
          status: 500,
        });
      }

      switch (req.method) {
        case "PUT":
          console.log("It was a PUT request");
          // Push config to Inngest.
          await this.register(reqUrl);
          return new Response(null, {
            status: 200,
          });

        case "POST": {
          console.log("It was a POST request");
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

          const stepRes = await this.runStep(fnId, stepId, req.body);

          return new Response(JSON.stringify(stepRes), { status: 200 });
        }

        default:
          return new Response(null, { status: 405 });
      }
    };
  }
}

export const register: RegisterHandler = (
  nameOrInngest,
  signingKey,
  fns,
  opts
): any => {
  return defaultRegister(
    new RemixCommHandler(nameOrInngest, signingKey, fns, opts)
  );
};
