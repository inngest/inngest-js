import * as FastifyHandler from "@local/fastify";
import { fromAny } from "@total-typescript/shoehorn";
import { type Response } from "express";
import { type FastifyReply, type FastifyRequest } from "fastify";
import { testFramework } from "./test/helpers";

class MockFastifyReply {
  constructor(public res: Response) {}

  public header(key: string, value: string) {
    this.res.header(key, value);
  }

  public code(code: number) {
    this.res.statusCode = code;
  }

  public send(body: unknown) {
    this.res.send(body);
  }
}

testFramework("Fastify", FastifyHandler, {
  transformReq: (req, res): [req: FastifyRequest, reply: FastifyReply] => {
    return [fromAny(req), fromAny(new MockFastifyReply(res))];
  },
});
