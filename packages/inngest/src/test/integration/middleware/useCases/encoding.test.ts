import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../../index.ts";
import { BaseSerializerMiddleware, isRecord } from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

// How Date objects are represented after serialization
const serializedMarker = "__INNGEST_BASE64_SERIALIZER__";
type Serialized = {
  [serializedMarker]: true;
  value: string;
};

function encode(value: unknown): Serialized {
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
  const state = createState({
    step1Outputs: [] as unknown[],
    step2Outputs: [] as unknown[],
    transformFunctionInputCalls: [] as Middleware.TransformFunctionInputArgs[],
  });

  class EncodingMiddleware extends BaseSerializerMiddleware<Serialized> {
    readonly id = "test:encoding";
    protected override readonly recursive = false;

    protected isSerialized(value: unknown): value is Serialized {
      return isSerialized(value);
    }

    protected needsSerialize(value: unknown): boolean {
      return !isSerialized(value);
    }

    protected serialize(value: unknown): Serialized {
      return encode(value);
    }

    protected deserialize(value: Serialized): unknown {
      return JSON.parse(Buffer.from(value.value, "base64").toString("utf-8"));
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
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      const step1Output = await step.run("step-1", () => {
        return { message: "hello", count: 42 };
      });
      state.step1Outputs.push(step1Output);

      const step2Output = await step.run("step-2", () => {
        return ["a", "b", "c"];
      });

      // Force reentry with checkpointing
      await step.sleep("sleep", "1s");

      state.step2Outputs.push(step2Output);
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunFailed();

  const expectedFnInputArg = {
    ctx: {
      attempt: 0,
      maxAttempts: 1,
      event: expect.any(Object),
      events: [expect.any(Object)],
      group: expect.any(Object),
      logger: expect.any(Object),
      runId: expect.any(String),
      step: expect.any(Object),
    },
    fn,
    steps: {},
  };
  expect(state.transformFunctionInputCalls).toEqual([
    expectedFnInputArg,
    {
      ...expectedFnInputArg,
      steps: {
        c3ca5f787365eae0dea86250e27d476406956478: {
          data: null,
          type: "data",
        },
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
