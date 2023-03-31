import { EventSchemas } from "@local";
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

    const inngest = createClient({
      name: "My App",
      schemas: new EventSchemas().fromTypes<{
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
