import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { Inngest } from "../components/Inngest";
import { InngestFunction } from "../components/InngestFunction";
import { corsOrigin, fnIdParam, stepIdParam } from "../helpers/consts";
import {
  EventPayload,
  FunctionConfig,
  RegisterOptions,
  RegisterRequest,
  StepRunResponse,
} from "../types";
import { version } from "../version";

/**
 * A handler for serving Inngest functions. This type should be used
 * whenever a handler for a new framework is being added to enforce that the
 * registration process is always the same for the user.
 *
 * @public
 */
export type ServeHandler = (
  /**
   * The name of this app, used to scope and group Inngest functions, or
   * the `Inngest` instance used to declare all functions.
   */
  nameOrInngest: string | Inngest<any>,

  /**
   * A key used to sign requests to and from Inngest in order to prove that the
   * source is legitimate.
   *
   * @link TODO
   */
  signingKey: string,
  functions: InngestFunction<any>[],
  opts?: RegisterOptions
) => any;

/**
 * Serve and register any declared functions with Inngest, making them available
 * to be triggered by events.
 *
 * Can either take an `Inngest` instance and a signing key, or can be used to
 * create custom handlers by passing in an `InngestCommHandler`.
 *
 * @public
 */
export const serve = <Events extends Record<string, EventPayload>>(
  ...args:
    | [
        nameOrInngest: string | Inngest<Events>,
        signingKey: string,
        functions: InngestFunction<Events>[],
        opts?: RegisterOptions
      ]
    | [commHandler: InngestCommHandler]
) => {
  if (args.length === 1) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return args[0].createHandler();
  }

  const [nameOrInngest, signingKey, fns, opts] = args;
  const handler = new InngestCommHandler(nameOrInngest, signingKey, fns, opts);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return handler.createHandler();
};

/**
 * TODO Instead of `createHandler`, expose `createRequest` and `handleResponse`
 *
 * Overriding `createHandler` requires that we always remember crucial steps,
 * e.g. validating signatures, handling POST, etc.
 *
 * We should instead require that new comm handlers override only two functions:
 *
 * `createRequest()`
 * This is the function that is exposed. It must return a valid `HandlerRequest`
 *
 * `handleResponse()`
 * The input is a `StepResponse`, and output can be anything needed for the
 * platform
 *
 * This needs to also account for the ability to validate signatures etc.
 *
 * @public
 */
export class InngestCommHandler {
  public name: string;

  /**
   * The URL of the Inngest function registration endpoint.
   */
  private readonly inngestRegisterUrl: URL;

  protected readonly frameworkName: string = "default";
  protected readonly signingKey: string;

  /**
   * An Axios instance used for communicating with Inngest Cloud.
   *
   * {@link https://npm.im/axios}
   */
  private readonly client: AxiosInstance;

  /**
   * A private collection of functions that are being served. This map is used
   * to find and register functions when interacting with Inngest Cloud.
   */
  private readonly fns: Record<string, InngestFunction<any>> = {};

  constructor(
    nameOrInngest: string | Inngest<any>,
    signingKey: string,
    functions: InngestFunction<any>[],
    { inngestRegisterUrl }: RegisterOptions = {}
  ) {
    this.name =
      typeof nameOrInngest === "string" ? nameOrInngest : nameOrInngest.name;

    this.fns = functions.reduce<Record<string, InngestFunction<any>>>(
      (acc, fn) => {
        if (acc[fn.id]) {
          throw new Error(
            `Duplicate function ID "${fn.id}"; please change a function's name or provide an explicit ID to avoid conflicts.`
          );
        }

        return {
          ...acc,
          [fn.id]: fn,
        };
      },
      {}
    );

    this.inngestRegisterUrl = new URL(
      inngestRegisterUrl || "https://api.inngest.com/fn/register"
    );

    this.signingKey = signingKey;

    this.client = axios.create({
      timeout: 0,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `InngestJS v${version} (${this.frameworkName})`,
      },
      validateStatus: () => true, // all status codes return a response
      maxRedirects: 0,
    });
  }

  // hashedSigningKey creates a sha256 checksum of the signing key with the
  // same signing key prefix.
  private get hashedSigningKey(): string {
    const prefix =
      this.signingKey.match(/^signkey-(test|prod)-/)?.shift() || "";
    const key = Buffer.from(
      this.signingKey.replace(/^signkey-(test|prod)-/, ""),
      "hex"
    );

    // Decode the key from its hex representation into a bytestream
    return `${prefix}${crypto.createHash("sha256").update(key).digest("hex")}`;
  }

  public createHandler(): any {
    return async (req: Request, res: Response, next: NextFunction) => {
      /**
       * Specifically for CORS (browser->site requests), only allow PUT requests
       * from the dashboard.
       */
      if (req.method === "OPTIONS") {
        res.header("Access-Control-Allow-Origin", corsOrigin);
        res.header("Access-Control-Allow-Methods", "PUT");
        res.header("Access-Control-Allow-Headers", "Content-Type");

        return void next();
      }

      const reqUrl = new URL(req.originalUrl, req.hostname);

      switch (req.method) {
        case "PUT": {
          // Push config to Inngest.
          const { status, message } = await this.register(reqUrl);
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
          return void res.sendStatus(405);
      }
    };
  }

  protected async runStep(
    functionId: string,
    stepId: string,
    data: any
  ): Promise<StepRunResponse> {
    try {
      const fn = this.fns[functionId];
      if (!fn) {
        throw new Error(`Could not find function with ID "${functionId}"`);
      }

      const body = await fn["runStep"](stepId, data);

      return {
        status: 200,
        body,
      };
    } catch (err: unknown) {
      if (err instanceof Error) {
        return {
          status: 500,
          error: err.stack || err.message,
        };
      }

      return {
        status: 500,
        error: `Unknown error: ${JSON.stringify(err)}`,
      };
    }
  }

  protected configs(url: URL): FunctionConfig[] {
    return Object.values(this.fns).map((fn) => fn["getConfig"](url));
  }

  protected async register(
    url: URL
  ): Promise<{ status: number; message: string }> {
    const body: RegisterRequest = {
      url: url.href,
      deployType: "ping",
      framework: this.frameworkName,
      appName: this.name,
      functions: this.configs(url),
      sdk: `js:v${version}`,
      v: "0.1",
    };

    const config: AxiosRequestConfig = {
      headers: {
        Authorization: `Bearer ${this.hashedSigningKey}`,
      },
    };

    let res: AxiosResponse<any, any>;

    try {
      res = await this.client.post(this.inngestRegisterUrl.href, body, config);
    } catch (err: unknown) {
      console.error(err);

      return {
        status: 500,
        message: "Failed to register",
      };
    }

    console.log("Registered:", res.status, res.statusText, res.data);

    const { status, error } = z
      .object({
        status: z.number().default(200),
        error: z.string().default("Successfully registered"),
      })
      .parse(res.data || { status: 200, error: "Successfully registered" });

    return { status, message: error };
  }

  protected validateSignature(): boolean {
    return true;
  }

  protected signResponse(): string {
    return "";
  }
}
