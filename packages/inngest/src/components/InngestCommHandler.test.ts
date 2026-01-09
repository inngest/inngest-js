import { InngestCommHandler } from "../index.ts";
import { serve } from "../next.ts";
import { createClient } from "../test/helpers.ts";

describe("ServeHandler", () => {
  describe("functions argument", () => {
    test("types: allows mutable functions array", () => {
      const inngest = createClient({ id: "test" });

      const functions = [
        inngest.createFunction(
          { id: "test" },
          { event: "demo/event.sent" },
          () => "test",
        ),
      ];

      serve({ client: inngest, functions });
    });

    test("types: allows readonly functions array", () => {
      const inngest = createClient({ id: "test" });

      const functions = [
        inngest.createFunction(
          { id: "test" },
          { event: "demo/event.sent" },
          () => "test",
        ),
      ] as const;

      serve({ client: inngest, functions });
    });
  });
});

describe("#597", () => {
  test("does not mark `fetch` as custom if none given to `new Inngest()`", () => {
    const inngest = createClient({ id: "test" });

    const commHandler = new InngestCommHandler({
      client: inngest,
      frameworkName: "test-framework",
      functions: [],
      handler: () => ({
        body: () => "body",
        headers: () => undefined,
        method: () => "GET",
        url: () => new URL("https://www.inngest.com"),
        transformResponse: (response) => response,
      }),
    });

    expect(commHandler["fetch"]).toBe(inngest["fetch"]);
  });
});
