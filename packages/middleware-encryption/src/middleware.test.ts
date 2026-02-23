import { fromPartial } from "@total-typescript/shoehorn";
import { type Context, type EventPayload, Inngest, Middleware } from "inngest";
import {
  type InngestExecution,
  InngestExecutionEngine,
  types,
} from "inngest/internals";
import sodium from "libsodium-wrappers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EncryptionService, encryptionMiddleware } from "./middleware";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows an invoke step input element to its expected shape:
 * `{ payload: { data: Record }, ... }`.
 */
function assertInvokeInput(item: unknown): {
  data: Record<string, unknown>;
  input: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  expect(isRecord(item)).toBe(true);
  const input = item as Record<string, unknown>;

  expect(isRecord(input.payload)).toBe(true);
  const payload = input.payload as Record<string, unknown>;

  expect(isRecord(payload.data)).toBe(true);
  const data = payload.data as Record<string, unknown>;

  return { data, input, payload };
}

const id = "test-client";
const key = "123";
const baseUrl = "https://unreachable.com";
const eventKey = "123";

/** Builds a full encrypted value object with the given ciphertext. */
function encryptedValue(data: string) {
  return {
    [EncryptionService.ENCRYPTION_MARKER]: true,
    [EncryptionService.STRATEGY_MARKER]: "inngest/libsodium",
    data,
  };
}

// Fix the nonce to all zeros so ciphertext is deterministic.
beforeEach(async () => {
  await sodium.ready;
  vi.spyOn(sodium, "randombytes_buf").mockReturnValue(
    // @ts-expect-error - Not sure why it says it should be a string
    new Uint8Array(24)
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("encryptionMiddleware", () => {
  describe("return", () => {
    test("returns a Middleware class", () => {
      const mw = encryptionMiddleware({ key });
      expect(mw.prototype).toBeInstanceOf(Middleware.BaseMiddleware);
    });

    test("requires a key", () => {
      expect(() => {
        // @ts-expect-error
        encryptionMiddleware({});
      }).toThrowError("Missing encryption key");
    });
  });

  describe("client", () => {
    test("encrypts a sent event's field by default", async () => {
      // Sent event data is encrypted if it's within the encryption field.

      let capturedBody: unknown;

      const mockFetch = vi
        .fn()
        .mockImplementation(async (_url: string, init: RequestInit) => {
          capturedBody = JSON.parse(init.body as string)[0];
          return new Response(JSON.stringify({ ids: [], status: 200 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        });

      const inngest = new Inngest({
        id,
        fetch: mockFetch,
        baseUrl,
        eventKey,
        isDev: true,
        middleware: [encryptionMiddleware({ key })],
      });

      await inngest.send({
        name: "my.event",
        data: {
          foo: "bar",
          [EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]: "baz",
        },
      });

      expect(capturedBody).toMatchObject({
        name: "my.event",
        data: expect.objectContaining({
          foo: "bar",
          encrypted: encryptedValue("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEJ7Hz/QEqiQxpiaP5d7Qk0Y0+Ggw"),
        }),
      });
    });
  });

  describe("transformStepInput", () => {  
    // We use `transformStepInput` to encrypt the `step.invoke` input data. Only
    // the encrypted field is encrypted.

    const createMiddleware = (opts?: { decryptOnly?: boolean }) => {
      const MWClass = encryptionMiddleware({ key, ...opts });
      return new MWClass({ client: fromPartial({}) });
    };

    const makeInvokeArgs = (
      data: Record<string, unknown>,
    ): Middleware.TransformStepInputArgs => ({
      functionInfo: { id: "test-fn" },
      stepInfo: { hashedId: "abc123", memoized: false, stepType: "invoke" },
      stepOptions: { id: "my-invoke" },
      input: [
        {
          payload: { data },
          function_id: "child-fn",
        },
      ],
    });

    test("encrypts the encrypted field of invoke step input", async () => {
      const mw = createMiddleware();
      const result = await mw.transformStepInput!(
        makeInvokeArgs({
          [EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]: {
            secret: "sensitive",
          },
          public_field: "visible",
        }),
      );

      const { data, input } = assertInvokeInput(result.input[0]);

      expect(data[EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]).toEqual(
        encryptedValue("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2+kZLev1qrdUWyNW9Yp8/R906ndxH/oWdfc4fGcuc1adxjjPd14="),
      );
      expect(data.public_field).toBe("visible");
      expect(input.function_id).toBe("child-fn");
    });

    test("does not encrypt non-invoke step input", async () => {
      const mw = createMiddleware();
      const arg: Middleware.TransformStepInputArgs = {
        functionInfo: { id: "test-fn" },
        stepInfo: { hashedId: "abc123", memoized: false, stepType: "run" },
        stepOptions: { id: "my-step" },
        input: [{ some: "data" }],
      };

      const result = await mw.transformStepInput!(arg);
      expect(result.input).toEqual([{ some: "data" }]);
    });

    test("skips encryption when decryptOnly is set", async () => {
      const mw = createMiddleware({ decryptOnly: true });
      const arg = makeInvokeArgs({
        [EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]: {
          secret: "sensitive",
        },
      });

      const result = await mw.transformStepInput!(arg);
      const { data } = assertInvokeInput(result.input[0]);

      expect(
        data[EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD],
      ).toEqual({ secret: "sensitive" });
    });

    test("handles invoke input with no payload data", async () => {
      const mw = createMiddleware();
      const arg: Middleware.TransformStepInputArgs = {
        functionInfo: { id: "test-fn" },
        stepInfo: { hashedId: "abc123", memoized: false, stepType: "invoke" },
        stepOptions: { id: "my-invoke" },
        input: [{ function_id: "child-fn" }],
      };

      const result = await mw.transformStepInput!(arg);
      expect(result.input).toEqual([{ function_id: "child-fn" }]);
    });
  });

  describe("wrapStep", () => {
    // We use `wrapStep` to decrypt memoized step data before returning it to
    // the Inngest function handler.

    const createMiddleware = () => {
      const MWClass = encryptionMiddleware({ key });
      return new MWClass({ client: fromPartial({}) });
    };

    test("decrypts an encrypted step value", async () => {
      const mw = createMiddleware();
      const result = await mw.wrapStep!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        stepInfo: fromPartial({ hashedId: "abc", stepType: "run" }),
        next: async () =>
          encryptedValue(
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqoWTR/0k6BfX8DaaPQCX6h90/319T6VAMaJ1LX8=",
          ),
      });

      expect(result).toEqual({ foo: "foo" });
    });

    test("passes through non-encrypted values unchanged", async () => {
      const mw = createMiddleware();
      const plainValue = { foo: "bar" };
      const result = await mw.wrapStep!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        stepInfo: fromPartial({ hashedId: "abc", stepType: "run" }),
        next: async () => plainValue,
      });

      expect(result).toEqual(plainValue);
    });

    test("passes through null/undefined unchanged", async () => {
      const mw = createMiddleware();
      const result = await mw.wrapStep!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        stepInfo: fromPartial({ hashedId: "abc", stepType: "run" }),
        next: async () => null,
      });

      expect(result).toBeNull();
    });
  });

  describe("wrapStepHandler", () => {
    // We use `wrapStepHandler` to encrypt the step output before sending it to
    // the Inngest server.

    const createMiddleware = (opts?: { decryptOnly?: boolean }) => {
      const MWClass = encryptionMiddleware({ key, ...opts });
      return new MWClass({ client: fromPartial({}) });
    };

    test("encrypts step output", async () => {
      const mw = createMiddleware();
      const result = await mw.wrapStepHandler!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        stepInfo: fromPartial({ hashedId: "abc", stepType: "run" }),
        next: async () => ({ foo: "foo" }),
      });

      expect(result).toEqual(
        encryptedValue(
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqoWTR/0k6BfX8DaaPQCX6h90/319T6VAMaJ1LX8=",
        ),
      );
    });

    test("skips encryption when decryptOnly is set", async () => {
      const mw = createMiddleware({ decryptOnly: true });
      const result = await mw.wrapStepHandler!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        stepInfo: fromPartial({ hashedId: "abc", stepType: "run" }),
        next: async () => ({ foo: "foo" }),
      });

      expect(result).toEqual({ foo: "foo" });
    });

    test("passes through null output unchanged", async () => {
      const mw = createMiddleware();
      const result = await mw.wrapStepHandler!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        stepInfo: fromPartial({ hashedId: "abc", stepType: "run" }),
        next: async () => null,
      });

      expect(result).toBeNull();
    });
  });

  describe("wrapFunctionHandler", () => {
    // We use `wrapFunctionHandler` to encrypt the function's return value
    // before sending it to the Inngest server.

    const createMiddleware = (opts?: { decryptOnly?: boolean }) => {
      const MWClass = encryptionMiddleware({ key, ...opts });
      return new MWClass({ client: fromPartial({}) });
    };

    test("encrypts function output", async () => {
      const mw = createMiddleware();
      const result = await mw.wrapFunctionHandler!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        next: async () => ({ result: "success" }),
      });

      expect(result).toEqual(
        encryptedValue(
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAobtxMwl9w3ptJNgN0dgMSh9063dhGPMWdfc4fHcjY1qa3GzX",
        ),
      );
    });

    test("skips encryption when decryptOnly is set", async () => {
      const mw = createMiddleware({ decryptOnly: true });
      const result = await mw.wrapFunctionHandler!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        next: async () => ({ result: "success" }),
      });

      expect(result).toEqual({ result: "success" });
    });

    test("passes through null output unchanged", async () => {
      const mw = createMiddleware();
      const result = await mw.wrapFunctionHandler!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        next: async () => null,
      });

      expect(result).toBeNull();
    });
  });

  describe("spec", () => {
    const runSpecs = (specs: Specification[]) => {
      for (const spec of specs) {
        if (spec.todo) {
          test.todo(spec.name);
        }

        test(spec.name, async () => {
          if (!spec.result && !spec.rawOutput) {
            throw new Error("Missing result or rawOutput in spec");
          }

          const result = await runFn({ spec });
          if (spec.result) {
            expect(result.execResult).toMatchObject(spec.result);
          }

          if (spec.rawOutput) {
            expect(result.rawOutput).toEqual(spec.rawOutput);
          }
        });
      }
    };

    describe("step encryption", () => {
      const fn: Specification["fn"] = async ({ step }) => {
        const foo = await step.run("foo", () => {
          return { foo: "foo" };
        });

        const bar = await step.run("bar", () => {
          return { foowas: foo, bar: "bar" };
        });

        return { foo, bar };
      };

      const stepIds = {
        foo: InngestExecutionEngine._internals.hashId("foo"),
        bar: InngestExecutionEngine._internals.hashId("bar"),
      };

      runSpecs([
        {
          name: "encrypts a run step",
          fn,
          result: {
            type: "step-ran",
            step: fromPartial({
              data: encryptedValue("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAqoWTR/0k6BfX8DaaPQCX6h90/319T6VAMaJ1LX8="),
            }),
          },
        },
        {
          name: "decrypts and encrypts a following step",
          fn,
          result: {
            type: "step-ran",
            step: fromPartial({
              data: encryptedValue("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApXSiQuI7cfB5cr/m6zrIHB90/319Gv4RdfdhLWQvbx3TjSjFOgEog8oHWZkxYQWWMP9y/g=="),
            }),
          },
          steps: {
            [stepIds.foo]: {
              id: stepIds.foo,
              data: encryptedValue("OO3gyBNd7yWI2BIVI4sFwH/+iYwB+Vo/PG8HjNE/+iwwg0KDaxmlWElMNYw7YZnsmitPkos="),
              // data: {
              //   [EncryptionService.ENCRYPTION_MARKER]: true,
              //   [EncryptionService.STRATEGY_MARKER]: "libsodium",
              //   data: "OO3gyBNd7yWI2BIVI4sFwH/+iYwB+Vo/PG8HjNE/+iwwg0KDaxmlWElMNYw7YZnsmitPkos=",
              // },
            },
          },
        },
        {
          name: "returns encrypted data",
          fn,
          result: {
            type: "function-resolved",
            data: encryptedValue("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1tvYhpsJFXsb6vUy4wpe/B90/319T6UZdat1YCB6IlmGwGzXeQE3zppHApAxPUibJuwjoUMDZyqzi8ELEegKTfHWlcFCHxAz5oHCCFeU0mc="),
          },
          rawOutput: {
            foo: { foo: "foo" },
            bar: { foowas: { foo: "foo" }, bar: "bar" },
          },

          steps: {
            [stepIds.foo]: {
              id: stepIds.foo,
              data: {
                [EncryptionService.ENCRYPTION_MARKER]: true,
                [EncryptionService.STRATEGY_MARKER]: "libsodium",
                data: "OO3gyBNd7yWI2BIVI4sFwH/+iYwB+Vo/PG8HjNE/+iwwg0KDaxmlWElMNYw7YZnsmitPkos=",
              },
            },
            [stepIds.bar]: {
              id: stepIds.bar,
              data: {
                [EncryptionService.ENCRYPTION_MARKER]: true,
                [EncryptionService.STRATEGY_MARKER]: "libsodium",
                data: "9mVeJCrWDEcurAb6sDlELJtg9y51wcuR/IjLoAB2CnPGA3MOLa4ae9KuSWzpvqmy3Idm3Fjo++m6qlZmhLHI9qr9HSCRah0QisELHQ==",
              },
            },
          },
        },
      ]);
    });
  });
});

type Specification = {
  name: string;
  todo?: boolean;
  steps?: InngestExecution.InngestExecutionOptions["stepState"];
  events?: [EventPayload, ...EventPayload[]];
  fn: (ctx: Context) => unknown;

  /**
   * The result of the execution as it will be sent back to Inngest.
   */
  result?: Partial<InngestExecution.ExecutionResult>;

  /**
   * The raw output from the user's function, before any potential encryption.
   */
  rawOutput?: unknown;
};

const runFn = async ({
  spec: {
    fn: specFn,
    steps = {},
    events = [{ name: "my-event", data: { foo: "bar" } }],
  },
}: {
  spec: Specification;
}): Promise<{
  execResult: InngestExecution.ExecutionResult;
  rawOutput: unknown;
}> => {
  const inngest = new Inngest({
    id: "test-client",
    middleware: [encryptionMiddleware({ key })],
  });

  let rawOutput: unknown;

  const testFn = async (ctx: Context) => {
    rawOutput = await specFn(ctx);
    return rawOutput;
  };

  const fn = inngest.createFunction(
    { id: "my-fn", triggers: [{ event: "my-event" }] },
    testFn,
  );

  const runId = "test-run";

  const execution = fn["createExecution"]({
    partialOptions: {
      client: fn["client"],
      data: {
        attempt: 0,
        event: events[0],
        events: events,
        runId,
      },
      stepState: steps,
      runId,
      stepCompletionOrder: Object.keys(steps),
      reqArgs: [],
      headers: {},
      stepMode: types.StepMode.Async,
    },
  });

  const execResult = await execution.start();

  return { execResult, rawOutput };
};
