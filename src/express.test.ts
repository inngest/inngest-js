import { Inngest } from "./components/Inngest";
import { InngestCommHandler } from "./components/InngestCommHandler";
import * as ExpressHandler from "./express";
import { testFramework } from "./test/helpers";

testFramework("Express", ExpressHandler);

describe("InngestCommHandler", () => {
  describe("registerBody", () => {
    it("Includes correct base URL for functions", () => {
      const client = new Inngest({ name: "test" });

      const fn = client.createFunction(
        { name: "Test Express Function" },
        { event: "test/event.name" },
        () => undefined
      );
      const ch = new InngestCommHandler(
        "test-framework",
        "test-1",
        [fn],
        {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return
        () => undefined as unknown as any,
        () => undefined
      );

      const url = new URL("http://localhost:8000/api/inngest");

      const body = ch["registerBody"](url);
      expect(body.appName).toBe("test-1");
      expect(body.url).toBe("http://localhost:8000/api/inngest");
    });
  });
});
