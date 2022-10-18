import type { RequestHandler } from "express";
import { Request, NextFunction } from "express"; // interfaces
import httpMocks from "node-mocks-http";

import { InngestCommHandler } from "./express";
import { InngestFunction } from "./components/InngestFunction";
import { InngestStep } from "./components/InngestStep";
import { RegisterRequest, IntrospectRequest } from "./types";

const createNext = (): NextFunction => () => undefined;

describe("InngestCommHandler", () => {
  // Enable testing of protected methods
  class InngestCommHandlerPublic extends InngestCommHandler {
    public override registerBody(url: URL): RegisterRequest {
      return super.registerBody(url);
    }
  }

  describe("registerBody", () => {
    it("Includes correct base URL for functions", () => {
      const fn = new InngestFunction(
        { name: "Test Express Function" },
        { event: "test/event.name" },
        { step: new InngestStep(() => undefined) }
      );
      const ch = new InngestCommHandlerPublic("test-1", [fn], {});

      const url = new URL("http://localhost:8000/api/inngest");

      const body = ch.registerBody(url);
      expect(body.appName).toBe("test-1");
      expect(body.url).toBe("http://localhost:8000/api/inngest");
    });
  });

  describe("createHandler", () => {
    it("Includes correct base URL for functions via introspection", () => {
      const fn = new InngestFunction(
        { name: "Test Express Function" },
        { event: "test/event.name" },
        { step: new InngestStep(() => undefined) }
      );
      const ch = new InngestCommHandler("test-1", [fn], {});
      const handler = ch.createHandler() as RequestHandler;
      // Matches a real-world request using an express app
      const req: Request = httpMocks.createRequest({
        method: "GET",
        protocol: "http",
        hostname: "localhost",
        headers: {
          host: "localhost:3000",
        },
        url: "/api/inngest?introspect=true",
      });
      const res = httpMocks.createResponse();

      handler(req, res, createNext());

      const data = res._getJSONData() as IntrospectRequest;

      expect(data.url).toBe("http://localhost:3000/api/inngest");
      expect(data.framework).toBe("express");
      expect(data.appName).toBe("test-1");
      expect(data.functions).toHaveLength(1);
      expect(data.functions[0]?.name).toBe("Test Express Function");
      expect(data.functions[0]?.steps.step?.runtime.url).toMatch(
        /^http:\/\/localhost:3000\/api\/inngest/
      );

      const httpsReq: Request = httpMocks.createRequest({
        method: "GET",
        protocol: "https",
        hostname: "localhost",
        headers: {
          host: "localhost:3001",
        },
        url: "/api/inngest?introspect=true",
      });
      const httpsRes = httpMocks.createResponse();
      handler(httpsReq, httpsRes, createNext());

      const httpsData = httpsRes._getJSONData() as IntrospectRequest;
      expect(httpsData.url).toBe("https://localhost:3001/api/inngest");
      expect(httpsData.functions[0]?.steps.step?.runtime.url).toMatch(
        /^https:\/\/localhost:3001\/api\/inngest/
      );
    });
  });
});
