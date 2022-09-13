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

export const register = (
  inngestOrHandler: Inngest<any> | InngestCommHandler
) => {
  const handler =
    inngestOrHandler instanceof Inngest
      ? new InngestCommHandler(inngestOrHandler)
      : inngestOrHandler;

  return handler.createHandler();
};

export class InngestCommHandler {
  protected readonly frameworkName: string = "default";
  protected readonly inngest: Inngest<any>;

  constructor(inngest: Inngest<any>) {
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
