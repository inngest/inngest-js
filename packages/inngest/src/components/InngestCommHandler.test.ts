import { EventSchemas, InngestCommHandler } from "@local";
import { serve } from "@local/next";
import { z } from "zod";
import { createClient } from "../test/helpers";

describe("#153", () => {
  test('does not throw "type instantiation is excessively deep and possibly infinite" for looping type', () => {
    const literalSchema = z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
    ]);
    type Literal = z.infer<typeof literalSchema>;
    type Json = Literal | { [key: string]: Json } | Json[];

    const inngest = createClient({
      id: "My App",
      schemas: new EventSchemas().fromRecord<{
        foo: {
          name: "foo";
          data: {
            json: Json;
          };
        };
      }>(),
    });

    /**
     * This would throw:
     * "Type instantiation is excessively deep and possibly infinite.ts(2589)"
     */
    serve({ client: inngest, functions: [] });
  });
});

describe("ServeHandler", () => {
  describe("functions argument", () => {
    test("types: allows mutable functions array", () => {
      const inngest = createClient({ id: "test" });

      const functions = [
        inngest.createFunction(
          { id: "test" },
          { event: "demo/event.sent" },
          () => "test"
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
          () => "test"
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
