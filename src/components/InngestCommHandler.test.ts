import { serve } from "@local/next";
import { assertType } from "type-plus";
import { z } from "zod";
import { IsAny } from "../helpers/types";
import { createClient } from "../test/helpers";
import { ServeHandler } from "./InngestCommHandler";

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

    const inngest = createClient<{
      foo: {
        name: "foo";
        data: {
          json: Json;
        };
      };
    }>({ name: "My App" });

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
