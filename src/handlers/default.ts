import { AxiosRequestConfig } from "axios";
import { Request, Response } from "express";
import { z } from "zod";
import { Inngest } from "../components/Inngest";
import {
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
   * The `Inngest` instance used to declare all functions.
   */
  inngest: Inngest<any>,

  /**
   * A key used to sign requests to and from Inngest in order to prove that the
   * source is legitimate.
   *
   * @link TODO
   */
  signingKey: string
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
export const register = (
  ...args:
    | [inngest: Inngest<any>, signingKey: string]
    | [handler: InngestCommHandler]
) => {
  const [inngestOrHandler, signingKey] = args;

  /**
   * Explicitly check all args are what we expect.
   *
   * Let's handle the usual, default flow here.
   */
  if (inngestOrHandler instanceof Inngest && signingKey) {
    return new InngestCommHandler(inngestOrHandler, signingKey).createHandler();
  }

  /**
   * Handle a custom comm handler being passed in.
   */
  if (inngestOrHandler instanceof InngestCommHandler) {
    return inngestOrHandler.createHandler();
  }

  /**
   * Default to throwing if the input is not recognised.
   */
  throw new Error(
    "Failed to create Inngest handler; invalid comm handler or no signing key present"
  );
};

export class InngestCommHandler {
  protected readonly frameworkName: string = "default";
  protected readonly inngest: Inngest<any>;

  constructor(inngest: Inngest<any>, signingKey: string) {
    this.inngest = inngest;
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

  protected runStep(
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

    return this.inngest["runStep"](functionId, stepId, data);
  }

  protected configs(url: URL): FunctionConfig[] {
    return Object.values(this.inngest["fns"]).map((fn) => fn["getConfig"](url));
  }

  protected async register(url: URL): Promise<void> {
    const body = {
      url: url.href,
      hash: "TODO",
    };

    const config: AxiosRequestConfig = {
      headers: {
        Authorization: `Bearer ${this.inngest["apiKey"]}`,
      },
    };

    const res = await this.inngest["client"].post(
      this.inngest["inngestRegisterUrl"].href,
      body,
      config
    );

    console.log(
      "hit the register URL",
      this.inngest["inngestRegisterUrl"].href,
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
      ctx: {
        deployType: "ping",
        framework: this.frameworkName,
        name: this.inngest.name,
      },
      functions: this.configs(url),
      sdk: version,
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
