import { EventSchemas } from "@local";
import { type ServeHandler } from "@local/components/InngestCommHandler";
import { type IsAny } from "@local/helpers/types";
import { serve } from "@local/next";
import { assertType } from "type-plus";
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
      name: "My App",
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
    serve(inngest, []);
  });
});

describe("ServeHandler", () => {
  test("serve handlers return any", () => {
    assertType<IsAny<ReturnType<ServeHandler>>>(true);
  });
});
