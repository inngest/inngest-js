import { fromPartial } from "@total-typescript/shoehorn";
import FetchMock from "fetch-mock-jest";
import {
  type Context,
  type EventPayload,
  Inngest,
  InngestMiddleware,
  type SendEventPayload,
} from "inngest";
import { InngestExecution, InngestExecutionV1 } from "inngest/internals";
import { EncryptionService, encryptionMiddleware } from "./middleware";

const id = "test-client";
const key = "123";
const baseUrl = "https://unreachable.com";
const eventKey = "123";
const fetchMock = FetchMock.sandbox();

const partialEncryptedValue = {
  [EncryptionService.ENCRYPTION_MARKER]: true,
  [EncryptionService.STRATEGY_MARKER]: "inngest/libsodium",
  data: expect.any(String),
};

describe("encryptionMiddleware", () => {
  describe("return", () => {
    test("returns an InngestMiddleware", () => {
      const mw = encryptionMiddleware({ key });
      expect(mw).toBeInstanceOf(InngestMiddleware);
    });

    test("requires a key", () => {
      expect(() => {
        // @ts-expect-error
        encryptionMiddleware({});
      }).toThrowError("Missing encryption key");
    });
  });

  describe("client", () => {
    afterEach(() => {
      fetchMock.mockReset();
    });

    const mockSend = (
      inngest: Inngest.Any,
      payload: SendEventPayload<Record<string, EventPayload>>,
    ): Promise<EventPayload> => {
      return new Promise(async (resolve, reject) => {
        fetchMock.post(`${baseUrl}/e/${eventKey}`, (url, req) => {
          resolve(JSON.parse(req.body as string)[0]);

          const res = new Response(JSON.stringify({ foo: "bar" }), {
            status: 200,
          });

          return res;
        });

        inngest.send(payload).catch(() => undefined);
      });
    };

    test("encrypts a sent event's field by default", async () => {
      const inngest = new Inngest({
        id,
        fetch: fetchMock as typeof fetch,
        baseUrl,
        eventKey,
        middleware: [encryptionMiddleware({ key })],
      });

      const evt = await mockSend(inngest, {
        name: "my.event",
        data: {
          foo: "bar",
          [EncryptionService.DEFAULT_ENCRYPTED_EVENT_FIELD]: "baz",
        },
      });

      expect(evt).toMatchObject({
        name: "my.event",
        data: expect.objectContaining({
          foo: "bar",
          encrypted: partialEncryptedValue,
        }),
      });
    });
  });

  describe("spec", () => {
    const todoSpecs: string[] = ["encrypts a function's return data"];

    todoSpecs.forEach((name) => {
      test.todo(name);
    });

    const runSpecs = (specs: Specification[]) => {
      specs.forEach((spec) => {
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
      });
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
        foo: InngestExecutionV1._internals.hashId("foo"),
        bar: InngestExecutionV1._internals.hashId("bar"),
      };

      runSpecs([
        {
          name: "encrypts a run step",
          fn,
          result: {
            type: "step-ran",
            step: fromPartial({
              data: partialEncryptedValue,
            }),
          },
        },
        {
          name: "decrypts and encrypts a following step",
          fn,
          result: {
            type: "step-ran",
            step: fromPartial({
              data: partialEncryptedValue,
            }),
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
          },
        },
        {
          name: "returns encrypted data",
          fn,
          result: {
            type: "function-resolved",
            data: partialEncryptedValue,
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

  // wrap the given fn so we can get the raw output without encryption for
  // testing
  const testFn = async (ctx: Context) => {
    rawOutput = await specFn(ctx);
    return rawOutput;
  };

  const fn = inngest.createFunction(
    { id: "my-fn" },
    { event: "my-event" },
    testFn,
  );

  const runId = "test-run";

  const execution = fn["createExecution"]({
    version: InngestExecution.ExecutionVersion.V2,
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
    },
  });

  const execResult = await execution.start();

  return { execResult, rawOutput };
};
