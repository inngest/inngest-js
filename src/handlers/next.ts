import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";
import {
  InngestCommHandler,
  register as defaultRegister,
  RegisterHandler,
} from "./default";

class NextCommHandler extends InngestCommHandler {
  protected override frameworkName = "nextjs";

  public override createHandler() {
    return async (req: NextApiRequest, res: NextApiResponse) => {
      let reqUrl: URL;

      try {
        reqUrl = new URL(req.url as string, `https://${req.headers.host}`);
      } catch (err) {
        return void res.status(500).json(err);
      }

      switch (req.method) {
        case "PUT":
          console.log("It was a PUT request");
          // Push config to Inngest.
          await this.register(reqUrl);
          return void res.status(200).end();

        case "GET":
          console.log("It was a GET request");
          // Inngest is asking for config; confirm signed and send.
          this.validateSignature(); //TODO
          const pingRes = this.pong(reqUrl);
          this.signResponse(); // TODO
          return void res.status(200).json(pingRes);

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
          return void res.status(405).end();
      }
    };
  }
}

export const register: RegisterHandler = (
  nameOrInngest,
  signingKey,
  fns,
  opts
) => {
  return defaultRegister(
    new NextCommHandler(nameOrInngest, signingKey, fns, opts)
  );
};
