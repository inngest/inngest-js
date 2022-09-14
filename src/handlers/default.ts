import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import { Request, Response } from "express";
import { z } from "zod";
import { Inngest } from "../components/Inngest";
import { InngestFunction } from "../components/InngestFunction";
import {
  ClientOptions,
  EventPayload,
  FunctionConfig,
  RegisterPingResponse,
  StepRunResponse,
} from "../types";
import { version } from "../version";

/**
 * A handler for registering Inngest functions. This type should be used
 * whenever a handler for a new framework is being added to enforce that the
 * registration process is always the same for the user.
 */
export type RegisterHandler = (
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
  opts?: ClientOptions
) => any;

/**
 * Register any declared functions with Inngest, making them available to be
 * triggered by events.
 *
 * Can either take an `Inngest` instance and a signing key, or can be used to
 * create custom handlers by passing in an `InngestCommHandler`.
 *
 * @link TODO
 */
export const register = <Events extends Record<string, EventPayload>>(
  ...args:
    | [
        nameOrInngest: string | Inngest<Events>,
        signingKey: string,
        functions: InngestFunction<Events>[],
        opts?: ClientOptions
      ]
    | [commHandler: InngestCommHandler]
) => {
  if (args.length === 1) {
    return args[0].createHandler();
  }

  const [nameOrInngest, signingKey, fns, opts] = args;
  const handler = new InngestCommHandler(nameOrInngest, signingKey, fns, opts);

  return handler.createHandler();
};

export class InngestCommHandler {
  public name: string;

  /**
   * Base URL for Inngest Cloud.
   */
  private readonly inngestBaseUrl: URL;

  /**
   * The URL of the Inngest function registration endpoint.
   */
  private readonly inngestRegisterUrl: URL;

  protected readonly frameworkName: string = "default";
  protected readonly signingKey: string;

  /**
   * An Axios instance used for communicating with Inngest Cloud.
   *
   * @link https://npm.im/axios
   */
  private readonly client: AxiosInstance;

  /**
   * A private collection of functions that have been registered. This map is
   * used to find and register functions when interacting with Inngest Cloud.
   */
  private readonly fns: Record<string, InngestFunction<any>> = {};

  constructor(
    nameOrInngest: string | Inngest<any>,
    signingKey: string,
    functions: InngestFunction<any>[],
    { inngestBaseUrl }: ClientOptions = {}
  ) {
    this.name =
      typeof nameOrInngest === "string" ? nameOrInngest : nameOrInngest.name;

    this.fns = functions.reduce((acc, fn) => {
      return {
        ...acc,
        [fn.name]: fn,
      };
    }, {});

    this.inngestBaseUrl = new URL(
      inngestBaseUrl ||
        (nameOrInngest instanceof Inngest
          ? nameOrInngest.inngestBaseUrl
          : "https://inn.gs/")
    );

    this.inngestRegisterUrl = new URL("x/register", this.inngestBaseUrl);
    this.signingKey = signingKey;

    this.client = axios.create({
      timeout: 0,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `InngestJS v${version}`,
      },
      validateStatus: () => true, // all status codes return a response
      maxRedirects: 0,
    });
  }

  public createHandler(): any {
    return async (req: Request, res: Response) => {
      console.log("Something hit the default handler!");

      const reqUrl = new URL(req.originalUrl, req.hostname);

      switch (req.method) {
        case "PUT":
          console.log("It was a PUT request");
          // Push config to Inngest.
          await this.register(reqUrl);
          return void res.sendStatus(200);

        case "GET":
          console.log("It was a GET request");
          // Inngest is asking for config; confirm signed and send.
          this.validateSignature(); //TODO
          const pingRes = this.pong(reqUrl);
          this.signResponse(); // TODO
          return void res.json(pingRes);

        case "POST":
          console.log("It was a POST request");
          // Inngest is trying to run a step; confirm signed and run.
          const { fnId, stepId } = z
            .object({
              fnId: z.string().min(1),
              stepId: z.string().min(1),
            })
            .parse({
              fnId: req.query.fnId,
              stepId: req.query.stepId,
            });

          const stepRes = await this.runStep(fnId, stepId, req.body);

          return void res.json(stepRes);

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
    console.log(
      "Trying to run step",
      stepId,
      "in function",
      functionId,
      "with data",
      data
    );

    try {
      const fn = this.fns[functionId];
      if (!fn) {
        throw new Error(`Could not find function with ID "${functionId}"`);
      }

      const body = await fn["runStep"](stepId, data);

      return {
        status: 200,
        body: JSON.stringify(body),
      };
    } catch (err: any) {
      return {
        status: 500,
        error: err.stack || err.message,
      };
    }
  }

  protected configs(url: URL): FunctionConfig[] {
    return Object.values(this.fns).map((fn) => fn["getConfig"](url));
  }

  protected async register(url: URL): Promise<void> {
    const body = {
      url: url.href,
      hash: "TODO",
    };

    const config: AxiosRequestConfig = {
      headers: {
        Authorization: `Bearer ${this.signingKey}`,
      },
    };

    const res = await this.client.post(
      this.inngestRegisterUrl.href,
      body,
      config
    );

    console.log(
      "hit the register URL",
      this.inngestRegisterUrl.href,
      "with:",
      body,
      "and",
      config,
      "and got back:",
      res.status,
      res.data
    );
  }

  protected pong(url: URL): RegisterPingResponse {
    return {
      deployType: "ping",
      framework: this.frameworkName,
      appName: this.name,
      functions: this.configs(url),
      sdk: `js:v${version}`,
      v: "0.1",
    };
  }

  protected validateSignature(): boolean {
    return true;
  }

  protected signResponse(): string {
    return "";
  }
}
