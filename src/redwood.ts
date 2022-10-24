import type {
  APIGatewayProxyEvent,
  Context as LambdaContext,
} from "aws-lambda";
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

export interface RedwoodResponse {
  statusCode: number;
  body?: string | null;
  headers?: Record<string, string>;
}

class RedwoodCommHandler extends InngestCommHandler {
  protected override frameworkName = "redwoodjs";

  public override createHandler() {
    return async (
      event: APIGatewayProxyEvent,
      context: LambdaContext
    ): Promise<RedwoodResponse> => {
      const headers = { "x-inngest-sdk": this.sdkHeader.join("") };

      let reqUrl: URL;

      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        console.log("yerp a derp:", global as any, process.env);
      } catch {
        // noop
      }

      try {
        const scheme =
          process.env.NODE_ENV === "development" ? "http" : "https";

        reqUrl = this.reqUrl(
          event.path,
          `${scheme}://${event.headers.host || ""}`
        );
        reqUrl.searchParams.delete(queryKeys.Introspect);
      } catch (err) {
        return {
          statusCode: 500,
          body: JSON.stringify(err),
          headers,
        };
      }

      if (!this.signingKey && process.env[envKeys.SigningKey]) {
        this.signingKey = process.env[envKeys.SigningKey];
      }

      this._isProd =
        process.env.VERCEL_ENV === "production" ||
        process.env.CONTEXT === "production" ||
        process.env.ENVIRONMENT === "production";

      switch (event.httpMethod) {
        case "GET": {
          const showLandingPage = this.shouldShowLandingPage(
            process.env[envKeys.LandingPage]
          );

          if (!showLandingPage) break;

          if (
            Object.hasOwnProperty.call(
              event.queryStringParameters,
              queryKeys.Introspect
            )
          ) {
            const introspection: IntrospectRequest = {
              ...this.registerBody(reqUrl),
              devServerURL: devServerUrl(devServerHost()).href,
              hasSigningKey: Boolean(this.signingKey),
            };

            return {
              statusCode: 200,
              body: JSON.stringify(introspection),
              headers,
            };
          }

          // Grab landing page and serve
          return {
            statusCode: 200,
            body: landing,
            headers: {
              ...headers,
              "content-type": "text/html; charset=utf-8",
            },
          };
        }

        case "PUT": {
          // Push config to Inngest.
          const { status, message } = await this.register(
            reqUrl,
            process.env[envKeys.DevServerUrl]
          );

          return {
            statusCode: status,
            body: JSON.stringify({ message }),
            headers,
          };
        }

        case "POST": {
          // Inngest is trying to run a step; confirm signed and run.
          const { fnId, stepId } = z
            .object({
              fnId: z.string().min(1),
              stepId: z.string().min(1),
            })
            .parse({
              fnId: event.queryStringParameters?.[queryKeys.FnId],
              stepId: event.queryStringParameters?.[queryKeys.StepId],
            });

          const stepRes = await this.runStep(
            fnId,
            stepId,
            JSON.parse(event.body || "{}")
          );

          if (stepRes.status === 500) {
            return {
              statusCode: stepRes.status,
              body: JSON.stringify(stepRes.error),
              headers,
            };
          }

          return {
            statusCode: stepRes.status,
            body: JSON.stringify(stepRes.body),
            headers,
          };
        }
      }

      return {
        statusCode: 405,
        headers,
      };
    };
  }
}

/**
 * In Redwood.js, serve and register any declared functions with Inngest, making
 * them available to be triggered by events.
 *
 * @public
 */
export const serve: ServeHandler = (nameOrInngest, fns, opts): any => {
  return defaultServe(new RedwoodCommHandler(nameOrInngest, fns, opts));
};
