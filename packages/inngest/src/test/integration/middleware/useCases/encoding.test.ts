import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import {
  BaseSerializerMiddleware,
  isRecord,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

// How Date objects are represented after serialization
const serializedMarker = "__INNGEST_BASE64_SERIALIZER__";
type Serialized = {
  [serializedMarker]: true;
  value: string;
};

function encode(value: unknown): Serialized {
  console.log(value);
  return {
    [serializedMarker]: true,
    value: Buffer.from(JSON.stringify(value)).toString("base64"),
  };
}

function isSerialized(value: unknown): value is Serialized {
  if (!isRecord(value)) {
    return false;
  }
  return Object.hasOwn(value, serializedMarker);
}

test("base64 encoding/decoding middleware", async () => {
  const state = {
    done: false,
    step1Outputs: [] as unknown[],
    step2Outputs: [] as unknown[],
    transformFunctionInputCalls: [] as Middleware.TransformFunctionInputArgs[],
  };

  class EncodingMiddleware extends BaseSerializerMiddleware<Serialized> {
    constructor() {
      super({
        recursive: false,
        deserialize: (value: Serialized): unknown => {
          return JSON.parse(
            Buffer.from(value.value, "base64").toString("utf-8"),
          );
        },
        isSerialized,
        needsSerialize: (value: unknown): boolean => !isSerialized(value),
        serialize: encode,
      });
    }

    // Override so we can capture the pre-transformed args
    override transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ) {
      state.transformFunctionInputCalls.push(arg);
      return super.transformFunctionInput(arg);
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [EncodingMiddleware],
  });

  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step }) => {
      const step1Output = await step.run("step-1", () => {
        return { message: "hello", count: 42 };
      });
      state.step1Outputs.push(step1Output);

      const step2Output = await step.run("step-2", () => {
        return ["a", "b", "c"];
      });
      state.step2Outputs.push(step2Output);

      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  const expectedFnInputArg = {
    ctx: {
      event: expect.any(Object),
      events: [expect.any(Object)],
      step: expect.any(Object),
    },
    steps: {},
  };
  expect(state.transformFunctionInputCalls).toEqual([
    expectedFnInputArg,
    {
      ...expectedFnInputArg,
      steps: {
        cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa: {
          data: {
            [serializedMarker]: true,
            value: "eyJtZXNzYWdlIjoiaGVsbG8iLCJjb3VudCI6NDJ9",
          },
          type: "data",
        },
      },
    },
    {
      ...expectedFnInputArg,
      steps: {
        cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa: {
          data: {
            [serializedMarker]: true,
            value: "eyJtZXNzYWdlIjoiaGVsbG8iLCJjb3VudCI6NDJ9",
          },
          type: "data",
        },
        e64b25e67dec6c8d30e63029286ad7b6d263931d: {
          data: {
            [serializedMarker]: true,
            value: "WyJhIiwiYiIsImMiXQ==",
          },
          type: "data",
        },
      },
    },
  ]);

  expect(state.step1Outputs).toEqual([
    { message: "hello", count: 42 },
    { message: "hello", count: 42 },
  ]);
  expect(state.step2Outputs).toEqual([["a", "b", "c"]]);
});
