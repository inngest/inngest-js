import { Inngest } from "./components/Inngest";
import { InngestCommHandler } from "./components/InngestCommHandler";
import { InngestFunction } from "./components/InngestFunction";
import * as ExpressHandler from "./express";
import { testFramework } from "./test/helpers";
import { RegisterRequest } from "./types";

testFramework("Express", ExpressHandler);

describe("InngestCommHandler", () => {
  // Enable testing of protected methods
  class InngestCommHandlerPublic extends InngestCommHandler<any, any> {
    public override registerBody(url: URL): RegisterRequest {
      return super.registerBody(url);
    }
  }

  describe("registerBody", () => {
    it("Includes correct base URL for functions", () => {
      const fn = new InngestFunction(
        new Inngest({ name: "test" }),
        { name: "Test Express Function" },
        { event: "test/event.name" },
        () => undefined
      );
      const ch = new InngestCommHandlerPublic(
        "test-framework",
        "test-1",
        [fn],
        {},
        () => undefined,
        () => undefined
      );

      const url = new URL("http://localhost:8000/api/inngest");

      const body = ch.registerBody(url);
      expect(body.appName).toBe("test-1");
      expect(body.url).toBe("http://localhost:8000/api/inngest");
    });
  });
});
