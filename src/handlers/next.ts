import type { NextApiRequest, NextApiResponse } from "next";
import NextCors from "nextjs-cors";
import { z } from "zod";
import { corsOrigin, fnIdParam, stepIdParam } from "../helpers/consts";
import {
  InngestCommHandler,
  register as defaultRegister,
  RegisterHandler,
} from "./default";

class NextCommHandler extends InngestCommHandler {
  protected override frameworkName = "nextjs";

  public override createHandler() {
    return async (req: NextApiRequest, res: NextApiResponse) => {
      /**
       * Specifically for CORS (browser->site requests), only allow PUT requests
       * from the dashboard.
       */
      await NextCors(req, res, {
        methods: ["PUT"],
        origin: corsOrigin,
        optionsSuccessStatus: 200,
      });

      let reqUrl: URL;

      try {
        const scheme =
          process.env.NODE_ENV === "development" ? "http" : "https";
        reqUrl = new URL(
          req.url as string,
          `${scheme}://${req.headers.host || ""}`
        );
      } catch (err) {
        return void res.status(500).json(err);
      }

      switch (req.method) {
        case "PUT":
          // Push config to Inngest.
          await this.register(reqUrl);
          return void res.status(200).end();

        case "POST": {
          console.log("It was a POST request");
          // Inngest is trying to run a step; confirm signed and run.
          const { fnId, stepId } = z
            .object({
              fnId: z.string().min(1),
              stepId: z.string().min(1),
            })
            .parse({
              fnId: req.query[fnIdParam],
              stepId: req.query[stepIdParam],
            });

          const stepRes = await this.runStep(fnId, stepId, req.body);

          if (stepRes.status === 500) {
            return void res.status(stepRes.status).json(stepRes.error);
          }

          return void res.status(stepRes.status).json(stepRes.body);
        }

        default:
          return void res.status(405).end();
      }
    };
  }
}

/**
 * In Next.js, register any declared functions with Inngest, making them
 * available to be triggered by events.
 *
 * @public
 */
export const register: RegisterHandler = (
  nameOrInngest,
  signingKey,
  fns,
  opts
): any => {
  return defaultRegister(
    new NextCommHandler(nameOrInngest, signingKey, fns, opts)
  );
};
