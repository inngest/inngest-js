import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { createDefer } from "./DeferredFunction.ts";
import { Inngest } from "./Inngest.ts";

describe("createDefer ID validation", () => {
  // Reject IDs that break CEL trigger string interpolation
  const client = new Inngest({ id: "test", isDev: true });

  test.each(["foo'bar", "foo\\bar", "foo\nbar", "foo\rbar"])(
    "rejects %j",
    (id) => {
      expect(() => {
        createDefer(client, { id }, async () => {});
      }).toThrowError(`invalid id "${id}"`);
    },
  );

  test.each(["foo-bar", "foo_bar", "foo123", "foo-bar_123", "foo/bar"])(
    "accepts %j",
    (id) => {
      expect(() => {
        createDefer(client, { id }, async () => {});
      }).not.toThrow();
    },
  );
});

test("defer data must be an object", () => {
  const client = new Inngest({ id: "test" });

  const withoutSchema = createDefer(
    client,
    { id: "without-schema" },
    async () => {},
  );
  const withSchema = createDefer(
    client,
    { id: "with-schema", schema: z.object({ msg: z.string() }) },
    async () => {},
  );

  client.createFunction(
    {
      id: "fn",
      triggers: { event: "test" },
    },
    async ({ defer }) => {
      // No schema means `data` is `Record<string, any>`
      defer("without-schema", { function: withoutSchema, data: {} });
      type WithoutSchemaData = Parameters<
        typeof defer<typeof withoutSchema>
      >[1]["data"];
      expectTypeOf<WithoutSchemaData>().not.toBeAny();
      // biome-ignore lint/suspicious/noExplicitAny: no schema = any values
      expectTypeOf<WithoutSchemaData>().toEqualTypeOf<Record<string, any>>();

      // Schema means `data` is the schema type
      defer("with-schema", { function: withSchema, data: { msg: "hi" } });
      type WithSchemaData = Parameters<
        typeof defer<typeof withSchema>
      >[1]["data"];
      expectTypeOf<WithSchemaData>().not.toBeAny();
      expectTypeOf<WithSchemaData>().toEqualTypeOf<{ msg: string }>();
    },
  );
});
