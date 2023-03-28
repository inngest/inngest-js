import { z } from "zod";
import { serve } from "../next";
import { createClient } from "../test/helpers";
import { EventSchemas } from "./EventSchemas";

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
