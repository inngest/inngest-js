import type { NextApiRequest, NextApiResponse } from "next";
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
import { IntrospectRequest } from "./types";

class NextCommHandler extends InngestCommHandler {
  protected override frameworkName = "nextjs";

  public override createHandler() {
    return async (req: NextApiRequest, res: NextApiResponse) => {
      let reqUrl: URL;

      try {
        const scheme =
          process.env.NODE_ENV === "development" ? "http" : "https";
        reqUrl = new URL(
          req.url as string,
          `${scheme}://${req.headers.host || ""}`
        );
        reqUrl.searchParams.delete(queryKeys.Introspect);
      } catch (err) {
        return void res.status(500).json(err);
      }

      res.setHeader("x-inngest-sdk", this.sdkHeader.join(""));

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

          if (!showLandingPage) break;

          if (Object.hasOwnProperty.call(req.query, queryKeys.Introspect)) {
            const introspection: IntrospectRequest = {
              ...this.registerBody(reqUrl),
              devServerURL: devServerUrl(devServerHost()).href,
              hasSigningKey: Boolean(this.signingKey),
            };

            return void res.status(200).json(introspection);
          }

          // Grab landing page and serve
          res.setHeader("content-type", "text/html; charset=utf-8");
          return void res.status(200).send(landing);
        }

        case "PUT": {
          // Push config to Inngest.
          const { status, message } = await this.register(
            reqUrl,
            process.env[envKeys.DevServerUrl]
          );

          return void res.status(status).json({ message });
        }

        case "POST": {
          // Inngest is trying to run a step; confirm signed and run.
          const { fnId, stepId } = z
            .object({
              fnId: z.string().min(1),
              stepId: z.string().min(1),
            })
            .parse({
              fnId: req.query[queryKeys.FnId],
              stepId: req.query[queryKeys.StepId],
            });

          const stepRes = await this.runStep(fnId, stepId, req.body);

          if (stepRes.status === 500) {
            return void res.status(stepRes.status).json(stepRes.error);
          }

          return void res.status(stepRes.status).json(stepRes.body);
        }
      }

      return void res.status(405).end();
    };
  }
}

/**
 * In Next.js, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @public
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts): any => {
  return defaultServe(new NextCommHandler(nameOrInngest, fns, opts));
};
