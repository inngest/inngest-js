import { z } from "zod";
import { serve } from "../next";
import { Inngest } from "./Inngest";

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

    const inngest = new Inngest<{
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
