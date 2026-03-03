import { fromPartial } from "@total-typescript/shoehorn";
import { type Context, type EventPayload, Inngest, Middleware } from "inngest";
import {
  type InngestExecution,
  InngestExecutionEngine,
  types,
} from "inngest/internals";
import { describe, expect, test, vi } from "vitest";
import { EncryptionService, encryptionMiddleware } from "./middleware";
import { LibSodiumEncryptionService } from "./strategies/libSodium";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows an invoke step input element to its expected shape.
 * Throws with a clear message if the structure doesn't match.
 */
function assertInvokeInput(item: unknown): {
  data: Record<string, unknown>;
  input: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  if (!isRecord(item)) {
    throw new Error(`Expected record, got ${typeof item}`);
  }

  if (!isRecord(item.payload)) {
    throw new Error("Expected item.payload to be a record");
  }

  if (!isRecord(item.payload.data)) {
    throw new Error("Expected item.payload.data to be a record");
  }

  return { data: item.payload.data, input: item, payload: item.payload };
}

const key = "123";

/** Matches any value with the encrypted envelope shape. */
function encryptedShape() {
  return expect.objectContaining({
    [EncryptionService.ENCRYPTION_MARKER]: true,
    [EncryptionService.STRATEGY_MARKER]: expect.any(String),
    data: expect.any(String),
  });
}

/** Encrypts a value directly using the test key's LibSodium service. */
async function encryptTestValue(
  value: unknown,
): Promise<Record<string, unknown>> {
  const service = new LibSodiumEncryptionService([key]);
  const data = await service.encrypt(value);

  return {
    [EncryptionService.ENCRYPTION_MARKER]: true,
    [EncryptionService.STRATEGY_MARKER]: service.identifier,
    data,
  };
}

/**
 * Asserts that a value has the encrypted envelope shape and round-trip
 * decrypts to the expected plaintext.
 */
async function expectEncrypted(
  actual: unknown,
  expectedPlaintext: unknown,
): Promise<void> {
  expect(actual).toEqual(encryptedShape());

  if (!isRecord(actual) || typeof actual.data !== "string") {
    throw new Error("Encrypted value missing string `data` field");
  }

  const service = new LibSodiumEncryptionService([key]);
  const decrypted = await service.decrypt(actual.data);
  expect(decrypted).toEqual(expectedPlaintext);
}

// --- Execution engine test utilities ---

const runFn = async ({
  fn: specFn,
  steps = {},
  events = [{ name: "my-event", data: { foo: "bar" } }],
}: {
  fn: (ctx: Context) => unknown;
  steps?: InngestExecution.InngestExecutionOptions["stepState"];
  events?: [EventPayload, ...EventPayload[]];
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

  describe("transformFunctionInput", () => {
    const createMiddleware = () => {
      const MWClass = encryptionMiddleware({ key });
      return new MWClass({ client: fromPartial({}) });
    };

    test("decrypts encrypted fields in event data", async () => {
      const mw = createMiddleware();
      const encField = await encryptTestValue({ foo: "foo" });

      const result = await mw.transformFunctionInput!({
        ctx: fromPartial({
          event: {
            name: "test.event",
            data: {
              public_field: "visible",
              encrypted: encField,
            },
          },
          events: [],
        }),
        functionInfo: { id: "test-fn" },
        steps: {},
      });

      expect(result.ctx.event.data).toEqual({
        public_field: "visible",
        encrypted: { foo: "foo" },
      });
    });

    test("decrypts encrypted fields across all events", async () => {
      const mw = createMiddleware();
      const encField = await encryptTestValue({ foo: "foo" });

      const result = await mw.transformFunctionInput!({
        ctx: fromPartial({
          event: {
            name: "test.event",
            data: { encrypted: encField },
          },
          events: [
            { name: "test.event", data: { encrypted: encField } },
            { name: "test.event.2", data: { encrypted: encField } },
          ],
        }),
        functionInfo: { id: "test-fn" },
        steps: {},
      });

      for (const event of result.ctx.events!) {
        expect(event.data).toEqual({ encrypted: { foo: "foo" } });
      }
    });

    test("passes through events with no data", async () => {
      const mw = createMiddleware();
      const result = await mw.transformFunctionInput!({
        ctx: fromPartial({
          event: { name: "test.event" },
          events: [],
        }),
        functionInfo: { id: "test-fn" },
        steps: {},
      });

      expect(result.ctx.event.data).toBeUndefined();
    });
  });

  describe("transformStepInput", () => {
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

      await expectEncrypted(
        data[EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD],
        { secret: "sensitive" },
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

      expect(data[EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]).toEqual({
        secret: "sensitive",
      });
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
    const createMiddleware = () => {
      const MWClass = encryptionMiddleware({ key });
      return new MWClass({ client: fromPartial({}) });
    };

    test("decrypts an encrypted step value", async () => {
      const mw = createMiddleware();
      const encrypted = await encryptTestValue({ foo: "foo" });

      const result = await mw.wrapStep!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        stepInfo: fromPartial({ hashedId: "abc", stepType: "run" }),
        next: async () => encrypted,
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

    test("passes through null unchanged", async () => {
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
    const createMiddleware = (opts?: { decryptOnly?: boolean }) => {
      const MWClass = encryptionMiddleware({ key, ...opts });
      return new MWClass({ client: fromPartial({}) });
    };

    test("encrypts step output", async () => {
      const mw = createMiddleware();
      const original = { foo: "foo" };

      const result = await mw.wrapStepHandler!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        stepInfo: fromPartial({ hashedId: "abc", stepType: "run" }),
        next: async () => original,
      });

      await expectEncrypted(result, original);
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
  });

  describe("wrapFunctionHandler", () => {
    const createMiddleware = (opts?: { decryptOnly?: boolean }) => {
      const MWClass = encryptionMiddleware({ key, ...opts });
      return new MWClass({ client: fromPartial({}) });
    };

    test("encrypts function output", async () => {
      const mw = createMiddleware();
      const original = { result: "success" };

      const result = await mw.wrapFunctionHandler!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        next: async () => original,
      });

      await expectEncrypted(result, original);
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

  describe("transformSendEvent", () => {
    const createMiddleware = (opts?: { decryptOnly?: boolean }) => {
      const MWClass = encryptionMiddleware({ key, ...opts });
      return new MWClass({ client: fromPartial({}) });
    };

    test("encrypts the encrypted field of outgoing events", async () => {
      const mw = createMiddleware();
      const result = await mw.transformSendEvent!({
        events: [
          {
            name: "my.event",
            data: {
              public_field: "visible",
              [EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]: {
                secret: "data",
              },
            },
          },
        ],
        functionInfo: null,
      });

      const data = result.events[0].data!;
      expect(data.public_field).toBe("visible");
      await expectEncrypted(
        data[EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD],
        { secret: "data" },
      );
    });

    test("skips encryption when decryptOnly is set", async () => {
      const mw = createMiddleware({ decryptOnly: true });
      const result = await mw.transformSendEvent!({
        events: [
          {
            name: "my.event",
            data: {
              [EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]: {
                secret: "data",
              },
            },
          },
        ],
        functionInfo: null,
      });

      expect(result.events[0].data).toEqual({
        [EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]: { secret: "data" },
      });
    });

    test("round-trip: encrypt via transformSendEvent, decrypt via transformFunctionInput", async () => {
      const mw = createMiddleware();

      const sendResult = await mw.transformSendEvent!({
        events: [
          {
            name: "my.event",
            data: {
              public_field: "visible",
              [EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]: {
                secret: "data",
              },
            },
          },
        ],
        functionInfo: null,
      });

      const encryptedEvent = sendResult.events[0];

      const inputResult = await mw.transformFunctionInput!({
        ctx: fromPartial({
          event: encryptedEvent,
          events: [encryptedEvent],
        }),
        functionInfo: { id: "test-fn" },
        steps: {},
      });

      expect(inputResult.ctx.event.data).toEqual({
        public_field: "visible",
        [EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]: { secret: "data" },
      });
    });
  });

  describe("eventEncryptionField", () => {
    test("encrypts only the custom field when eventEncryptionField is set", async () => {
      const MWClass = encryptionMiddleware({
        key,
        eventEncryptionField: "secret_data",
      });
      const mw = new MWClass({ client: fromPartial({}) });

      const result = await mw.transformSendEvent!({
        events: [
          {
            name: "my.event",
            data: {
              secret_data: { secret: "value" },
              [EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]:
                "not-encrypted",
            },
          },
        ],
        functionInfo: null,
      });

      const data = result.events[0].data!;
      expect(data.secret_data).toEqual(encryptedShape());
      expect(data[EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]).toBe(
        "not-encrypted",
      );
    });
  });

  describe("fallbackDecryptionKeys", () => {
    test("decrypts with a fallback key after key rotation", async () => {
      const OriginalMW = encryptionMiddleware({ key: "original-key" });
      const originalMw = new OriginalMW({ client: fromPartial({}) });

      const encrypted = await originalMw.wrapStepHandler!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        stepInfo: fromPartial({ hashedId: "abc", stepType: "run" }),
        next: async () => ({ secret: "data" }),
      });

      const RotatedMW = encryptionMiddleware({
        key: "new-key",
        fallbackDecryptionKeys: ["original-key"],
      });
      const rotatedMw = new RotatedMW({ client: fromPartial({}) });

      const decrypted = await rotatedMw.wrapStep!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        stepInfo: fromPartial({ hashedId: "abc", stepType: "run" }),
        next: async () => encrypted,
      });

      expect(decrypted).toEqual({ secret: "data" });
    });
  });

  describe("custom encryptionService", () => {
    test("uses a custom encryption service for encrypt and decrypt", async () => {
      class MockService extends EncryptionService {
        public identifier = "mock/test";

        public async encrypt(value: unknown): Promise<string> {
          return `mock:${JSON.stringify(value)}`;
        }

        public async decrypt(value: string): Promise<unknown> {
          return JSON.parse(value.replace(/^mock:/, ""));
        }
      }

      const MWClass = encryptionMiddleware({
        key,
        encryptionService: new MockService(),
      });
      const mw = new MWClass({ client: fromPartial({}) });

      // Encrypt via wrapStepHandler
      const encrypted = await mw.wrapStepHandler!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        stepInfo: fromPartial({ hashedId: "abc", stepType: "run" }),
        next: async () => ({ data: "test" }),
      });

      expect(encrypted).toMatchObject({
        [EncryptionService.ENCRYPTION_MARKER]: true,
        [EncryptionService.STRATEGY_MARKER]: "mock/test",
      });

      // Decrypt via wrapStep
      const decrypted = await mw.wrapStep!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        stepInfo: fromPartial({ hashedId: "abc", stepType: "run" }),
        next: async () => encrypted,
      });

      expect(decrypted).toEqual({ data: "test" });
    });
  });

  describe("double encryption warning", () => {
    test("warns when encrypting an already-encrypted value", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const MWClass = encryptionMiddleware({ key });
      const mw = new MWClass({ client: fromPartial({}) });

      const alreadyEncrypted = await encryptTestValue({ some: "data" });

      await mw.wrapStepHandler!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        stepInfo: fromPartial({ hashedId: "abc", stepType: "run" }),
        next: async () => alreadyEncrypted,
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("already encrypted"),
      );
    });
  });

  describe("legacyV0Service", () => {
    test("round-trips with legacy V0 encryption when forceEncryptWithV0 is set", async () => {
      const MWClass = encryptionMiddleware({
        key,
        legacyV0Service: { forceEncryptWithV0: true },
      });
      const mw = new MWClass({ client: fromPartial({}) });

      const original = { secret: "data" };

      const encrypted = await mw.wrapStepHandler!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        stepInfo: fromPartial({ hashedId: "abc", stepType: "run" }),
        next: async () => original,
      });

      // V0 format: has __ENCRYPTED__ but not __STRATEGY__
      expect(encrypted).toMatchObject({
        [EncryptionService.ENCRYPTION_MARKER]: true,
        data: expect.any(String),
      });
      expect(encrypted).not.toHaveProperty(EncryptionService.STRATEGY_MARKER);

      // V0 decryption path round-trips correctly
      const decrypted = await mw.wrapStep!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        stepInfo: fromPartial({ hashedId: "abc", stepType: "run" }),
        next: async () => encrypted,
      });

      expect(decrypted).toEqual(original);
    });
  });

  /**
   * Cross-version compatibility tests using hardcoded encrypted payloads.
   *
   * These fixtures were generated using the v3 encryption format (which is
   * identical to the raw LibSodium/AES output). If key derivation, base64
   * encoding, or the envelope format ever drifts, these tests will catch it.
   */
  describe("cross-version compatibility", () => {
    const fixtureKey = "test-fixture-key";

    // Generated with LibSodiumEncryptionService using fixtureKey
    const libSodiumFixture = {
      plaintext: { hello: "world", nested: { num: 42 } },
      envelope: {
        [EncryptionService.ENCRYPTION_MARKER]: true,
        [EncryptionService.STRATEGY_MARKER]: "inngest/libsodium",
        data: "pSiSWo5S7sref48gdYmMkyJW9UmqFMDbmmVULbtmKFRHlWIoa52qb7CINe3cXmT5X8bvLfsg20S+6qLTzAMK7GPrcSPdYcFYI3IiYGY=",
      },
    };

    // Generated with AESEncryptionService (v0 legacy) using fixtureKey
    const aesV0Fixture = {
      plaintext: { secret: "v0-data", count: 99 },
      envelope: {
        [EncryptionService.ENCRYPTION_MARKER]: true,
        data: "U2FsdGVkX1/2ji5c3rSBYndk4+QMtYtyP9fB1lwFVqIq7F9nqMz47d1A/W9qGA9F",
      },
    };

    // Generated with LibSodiumEncryptionService for an event's encrypted field
    const eventFixture = {
      plaintext: { userId: "usr_123", plan: "enterprise" },
      encryptedData:
        "q3FWFqO1qIEXK/u9ullLh+rJbxVrHWJ+6VZAsGjc6cWdnP28KSb6Z0NqN+nDyAHZXPfIpN4OXS4+8+1ZI4wMvkaWlOo/VrzYXwYltV7w1/Q=",
    };

    test("decrypts a hardcoded LibSodium (v1) encrypted payload", async () => {
      const MWClass = encryptionMiddleware({ key: fixtureKey });
      const mw = new MWClass({ client: fromPartial({}) });

      const result = await mw.wrapStep!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        stepInfo: fromPartial({ hashedId: "abc", stepType: "run" }),
        next: async () => libSodiumFixture.envelope,
      });

      expect(result).toEqual(libSodiumFixture.plaintext);
    });

    test("decrypts a hardcoded AES (v0) encrypted payload", async () => {
      const MWClass = encryptionMiddleware({
        key: fixtureKey,
        legacyV0Service: { forceEncryptWithV0: false },
      });
      const mw = new MWClass({ client: fromPartial({}) });

      const result = await mw.wrapStep!({
        ctx: fromPartial({}),
        functionInfo: { id: "test-fn" },
        stepInfo: fromPartial({ hashedId: "abc", stepType: "run" }),
        next: async () => aesV0Fixture.envelope,
      });

      expect(result).toEqual(aesV0Fixture.plaintext);
    });

    test("decrypts a hardcoded encrypted event field via transformFunctionInput", async () => {
      const MWClass = encryptionMiddleware({ key: fixtureKey });
      const mw = new MWClass({ client: fromPartial({}) });

      const result = await mw.transformFunctionInput!({
        ctx: fromPartial({
          event: {
            name: "test.event",
            data: {
              public_field: "visible",
              encrypted: {
                [EncryptionService.ENCRYPTION_MARKER]: true,
                [EncryptionService.STRATEGY_MARKER]: "inngest/libsodium",
                data: eventFixture.encryptedData,
              },
            },
          },
          events: [],
        }),
        functionInfo: { id: "test-fn" },
        steps: {},
      });

      expect(result.ctx.event.data).toEqual({
        public_field: "visible",
        encrypted: eventFixture.plaintext,
      });
    });
  });

  describe("execution engine integration", () => {
    const fn = async ({ step }: Context) => {
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

    test("decrypts memoized step data and encrypts following step output", async () => {
      const encryptedFoo = await encryptTestValue({ foo: "foo" });

      const { execResult } = await runFn({
        fn,
        steps: {
          [stepIds.foo]: { id: stepIds.foo, data: encryptedFoo },
        },
      });

      expect(execResult).toMatchObject({
        type: "step-ran",
        step: expect.objectContaining({ data: encryptedShape() }),
      });
    });

    test("returns encrypted function output with decrypted intermediate values", async () => {
      const encryptedFoo = await encryptTestValue({ foo: "foo" });
      const encryptedBar = await encryptTestValue({
        foowas: { foo: "foo" },
        bar: "bar",
      });

      const { execResult, rawOutput } = await runFn({
        fn,
        steps: {
          [stepIds.foo]: { id: stepIds.foo, data: encryptedFoo },
          [stepIds.bar]: { id: stepIds.bar, data: encryptedBar },
        },
      });

      expect(execResult).toMatchObject({
        type: "function-resolved",
        data: encryptedShape(),
      });

      expect(rawOutput).toEqual({
        foo: { foo: "foo" },
        bar: { foowas: { foo: "foo" }, bar: "bar" },
      });
    });
  });
});
