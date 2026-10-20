/**
 * @module
 * The JSON definitions `toolDefinitions` builds from tools of every kind.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod/v3";
import * as z4 from "zod/v4";

import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { tool, toolDefinitions } from "./tools.ts";

const input = z4.object({ id: z4.string().describe("Customer ID") });
const output = z4.object({ name: z4.string() });

describe("toolDefinitions", () => {
  test("describes tool.step and tool.group with input and output schemas", () => {
    const definitions = toolDefinitions({
      getCustomer: tool.step({
        description: "Looks up a customer",
        input,
        output,
        run: async ({ id }) => {
          return { name: id };
        },
      }),
      refund: tool.group({
        input,
        run: async () => {
          return null;
        },
      }),
    });

    expect(definitions).toEqual([
      {
        name: "getCustomer",
        description: "Looks up a customer",
        input_schema: z4.toJSONSchema(input),
        output_schema: z4.toJSONSchema(output),
      },
      { name: "refund", input_schema: z4.toJSONSchema(input) },
    ]);
  });

  test("a plain function takes any object", () => {
    expect(
      toolDefinitions({
        ping: () => {
          return "pong";
        },
      }),
    ).toEqual([{ name: "ping", input_schema: { type: "object" } }]);
  });

  test("a function uses the schema of its trigger, or any object", () => {
    const client = new Inngest({ id: testClientId });
    const typed = client.createFunction(
      {
        id: "typed",
        triggers: [{ event: "app/typed", schema: input }],
      },
      async () => {},
    );
    const untyped = client.createFunction(
      { id: "untyped", triggers: [{ event: "app/untyped" }] },
      async () => {},
    );

    const [typedDefinition, untypedDefinition] = toolDefinitions({
      typed,
      untyped,
    });

    expect(typedDefinition?.input_schema).toEqual(z4.toJSONSchema(input));
    expect(untypedDefinition?.input_schema).toMatchObject({
      type: "object",
      additionalProperties: {},
    });
  });

  test("uses Standard JSON Schema when the library provides it", () => {
    const schema = {
      "~standard": {
        version: 1,
        vendor: "custom",
        validate: (value: unknown) => {
          return { value };
        },
        jsonSchema: {
          input: () => {
            return { type: "object", properties: { a: { type: "string" } } };
          },
        },
      },
    };

    expect(
      toolDefinitions({
        custom: tool.step({
          input: schema as StandardSchemaV1<unknown>,
          run: async () => {
            return null;
          },
        }),
      })[0]?.input_schema,
    ).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  test("rejects a schema that can only validate", () => {
    expect(() => {
      return toolDefinitions({
        legacy: tool.step({
          input: z.object({ id: z.string() }),
          run: async () => {
            return null;
          },
        }),
      });
    }).toThrow('Tool "legacy" has a schema');
  });
});
