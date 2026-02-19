import { fromPartial } from "@total-typescript/shoehorn";
import fetch from "cross-fetch";
import type { Request, Response } from "express";
import nock from "nock";
import httpMocks from "node-mocks-http";
import { z } from "zod/v3";
import {
  type IInngestExecution,
  type InngestExecution,
  type InngestExecutionOptions,
} from "../components/execution/InngestExecution.ts";
import {
  type HandlerResponse,
  InngestCommHandler,
  type ServeHandlerOptions,
} from "../components/InngestCommHandler.ts";
import {
  createStepTools,
  getStepOptions,
} from "../components/InngestStepTools.ts";
import {
  type ExecutionVersion,
  envKeys,
  headerKeys,
  queryKeys,
  serverKind,
  syncKind,
} from "../helpers/consts.ts";
import type { Env } from "../helpers/env.ts";
import { signDataWithKey } from "../helpers/net.ts";
import { ServerTiming } from "../helpers/ServerTiming.ts";
import { slugify } from "../helpers/strings.ts";
import { isRecord } from "../helpers/types.ts";
import { Inngest, type InngestFunction } from "../index.ts";
import { type EventPayload, type FunctionConfig, StepMode } from "../types.ts";

interface HandlerStandardReturn {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const createReqRes = (...args: Parameters<typeof httpMocks.createRequest>) => {
  const options = args[0];
  const req = httpMocks.createRequest(options);
  const res = httpMocks.createResponse();

  return [req, res] as [typeof req, typeof res];
};

const retryFetch = async (
  retries: number,
  ...args: Parameters<typeof fetch>
) => {
  let lastError;

  for (let i = 0; i < retries; i++) {
    try {
      return await fetch(...args);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError;
};

/**
 * This is hack to get around the fact that the internal Inngest class exposes
 * certain methods that aren't exposed outside of the library. This is
 * exacerbated by the fact that we import from `"inngest"` and use a mapping in
 * the `tsconfig.json` to point to the local version of the library, which we do
 * to ensure we can test types against multiple TypeScript versions.
 */
export const createClient = <T extends ConstructorParameters<typeof Inngest>>(
  ...args: T
): Inngest<T["0"]> => {
  return new Inngest(
    ...(args as ConstructorParameters<typeof Inngest>),
  ) as unknown as Inngest<T["0"]>;
};

export const testClientId = "__test_client__";

export const getStepTools = (
  client: Inngest.Any = createClient({ id: testClientId, isDev: true }),
  executionOptions: Partial<InngestExecutionOptions> = {},
) => {
  const execution = client
    .createFunction(
      { id: "test", triggers: [{ event: "test" }] },
      () => undefined,
    )
    ["createExecution"]({
      partialOptions: {
        client,
        data: fromPartial({
          event: { name: "foo", data: {} },
        }),
        runId: "run",
        stepState: {},
        stepCompletionOrder: [],
        isFailureHandler: false,
        requestedRunStep: undefined,
        timer: new ServerTiming(),
        disableImmediateExecution: false,
        reqArgs: [],
        headers: {},
        stepMode: StepMode.Async,
        ...executionOptions,
      },
    }) as IInngestExecution & InngestExecution;

  const step = createStepTools(client, execution, ({ args, matchOp }) => {
    const stepOptions = getStepOptions(args[0]);
    return Promise.resolve(matchOp(stepOptions, ...args.slice(1)));
  });

  return step;
};

export type StepTools = ReturnType<typeof getStepTools>;

/**
 * Given an Inngest function and the appropriate execution state, return the
 * resulting data from this execution.
 */
/**
 * Given an Inngest function and the appropriate execution state, return the
 * resulting data from this execution.
 */
export const runFnWithStack = async (
  fn: InngestFunction.Any,
  stepState: InngestExecutionOptions["stepState"],
  opts?: {
    runStep?: string;
    onFailure?: boolean;
    event?: EventPayload;
    stackOrder?: InngestExecutionOptions["stepCompletionOrder"];
    disableImmediateExecution?: boolean;
  },
) => {
  const execution = fn["createExecution"]({
    partialOptions: {
      client: fn["client"],
      data: fromPartial({
        event: opts?.event || { name: "foo", data: {} },
      }),
      runId: "run",
      stepState,
      stepCompletionOrder: opts?.stackOrder ?? Object.keys(stepState),
      isFailureHandler: Boolean(opts?.onFailure),
      requestedRunStep: opts?.runStep,
      timer: new ServerTiming(),
      disableImmediateExecution: opts?.disableImmediateExecution,
      reqArgs: [],
      headers: {},
      stepMode: StepMode.Async,
      internalFnId: "fake-fn-id",
      queueItemId: "fake-queue-item-id",
    },
  });

  const { ctx: _ctx, ops: _ops, ...rest } = await execution.start();

  return rest;
};

type RunFnOpts = {
  executionVersion?: ExecutionVersion;
  runStep?: string;
  onFailure?: boolean;
  event?: EventPayload;
  stackOrder?: InngestExecutionOptions["stepCompletionOrder"];
  disableImmediateExecution?: boolean;
};

/**
 * Creates a function runner that accumulates step state across multiple calls.
 * Returns a callable that can be invoked repeatedly for subsequent requests.
 */
export function createFnRunner(fn: InngestFunction.Any, opts?: RunFnOpts) {
  let stepState: InngestExecutionOptions["stepState"] = {};

  return async () => {
    const result = await runFnWithStack(fn, stepState, opts);

    // Accumulate step state for subsequent requests
    if (result.type === "step-ran" && result.step) {
      stepState = {
        ...stepState,
        [result.step.id]: {
          data: result.step.data,
          error: result.step.error,
          id: result.step.id,
        },
      };
    }

    return {
      assertStepData: (expected: unknown) => {
        if (result.type !== "step-ran") {
          throw new Error(`Expected step-ran, got ${result.type}`);
        }
        expect(result.step.data).toEqual(expected);
      },
      assertStepError: (expected: {
        cause?: unknown;
        message: string;
        name: string;
      }) => {
        if (result.type !== "step-ran") {
          throw new Error(`Expected step-ran, got ${result.type}`);
        }
        if (!isRecord(result.step.error)) {
          throw new Error(
            `Expected step.error to be a record, got ${typeof result.step.error}`,
          );
        }
        expect(result.step.error.cause).toEqual(expected.cause);
        expect(result.step.error.message).toEqual(expected.message);
        expect(result.step.error.name).toEqual(expected.name);
      },
      result,
    };
  };
}

/**
 * Test signing key used for cloud mode tests.
 */
export const testSigningKey = "signkey-test-12345";

/**
 * Dev mode test client for most tests.
 * Uses isDev: true so no signing key is required.
 */
const inngest = createClient({
  id: "test",
  eventKey: "event-key-123",
  isDev: true,
});

/**
 * Cloud mode test client for tests that need to test cloud API registration.
 * Uses isDev: false so it registers with api.inngest.com.
 * Requires a signing key - either on the client or via env vars.
 */
const inngestCloud = createClient({
  id: "test",
  eventKey: "event-key-123",
  isDev: false,
  fetch,
});

export const testFramework = (
  /**
   * The name of the framework to test as it will appear in test logs. Also used
   * to check that the correct headers are being sent.
   */
  frameworkName: string,

  /**
   * The serve handler exported by this handler.
   */
  handler: {
    frameworkName: string;

    serve: (options: ServeHandlerOptions) => any;
  },

  /**
   * Optional tests and changes to make to this test suite.
   */
  opts?: {
    /**
     * A function that will be run in the contained test suite. It's a perfect
     * place to specify any lifecycle changes that need to be made to the test
     * suite, such as `beforeEach()`, `afterAll()`, etc.
     */
    lifecycleChanges?: () => void;

    /**
     * Specify a transformer for a given request, response, and env,  which will
     * be used to mimic the behavior of the framework's handler.
     *
     * If the function returns an array, the array will be used as args to the
     * serve handler. If it returns void, the default request and response args
     * will be used.
     *
     * Returning void is useful if you need to make environment changes but
     * are still fine with the default behaviour past that point.
     */
    transformReq?: (req: Request, res: Response, env: Env) => unknown[] | void;

    /**
     * Specify a transformer for a given response, which will be used to
     * understand whether a response was valid or not. Must return a particular
     * pattern.
     */
    transformRes?: (
      /**
       * The arguments that were passed in to the handler. Depending on the
       * handler, this may not be exposed to the handler, so you may need the
       * next option, which is the returned value from the handler.
       */
      args: unknown[],

      /**
       * The returned value from the handler.
       */

      ret: any,
    ) => Promise<HandlerStandardReturn>;

    /**
     * Specify a custom suite of tests to run against the given serve handler to
     * ensure that it's returning the correct format for its particular target.
     */
    handlerTests?: () => void;

    /**
     * Specify a custom suite of tests to run to check that the environment is
     * correctly mocked for all future tests in the suite. Useful to ensure that
     * mocks are being set up correctly.
     */
    envTests?: () => void;
  },
) => {
  type ServeHandler = string & { __serveHandler: true };

  const getServeHandler = (
    handlerOpts: Parameters<(typeof handler)["serve"]>,
  ) => {
    const serveHandler = handler.serve({
      ...handlerOpts[0],
    });

    return serveHandler;
  };

  /**
   * Create a handler in a simulated edge environment where process.env is
   * empty at construction time. This allows testing delayed env var pickup.
   * Always creates a fresh client with no isDev, so mode comes from env at request time.
   */
  const createEdgeHandler = (
    functions: InngestFunction.Any[] = [],
  ): ReturnType<(typeof handler)["serve"]> => {
    const originalEnv = process.env;
    process.env = {} as NodeJS.ProcessEnv;

    try {
      const freshClient = createClient({ id: "test", fetch });
      return getServeHandler([{ client: freshClient, functions }]);
    } finally {
      process.env = originalEnv;
    }
  };

  /**
   * Create a helper function for running tests against the given serve handler.
   */
  const run = async (
    handlerOpts: Parameters<(typeof handler)["serve"]> | ServeHandler,
    reqOpts: Parameters<typeof httpMocks.createRequest>,
    env: Env = {},

    /**
     * Forced action overrides, directly overwriting any fields returned by the
     * handler.
     *
     * This is useful to produce specific scenarios where actions like body
     * parsing may be missing from a framework.
     */
    actionOverrides?: Partial<HandlerResponse>,
  ): Promise<HandlerStandardReturn> => {
    const headers: Record<string, string> = {
      host: "localhost:3000",
    };

    if (reqOpts[0]?.body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = `${JSON.stringify(reqOpts[0].body).length}`;
    }

    const mockReqOpts: httpMocks.RequestOptions = {
      hostname: "localhost",
      url: "/api/inngest",
      protocol: "https",
      ...reqOpts[0],
      headers: {
        ...reqOpts[0]?.headers,
        ...headers,
      },
    };

    const [req, res] = createReqRes(mockReqOpts);

    let envToPass = { ...env };
    let prevProcessEnv = undefined;

    /**
     * If we have `process` in this emulated environment, also mutate that to
     * account for common situations.
     */
    if (typeof process !== "undefined" && "env" in process) {
      prevProcessEnv = process.env;
      process.env = { ...prevProcessEnv, ...envToPass };
      envToPass = { ...process.env };
    }

    const serveHandler = Array.isArray(handlerOpts)
      ? getServeHandler(handlerOpts)
      : handlerOpts;

    const args = opts?.transformReq?.(req, res, envToPass) ?? [req, res];
    if (actionOverrides) {
      args.push({ actionOverrides });
    }

    const ret = await (serveHandler as (...args: any[]) => any)(...args);

    if (prevProcessEnv) {
      process.env = prevProcessEnv;
    }

    return (
      opts?.transformRes?.(args, ret) ?? {
        status: res.statusCode,
        body: res._getData(),
        headers: res.getHeaders() as Record<string, string>,
      }
    );
  };

  describe(`${
    frameworkName.charAt(0).toUpperCase() + frameworkName.slice(1)
  } handler`, () => {
    beforeEach(() => {
      /**
       * Ensure nock is active before each test. This is required after each
       * use of `nock.restore()`.
       *
       * See https://www.npmjs.com/package/nock#restoring
       */
      try {
        nock.activate();
      } catch {
        // no-op - will throw if Nock is already active
      }
    });

    afterEach(() => {
      /**
       * Reset nock state after each test.
       *
       * See https://www.npmjs.com/package/nock#memory-issues-with-jest
       */
      nock.restore();
      nock.cleanAll();
    });

    opts?.lifecycleChanges?.();

    if (opts?.envTests) {
      describe("Environment checks", opts.envTests);
    }

    describe("Export checks", () => {
      test("serve should be a function", () => {
        expect(handler.serve).toEqual(expect.any(Function));
      });

      test("serve should return a function with a name", () => {
        const actual = handler.serve({ client: inngest, functions: [] });

        expect(actual.name).toEqual(expect.any(String));
        expect(actual.name).toBeTruthy();
      });

      /**
       * Some platforms check (at runtime) the length of the function being used
       * to handle an endpoint. If this is a variadic function, it will fail
       * that check.
       *
       * Therefore, we expect the arguments accepted to be the same length as
       * the `handler` function passed internally.
       */
      test("serve should return a function with a non-variadic length", () => {
        const actual = handler.serve({ client: inngest, functions: [] });

        expect(actual.length).toBeGreaterThan(0);
      });
    });

    if (opts?.handlerTests) {
      describe("Serve return", opts.handlerTests);
    }

    describe("Cloud mode signing key validation", () => {
      /**
       * Helper to run a function with specific env vars removed.
       * Works across Node.js (process.env) and Deno (Deno.env.toObject).
       */
      const withoutEnvVars = async <T>(
        keys: string[],
        fn: () => T | Promise<T>,
      ): Promise<Awaited<T>> => {
        const saved: Record<string, string | undefined> = {};

        // Handle process.env if it's an object
        if (typeof process?.env === "object") {
          for (const key of keys) {
            saved[key] = process.env[key];
            delete process.env[key];
          }
        }

        // Handle Deno.env.toObject if available
        // biome-ignore lint/suspicious/noExplicitAny: test helper
        const denoEnv = (globalThis as any).Deno?.env;
        const originalToObject = denoEnv?.toObject;
        if (typeof originalToObject === "function") {
          const originalEnv = originalToObject();
          denoEnv.toObject = () => {
            const env = { ...originalEnv };
            for (const key of keys) delete env[key];
            return env;
          };
        }

        try {
          return await fn();
        } finally {
          if (typeof process?.env === "object") {
            for (const key of keys) {
              if (saved[key] !== undefined) {
                process.env[key] = saved[key];
              }
            }
          }
          if (originalToObject) {
            denoEnv.toObject = originalToObject;
          }
        }
      };

      test("throws error at construction when cloud mode lacks signing key", async () => {
        // Only applies when process.env is available at construction (Node.js).
        // Edge environments (Deno, Cloudflare) defer validation to request time.
        if (typeof process?.env !== "object") return;

        await withoutEnvVars(
          [envKeys.InngestSigningKey, envKeys.InngestDevMode],
          () => {
            expect(() => {
              handler.serve({
                client: createClient({ id: "test" }),
                functions: [],
              });
            }).toThrow(/signing key is required/i);
          },
        );
      });

      test("defers validation and fails at request time without signing key", async () => {
        await withoutEnvVars(
          [envKeys.InngestSigningKey, envKeys.InngestDevMode],
          async () => {
            // In Node.js: use createEdgeHandler to simulate edge (empty env at construction)
            // In Deno/Cloudflare mock: env is already unavailable at construction
            const serveHandler =
              typeof process?.env === "object"
                ? createEdgeHandler()
                : getServeHandler([
                    {
                      client: createClient({ id: "test", fetch }),
                      functions: [],
                    },
                  ]);

            // Request without signing key should fail
            await expect(
              run(serveHandler, [{ method: "GET" }], {}),
            ).rejects.toThrow(/signing key is required/i);
          },
        );
      });
    });

    describe("GET", () => {
      test("shows introspection data", async () => {
        const ret = await run(
          [
            {
              client: createClient({ id: "test", isDev: true }),
              functions: [],
            },
          ],
          [
            {
              method: "GET",
              headers: { [headerKeys.InngestServerKind]: serverKind.Dev },
            },
          ],
        );

        const body = JSON.parse(ret.body);

        expect(ret).toMatchObject({
          status: 200,
          headers: expect.objectContaining({
            [headerKeys.SdkVersion]: expect.stringContaining("inngest-js:v"),
            [headerKeys.InngestExpectedServerKind]: serverKind.Dev,
            [headerKeys.Framework]: expect.stringMatching(
              handler.frameworkName,
            ),
          }),
        });

        expect(body).toMatchObject({
          function_count: 0,
          has_event_key: false,
          has_signing_key: false,
          mode: "dev",
        });
      });

      describe("edge environment (delayed env vars)", () => {
        test("can pick up delayed event key from environment", async () => {
          // Simulate edge: handler created with empty process.env
          const edgeHandler = createEdgeHandler();

          // At request time, env vars become available
          // Cloud mode (default) requires signing key at request time
          const ret = await run(edgeHandler, [{ method: "GET" }], {
            [envKeys.InngestEventKey]: "event-key-123",
            [envKeys.InngestSigningKey]: "signing-key-123",
          });

          const body = JSON.parse(ret.body);

          expect(body).toMatchObject({
            has_event_key: true,
          });
        });

        test("can pick up delayed signing key from environment", async () => {
          // Simulate edge: handler created with empty process.env
          const edgeHandler = createEdgeHandler();

          const ret = await run(edgeHandler, [{ method: "GET" }], {
            [envKeys.InngestSigningKey]: "signing-key-123",
          });

          expect(ret.status).toEqual(200);

          const body = JSON.parse(ret.body);

          expect(body).toMatchObject({
            has_signing_key: true,
          });
        });
      });

      test("#690 returns 200 if signature validation fails", async () => {
        // Pass signingKey via env for cloud mode
        const ret = await run(
          [
            {
              client: createClient({ id: "test", isDev: false }),
              functions: [],
            },
          ],
          [{ method: "GET" }],
          { [envKeys.InngestSigningKey]: "signing-key-123" },
        );

        expect(ret.status).toEqual(200);

        const body = JSON.parse(ret.body);

        expect(body).toMatchObject({
          has_signing_key: true,
        });
      });
    });

    describe("PUT (register)", () => {
      describe("out-of-band (legacy)", () => {
        describe("prod env registration", () => {
          test("register with correct default URL from request", async () => {
            let reqToMock;

            nock("https://api.inngest.com")
              .post("/fn/register", (b) => {
                reqToMock = b;

                return b;
              })
              .reply(200, {
                status: 200,
              });

            const ret = await run(
              [
                {
                  client: inngestCloud,
                  functions: [],
                },
              ],
              [
                {
                  method: "PUT",
                  url: "/api/inngest",
                  headers: {
                    [headerKeys.InngestServerKind]: serverKind.Dev,
                  },
                },
              ],
              { [envKeys.InngestSigningKey]: testSigningKey },
            );

            const retBody = JSON.parse(ret.body);

            expect(ret).toMatchObject({
              status: 200,
              headers: expect.objectContaining({
                [headerKeys.SdkVersion]:
                  expect.stringContaining("inngest-js:v"),
                [headerKeys.InngestExpectedServerKind]: serverKind.Dev,
                [headerKeys.Framework]: expect.stringMatching(
                  handler.frameworkName,
                ),
              }),
            });

            expect(reqToMock).toMatchObject({
              url: "https://localhost:3000/api/inngest",
            });

            expect(retBody).toMatchObject({
              message: "Successfully registered",
            });
          });

          test("return correct platform", async () => {
            nock("https://api.inngest.com").post("/fn/register").reply(200, {
              status: 200,
            });

            const ret = await run(
              [
                {
                  client: inngestCloud,
                  functions: [],
                },
              ],
              [
                {
                  method: "PUT",
                  headers: {
                    [headerKeys.InngestServerKind]: serverKind.Dev,
                  },
                },
              ],
              {
                [envKeys.IsNetlify]: "true",
                [envKeys.InngestSigningKey]: testSigningKey,
              },
            );

            expect(ret).toMatchObject({
              headers: expect.objectContaining({
                [headerKeys.Platform]: "netlify",
                [headerKeys.InngestExpectedServerKind]: serverKind.Dev,
              }),
            });
          });

          test("register with correct custom URL from request", async () => {
            const customUrl = "/foo/bar/inngest/endpoint";
            let reqToMock;

            nock("https://api.inngest.com")
              .post("/fn/register", (b) => {
                reqToMock = b;

                return b;
              })
              .reply(200, {
                status: 200,
              });

            const ret = await run(
              [
                {
                  client: inngestCloud,
                  functions: [],
                },
              ],
              [
                {
                  method: "PUT",
                  url: customUrl,
                  headers: {
                    [headerKeys.InngestServerKind]: serverKind.Dev,
                  },
                },
              ],
              { [envKeys.InngestSigningKey]: testSigningKey },
            );

            const retBody = JSON.parse(ret.body);

            expect(ret).toMatchObject({
              status: 200,
              headers: expect.objectContaining({
                [headerKeys.SdkVersion]:
                  expect.stringContaining("inngest-js:v"),
                [headerKeys.InngestExpectedServerKind]: serverKind.Dev,
                [headerKeys.Framework]: expect.stringMatching(
                  handler.frameworkName,
                ),
              }),
            });

            expect(reqToMock).toMatchObject({
              url: `https://localhost:3000${customUrl}`,
            });

            expect(retBody).toMatchObject({
              message: "Successfully registered",
            });
          });

          test("register with overwritten origin when specified", async () => {
            let reqToMock;

            nock("https://api.inngest.com")
              .post("/fn/register", (b) => {
                reqToMock = b;

                return b;
              })
              .reply(200, {
                status: 200,
              });

            const fn1 = inngestCloud.createFunction(
              { id: "fn1", triggers: [{ event: "demo/event.sent" }] },
              () => "fn1",
            );
            const serveOrigin = "https://example.com";
            const stepId = "step";

            await run(
              [
                {
                  client: inngestCloud,
                  functions: [fn1],
                  serveOrigin,
                },
              ],
              [{ method: "PUT" }],
              { [envKeys.InngestSigningKey]: testSigningKey },
            );

            expect(reqToMock).toMatchObject({
              url: `${serveOrigin}/api/inngest`,
              functions: [
                {
                  steps: {
                    [stepId]: {
                      runtime: {
                        url: `${serveOrigin}/api/inngest?fnId=test-fn1&stepId=${stepId}`,
                      },
                    },
                  },
                },
              ],
            });
          });

          test("register with overwritten path when specified", async () => {
            let reqToMock;

            nock("https://api.inngest.com")
              .post("/fn/register", (b) => {
                reqToMock = b;

                return b;
              })
              .reply(200, {
                status: 200,
              });

            const fn1 = inngestCloud.createFunction(
              { id: "fn1", triggers: [{ event: "demo/event.sent" }] },
              () => "fn1",
            );
            const servePath = "/foo/bar/inngest/endpoint";
            const stepId = "step";

            await run(
              [
                {
                  client: inngestCloud,
                  functions: [fn1],
                  servePath,
                },
              ],
              [{ method: "PUT" }],
              { [envKeys.InngestSigningKey]: testSigningKey },
            );

            expect(reqToMock).toMatchObject({
              url: `https://localhost:3000${servePath}`,
              functions: [
                {
                  steps: {
                    [stepId]: {
                      runtime: {
                        url: `https://localhost:3000${servePath}?fnId=test-fn1&stepId=${stepId}`,
                      },
                    },
                  },
                },
              ],
            });
          });
        });

        describe("env detection and headers", () => {
          test("uses env headers from client", async () => {
            nock("https://api.inngest.com").post("/fn/register").reply(200, {});

            const ret = await run(
              [
                {
                  client: new Inngest({
                    id: "Test",
                    env: "FOO",
                    isDev: false,
                    fetch,
                  }),
                  functions: [],
                },
              ],
              [
                {
                  method: "PUT",
                  headers: {
                    [headerKeys.InngestServerKind]: serverKind.Dev,
                  },
                },
              ],
              { [envKeys.InngestSigningKey]: testSigningKey },
            );

            expect(ret).toMatchObject({
              status: 200,
              headers: expect.objectContaining({
                [headerKeys.Environment]: expect.stringMatching("FOO"),
                [headerKeys.InngestExpectedServerKind]: serverKind.Dev,
              }),
            });
          });
        });

        test("register with overwritten origin and path when specified", async () => {
          let reqToMock;

          nock("https://api.inngest.com")
            .post("/fn/register", (b) => {
              reqToMock = b;

              return b;
            })
            .reply(200, {
              status: 200,
            });

          const fn1 = inngestCloud.createFunction(
            { id: "fn1", triggers: [{ event: "demo/event.sent" }] },
            () => "fn1",
          );
          const serveOrigin = "https://example.com";
          const servePath = "/foo/bar/inngest/endpoint";
          const stepId = "step";

          await run(
            [
              {
                client: inngestCloud,
                functions: [fn1],
                serveOrigin,
                servePath,
              },
            ],
            [{ method: "PUT" }],
            { [envKeys.InngestSigningKey]: testSigningKey },
          );

          expect(reqToMock).toMatchObject({
            url: `${serveOrigin}${servePath}`,
            functions: [
              {
                steps: {
                  [stepId]: {
                    runtime: {
                      url: `${serveOrigin}${servePath}?fnId=test-fn1&stepId=${stepId}`,
                    },
                  },
                },
              },
            ],
          });
        });

        test("INNGEST_SERVE_ORIGIN env var takes precedence over INNGEST_SERVE_HOST", async () => {
          let reqToMock;

          nock("https://api.inngest.com")
            .post("/fn/register", (b) => {
              reqToMock = b;

              return b;
            })
            .reply(200, {
              status: 200,
            });

          const fn1 = inngestCloud.createFunction(
            { id: "fn1", triggers: [{ event: "demo/event.sent" }] },
            () => "fn1",
          );
          const serveOrigin = "https://new-origin.com";
          const serveHost = "https://old-host.com";
          const stepId = "step";

          await run(
            [
              {
                client: inngestCloud,
                functions: [fn1],
              },
            ],
            [{ method: "PUT" }],
            {
              [envKeys.InngestSigningKey]: testSigningKey,
              [envKeys.InngestServeOrigin]: serveOrigin,
              [envKeys.InngestServeHost]: serveHost,
            },
          );

          expect(reqToMock).toMatchObject({
            url: `${serveOrigin}/api/inngest`,
            functions: [
              {
                steps: {
                  [stepId]: {
                    runtime: {
                      url: `${serveOrigin}/api/inngest?fnId=test-fn1&stepId=${stepId}`,
                    },
                  },
                },
              },
            ],
          });
        });

        test("INNGEST_SERVE_HOST env var works as fallback with deprecation warning", async () => {
          let reqToMock;

          nock("https://api.inngest.com")
            .post("/fn/register", (b) => {
              reqToMock = b;

              return b;
            })
            .reply(200, {
              status: 200,
            });

          const fn1 = inngestCloud.createFunction(
            { id: "fn1", triggers: [{ event: "demo/event.sent" }] },
            () => "fn1",
          );
          const serveHost = "https://old-host.com";
          const stepId = "step";

          await run(
            [
              {
                client: inngestCloud,
                functions: [fn1],
              },
            ],
            [{ method: "PUT" }],
            {
              [envKeys.InngestSigningKey]: testSigningKey,
              [envKeys.InngestServeHost]: serveHost,
            },
          );

          expect(reqToMock).toMatchObject({
            url: `${serveHost}/api/inngest`,
            functions: [
              {
                steps: {
                  [stepId]: {
                    runtime: {
                      url: `${serveHost}/api/inngest?fnId=test-fn1&stepId=${stepId}`,
                    },
                  },
                },
              },
            ],
          });
        });

        describe("#493", () => {
          let serveHandler: ServeHandler;
          let makeReqWithDeployId: (deployId: string) => Promise<any>;

          beforeEach(() => {
            // Set signing key in env before creating handler
            const originalEnv = process.env;
            process.env = {
              ...originalEnv,
              [envKeys.InngestSigningKey]: testSigningKey,
            };

            serveHandler = getServeHandler([
              {
                client: inngestCloud,
                functions: [],
              },
            ]) as ServeHandler;

            process.env = originalEnv;

            makeReqWithDeployId = async (deployId: string) => {
              let reqToMock;

              const scope = nock("https://api.inngest.com")
                .post("/fn/register", (b) => {
                  reqToMock = b;

                  return b;
                })
                .query((q) =>
                  deployId
                    ? q[queryKeys.DeployId] === deployId
                    : !(queryKeys.DeployId in q),
                )
                .reply(200, {
                  status: 200,
                });

              await run(serveHandler, [
                {
                  method: "PUT",
                  url: `/api/inngest${
                    deployId ? `?${queryKeys.DeployId}=${deployId}` : ""
                  }`,
                },
              ]);

              // Asserts that the nock scope was used
              scope.done();

              return reqToMock;
            };
          });

          test("across multiple executions, does not hold on to the deploy ID", async () => {
            const req1 = await makeReqWithDeployId("1");
            expect(req1).toMatchObject({
              url: expect.stringMatching("^https://localhost:3000/api/inngest"),
              deployId: "1",
            });

            const req2 = await makeReqWithDeployId("");
            expect(req2).toMatchObject({
              url: expect.stringMatching("^https://localhost:3000/api/inngest"),
            });
            expect(req2).not.toHaveProperty("deployId");

            const req3 = await makeReqWithDeployId("3");
            expect(req3).toMatchObject({
              url: expect.stringMatching("^https://localhost:3000/api/inngest"),
              deployId: "3",
            });
          });
        });

        test.todo("register with dev server host from env if specified");
        test.todo("register with default dev server host if no env specified");
      });

      describe("sync type tests", () => {
        const expectResponse = async (
          expectedResponse: syncKind | number,
          {
            serverMode,
            sdkMode,
            requestedSyncKind,
            validSignature,
            allowInBandSync,
            actionOverrides,
          }: {
            serverMode: serverKind;
            sdkMode: serverKind;
            requestedSyncKind: syncKind | undefined;
            validSignature: boolean | undefined;
            allowInBandSync: boolean | undefined;
            actionOverrides?: Partial<HandlerResponse>;
          },
        ) => {
          const name = `${
            serverMode === serverKind.Cloud ? "Cloud" : "Dev"
          } Server -> ${sdkMode === serverKind.Cloud ? "Cloud" : "Dev"} SDK - ${
            requestedSyncKind
              ? `requesting ${requestedSyncKind} sync`
              : "no sync kind specified"
          } with ${
            validSignature
              ? "a valid"
              : validSignature === false
                ? "an invalid"
                : "no"
          } signature (in-band syncs ${
            allowInBandSync === false
              ? "disallowed in"
              : allowInBandSync === true
                ? "allowed in"
                : "undefined as"
          } env var) should ${
            typeof expectedResponse === "number" ? "return" : "perform"
          } ${expectedResponse}`;

          test(name, async () => {
            const edgeHandler = createEdgeHandler();
            const signingKey = "123";
            const body = { url: "https://example.com/api/inngest" };
            const ts = Date.now().toString();

            const signature = validSignature
              ? `t=${ts}&s=${await signDataWithKey(body, signingKey, ts)}`
              : validSignature === false
                ? "INVALID"
                : undefined;

            const ret = await run(
              edgeHandler,
              [
                {
                  method: "PUT",
                  url: "/api/inngest",
                  body,
                  headers: {
                    [headerKeys.InngestServerKind]: serverMode,
                    [headerKeys.InngestSyncKind]: requestedSyncKind,
                    [headerKeys.Signature]: signature,
                  },
                },
              ],
              {
                [envKeys.InngestSigningKey]: signingKey,
                [envKeys.InngestDevMode]:
                  sdkMode === serverKind.Dev ? "true" : "false",
                ...(typeof allowInBandSync !== "undefined"
                  ? {
                      [envKeys.InngestAllowInBandSync]: allowInBandSync
                        ? "true"
                        : "false",
                    }
                  : {}),
              },
              actionOverrides,
            );

            if (typeof expectedResponse === "number") {
              expect(ret.status).toEqual(expectedResponse);
            } else {
              expect(ret).toMatchObject({
                status: 200,
                headers: expect.objectContaining({
                  [headerKeys.InngestSyncKind]: expectedResponse,
                }),
              });
            }
          });
        };

        beforeEach(() => {
          nock("https://api.inngest.com").post("/fn/register").reply(200, {
            status: 200,
          });
        });

        afterEach(() => {
          nock.restore();
          nock.cleanAll();
        });

        // Always perform out-of-band syncs if the env var is falsey
        describe("env var disallow", () => {
          Object.values(serverKind).forEach((serverMode) => {
            Object.values(serverKind).forEach((sdkMode) => {
              [undefined, ...Object.values(syncKind)].forEach(
                (requestedSyncKind) => {
                  [undefined, false, true].forEach((validSignature) => {
                    expectResponse(syncKind.OutOfBand, {
                      serverMode,
                      sdkMode,
                      requestedSyncKind,
                      validSignature,
                      allowInBandSync: false,
                    });
                  });
                },
              );
            });
          });
        });

        describe("no sync kind requested", () => {
          Object.values(serverKind).forEach((serverMode) => {
            Object.values(serverKind).forEach((sdkMode) => {
              [undefined, false, true].forEach((validSignature) => {
                [undefined, true].forEach((allowInBandSync) => {
                  expectResponse(syncKind.OutOfBand, {
                    serverMode,
                    sdkMode,
                    requestedSyncKind: undefined,
                    validSignature,
                    allowInBandSync,
                  });
                });
              });
            });
          });
        });

        // Always perform out-of-band syncs if requested
        describe("out-of-band requested", () => {
          Object.values(serverKind).forEach((serverMode) => {
            Object.values(serverKind).forEach((sdkMode) => {
              [undefined, false, true].forEach((validSignature) => {
                [undefined, true].forEach((allowInBandSync) => {
                  expectResponse(syncKind.OutOfBand, {
                    serverMode,
                    sdkMode,
                    requestedSyncKind: syncKind.OutOfBand,
                    validSignature,
                    allowInBandSync,
                  });
                });
              });
            });
          });
        });

        // Perform in-band syncs if requested and allowed
        describe("in-band requested", () => {
          describe("with valid signature", () => {
            Object.values(serverKind).forEach((serverMode) => {
              Object.values(serverKind).forEach((sdkMode) => {
                [undefined, true].forEach((allowInBandSync) => {
                  expectResponse(syncKind.InBand, {
                    serverMode,
                    sdkMode,
                    requestedSyncKind: syncKind.InBand,
                    validSignature: true,
                    allowInBandSync,
                  });
                });
              });
            });
          });

          describe("with invalid signature", () => {
            Object.values(serverKind).forEach((serverMode) => {
              Object.values(serverKind).forEach((sdkMode) => {
                [undefined, true].forEach((allowInBandSync) => {
                  const res =
                    sdkMode === serverKind.Dev ? syncKind.InBand : 401;

                  expectResponse(res, {
                    serverMode,
                    sdkMode,
                    requestedSyncKind: syncKind.InBand,
                    validSignature: false,
                    allowInBandSync,
                  });
                });
              });
            });
          });

          describe("with no signature", () => {
            Object.values(serverKind).forEach((serverMode) => {
              Object.values(serverKind).forEach((sdkMode) => {
                [undefined, true].forEach((allowInBandSync) => {
                  const res =
                    sdkMode === serverKind.Dev ? syncKind.InBand : 401;

                  expectResponse(res, {
                    serverMode,
                    sdkMode,
                    requestedSyncKind: syncKind.InBand,
                    validSignature: undefined,
                    allowInBandSync,
                  });
                });
              });
            });
          });

          describe("#789 with no body", () => {
            Object.values(serverKind).forEach((serverMode) => {
              Object.values(serverKind).forEach((sdkMode) => {
                [undefined, true].forEach((allowInBandSync) => {
                  expectResponse(500, {
                    actionOverrides: { body: () => undefined },
                    serverMode,
                    sdkMode,
                    requestedSyncKind: syncKind.InBand,
                    validSignature: true,
                    allowInBandSync,
                  });
                });
              });
            });
          });
        });
      });
    });

    describe("POST (run function)", () => {
      describe("#789 missing body", () => {
        test("returns 500", async () => {
          const client = createClient({ id: "test", isDev: true });

          const fn = client.createFunction(
            {
              name: "Test",
              id: "test",
              triggers: [{ event: "demo/event.sent" }],
            },
            () => "fn",
          );

          const ret = await run(
            [{ client, functions: [fn] }],
            [{ method: "POST" }],
            {},
            { body: () => undefined },
          );

          expect(ret.status).toEqual(500);
        });
      });

      describe("signature validation", () => {
        const client = createClient({ id: "test" });

        const fn = client.createFunction(
          {
            name: "Test",
            id: "test",
            triggers: [{ event: "demo/event.sent" }],
          },
          () => "fn",
        );
        const env = {
          DENO_DEPLOYMENT_ID: "1",
          NODE_ENV: "production",
          ENVIRONMENT: "production",
          INNGEST_DEV: "0",
        };
        test("should throw an error in prod with no signature", async () => {
          const ret = await run(
            [{ client, functions: [fn] }],
            [{ method: "POST", headers: {} }],
            { ...env, [envKeys.InngestSigningKey]: "test" },
          );
          expect(ret.status).toEqual(401);
          expect(JSON.parse(ret.body)).toMatchObject({
            message: expect.stringContaining(
              `No ${headerKeys.Signature} provided`,
            ),
          });
        });
        test("should throw an error with an invalid signature", async () => {
          const ret = await run(
            [{ client, functions: [fn] }],
            [{ method: "POST", headers: { [headerKeys.Signature]: "t=&s=" } }],
            { ...env, [envKeys.InngestSigningKey]: "test" },
          );
          expect(ret.status).toEqual(401);
          expect(JSON.parse(ret.body)).toMatchObject({
            message: expect.stringContaining(
              `Invalid ${headerKeys.Signature} provided`,
            ),
          });
        });
        test("should throw an error with an expired signature", async () => {
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const ret = await run(
            [{ client, functions: [fn] }],
            [
              {
                method: "POST",
                headers: {
                  [headerKeys.Signature]: `t=${Math.round(
                    yesterday.getTime() / 1000,
                  )}&s=expired`,
                },
                url: "/api/inngest?fnId=test-test",
                body: { event: {}, events: [{}] },
              },
            ],
            { ...env, [envKeys.InngestSigningKey]: testSigningKey },
          );
          expect(ret).toMatchObject({
            status: 401,
            body: expect.stringContaining("Signature has expired"),
          });
        });
        // These signatures are randomly generated within a local development environment, matching
        // what is sent from the cloud.
        //
        // This prevents us from having to rewrite the signature creation function in JS, which may
        // differ from the cloud/CLI version.
        test("should validate a signature with a key successfully", async () => {
          const event = {
            data: {},
            id: "",
            name: "demo/event.sent",
            ts: 1674082830001,
            v: "1",
          };

          const body = {
            ctx: {
              fn_id: "local-testing-local-cron",
              run_id: "01GQ3HTEZ01M7R8Z9PR1DMHDN1",
              step_id: "step",
            },
            event,
            events: [event],
            steps: {},
            use_api: false,
          };
          const ret = await run(
            [
              {
                client,
                functions: [fn],
                __testingAllowExpiredSignatures: true,
              } as any,
            ],
            [
              {
                method: "POST",
                headers: {
                  [headerKeys.Signature]:
                    "t=1687306735&s=a060f245a5d0c3c779ef65fd15b2ac06e4ab98dd8cc9860aa0722c8481ae02ab",
                },
                url: "/api/inngest?fnId=test-test&stepId=step",
                body,
              },
            ],
            {
              ...env,
              [envKeys.InngestSigningKey]:
                "signkey-test-f00f3005a3666b359a79c2bc3380ce2715e62727ac461ae1a2618f8766029c9f",
            },
          );
          expect(ret).toMatchObject({
            status: 200,
            body: JSON.stringify("fn"),
          });
        });

        describe("key rotation", () => {
          test("should validate a signature with a fallback key successfully", async () => {
            const event = {
              data: {},
              id: "",
              name: "demo/event.sent",
              ts: 1674082830001,
              v: "1",
            };

            const body = {
              ctx: {
                fn_id: "local-testing-local-cron",
                run_id: "01GQ3HTEZ01M7R8Z9PR1DMHDN1",
                step_id: "step",
              },
              event,
              events: [event],
              steps: {},
              use_api: false,
            };
            const ret = await run(
              [
                {
                  client,
                  functions: [fn],
                  __testingAllowExpiredSignatures: true,
                } as any,
              ],
              [
                {
                  method: "POST",
                  headers: {
                    [headerKeys.Signature]:
                      "t=1687306735&s=a060f245a5d0c3c779ef65fd15b2ac06e4ab98dd8cc9860aa0722c8481ae02ab",
                  },
                  url: "/api/inngest?fnId=test-test&stepId=step",
                  body,
                },
              ],
              {
                ...env,
                [envKeys.InngestSigningKey]: "fake",
                [envKeys.InngestSigningKeyFallback]:
                  "signkey-test-f00f3005a3666b359a79c2bc3380ce2715e62727ac461ae1a2618f8766029c9f",
              },
            );
            expect(ret).toMatchObject({
              status: 200,
              body: JSON.stringify("fn"),
            });
          });

          test("should fail if validation fails with both keys", async () => {
            const event = {
              data: {},
              id: "",
              name: "demo/event.sent",
              ts: 1674082830001,
              v: "1",
            };

            const body = {
              ctx: {
                fn_id: "local-testing-local-cron",
                run_id: "01GQ3HTEZ01M7R8Z9PR1DMHDN1",
                step_id: "step",
              },
              event,
              events: [event],
              steps: {},
              use_api: false,
            };
            const ret = await run(
              [
                {
                  client,
                  functions: [fn],
                  __testingAllowExpiredSignatures: true,
                } as any,
              ],
              [
                {
                  method: "POST",
                  headers: {
                    [headerKeys.Signature]:
                      "t=1687306735&s=eece58c8cf7cfc21a5751b1969c9aef525c96257b42b556c2782c83d26ea0d87",
                  },
                  url: "/api/inngest?fnId=test-test&stepId=step",
                  body,
                },
              ],
              {
                ...env,
                [envKeys.InngestSigningKey]: "fake",
                [envKeys.InngestSigningKeyFallback]: "another-fake",
              },
            );
            expect(ret).toMatchObject({
              status: 401,
              body: expect.stringContaining("Invalid signature"),
            });
          });
        });

        describe("signed response", () => {
          beforeEach(() => {
            vi.spyOn(
              InngestCommHandler.prototype as any,
              "getResponseSignature",
            ).mockImplementation(() => {
              throw new Error("Failed to sign response");
            });
          });

          afterEach(() => {
            vi.restoreAllMocks();
          });

          test("should throw if request is signed but we fail to sign the response", async () => {
            const event = {
              data: {},
              id: "",
              name: "demo/event.sent",
              ts: 1674082830001,
              v: "1",
            };

            const body = {
              ctx: {
                fn_id: "local-testing-local-cron",
                run_id: "01GQ3HTEZ01M7R8Z9PR1DMHDN1",
                step_id: "step",
              },
              event,
              events: [event],
              steps: {},
              use_api: false,
            };

            const ret = await run(
              [
                {
                  client,
                  functions: [fn],
                  __testingAllowExpiredSignatures: true,
                } as any,
              ],
              [
                {
                  method: "POST",
                  headers: {
                    [headerKeys.Signature]:
                      "t=1687306735&s=a060f245a5d0c3c779ef65fd15b2ac06e4ab98dd8cc9860aa0722c8481ae02ab",
                  },
                  url: "/api/inngest?fnId=test-test&stepId=step",
                  body,
                },
              ],
              {
                ...env,
                [envKeys.InngestSigningKey]:
                  "signkey-test-f00f3005a3666b359a79c2bc3380ce2715e62727ac461ae1a2618f8766029c9f",
              },
            );

            expect(ret).toMatchObject({
              status: 500,
              body: expect.stringContaining("Failed to sign response"),
            });
          });
        });
      });

      describe("malformed payloads", () => {
        const fn = inngest.createFunction(
          {
            name: "Test",
            id: "test",
            triggers: [{ event: "demo/event.sent" }],
          },
          () => "fn",
        );
        const env = {
          INNGEST_DEV: "1",
        };

        test("should throw an error with an invalid JSON body", async () => {
          const ret = await run(
            [{ client: inngest, functions: [fn] }],
            [
              {
                method: "POST",
                url: "/api/inngest?fnId=test-test",
                body: undefined,
              },
            ],
            env,
          );
          expect(ret).toMatchObject({
            status: 500,
            body: expect.stringContaining("Failed to parse data from executor"),
          });
        });
      });
    });
  });
};

/**
 * A test helper used to send events to a local, unsecured dev server.
 *
 * Generates an ID and returns that ID for future use.
 */
export const sendEvent = async (
  name: string,
  data?: Record<string, unknown>,
): Promise<string> => {
  const res = await fetch("http://localhost:8288/e/key", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, data: data || {}, ts: Date.now() }),
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }

  const id = (await res.json()).ids[0];

  return id;
};

/**
 * Given a number of milliseconds `upTo`, wait for that amount of time,
 * optionally starting from now or the given `from` date.
 */
export const waitUpTo = (upTo: number, from?: Date): Promise<void> => {
  const start = from || new Date();
  const now = from ? new Date() : start;

  const msPassed = now.getTime() - start.getTime();
  const ms = upTo - msPassed;

  if (ms < 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * A test helper used to query a local, unsecured dev server to see if a given
 * event has been received.
 *
 * If found within 5 seconds, returns the event. Otherwise, throws an error.
 */
export const receivedEventWithName = async (
  name: string,
): Promise<{
  id: string;
  name: string;
  payload: string;
}> => {
  for (let i = 0; i < 140; i++) {
    const start = new Date();

    const res = await fetch("http://localhost:8288/v0/gql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `query Events($query: EventsQuery!) {
  events(query: $query) {
    id
    name
    payload
  }
}`,
        variables: {
          query: {},
        },
        operationName: "Events",
      }),
    });

    if (!res.ok) {
      throw new Error(await res.text());
    }

    const data = await res.json();

    const event = data?.data?.events?.find((e: any) => e.name === name);

    if (event) {
      return event;
    }

    await waitUpTo(400, start);
  }

  throw new Error("Event not received");
};

/**
 * A test helper used to query a local, unsecured dev server to see if a given
 * event has triggered a function run with a particular name.
 *
 * If found within 5 seconds, returns the run ID, else throws.
 */
export const eventRunWithName = async (
  eventId: string,
  name: string,
): Promise<string> => {
  for (let i = 0; i < 140; i++) {
    const start = new Date();

    const body = {
      query: `query GetEventStream {
        stream(query: {limit: 999, includeInternalEvents: false}) {
          id
          trigger
          runs {
            id
            function {
              name
            }
          }
        }
      }`,
      variables: {},
      operationName: "GetEventStream",
    };

    const res = await fetch("http://localhost:8288/v0/gql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(await res.text());
    }

    const data = await res.json();

    let run: any;

    for (let i = 0; i < (data?.data?.stream?.length ?? 0); i++) {
      const item = data?.data?.stream[i];

      if (item?.id !== eventId) {
        continue;
      }

      run = item?.runs?.find((run: any) => {
        return run?.function?.name === name;
      });

      if (run) {
        break;
      }
    }

    if (run) {
      return run.id;
    }

    await waitUpTo(400, start);
  }

  throw new Error("Event run not found");
};

type HistoryItemType =
  | "FunctionScheduled"
  | "FunctionStarted"
  | "FunctionCompleted"
  | "FunctionFailed"
  | "FunctionCancelled"
  | "FunctionStatusUpdated"
  | "StepScheduled"
  | "StepStarted"
  | "StepCompleted"
  | "StepErrored"
  | "StepFailed"
  | "StepWaiting"
  | "StepSleeping"
  | "StepInvoking"
  | "FINALIZATION"
  | "RUN"
  | "INVOKE"
  | "";

class TimelineItem {
  public runId: string;
  public stepType: string;
  public name: string | null;
  public outputID: string | null;

  // Unsafe, but fine for testing.

  constructor(runId: string, item: any) {
    this.runId = runId;
    this.stepType = item.stepType;
    this.name = item.stepName;
    this.outputID = item.outputID || null;
  }

  public async getOutput() {
    const res = await fetch("http://localhost:8288/v0/gql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `query GetRunTimelineOutput($outputId: String!) {
          runTraceSpanOutputByID(outputID: $outputId) {
            data
            error {
              name
              message
              stack
              cause
            }
          }
        }`,
        variables: {
          outputId: this.outputID,
        },
        operationName: "GetRunTimelineOutput",
      }),
    });

    if (!res.ok) {
      throw new Error(await res.text());
    }

    const data = await res.json();

    const payload = data?.data?.runTraceSpanOutputByID;

    if (payload.error) {
      return { error: payload.error };
    }

    return { data: JSON.parse(payload.data) };
  }
}

/**
 * A test helper used to query a local, unsecured dev server to see if a given
 * run has a particular item in its timeline.
 *
 * If found within 5 seconds, returns `true`, else returns `false`.
 */
export const runHasTimeline = async (
  runId: string,
  timeline: {
    name?: string;
    stepType: HistoryItemType;
    attempts?: number;
    status?: "COMPLETED" | "FAILED";
  },
  attempts = 140,
): Promise<TimelineItem | undefined> => {
  for (let i = 0; i < attempts; i++) {
    const start = new Date();

    const res = await fetch("http://localhost:8288/v0/gql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `query GetRunTimeline($runId: String!) {
          run(runID: $runId) {
            trace(preview: true) {
              name
              stepType
              attempts
              outputID
              status
              childrenSpans {
                name
                stepType
                attempts
                outputID
                status
                childrenSpans {
                  name
                  stepType
                  attempts
                  outputID
                  status
                }
              }
            }
          }
        }`,
        variables: {
          runId,
        },
        operationName: "GetRunTimeline",
      }),
    });

    if (!res.ok) {
      throw new Error(await res.text());
    }

    const data = await res.json();

    const getMatchingTimeline = (span: any): any => {
      if (!span) return;

      const fieldsMatch = Object.keys(timeline).every(
        (key) => span[key] === (timeline as any)[key],
      );

      if (fieldsMatch) {
        return span;
      }

      if (Array.isArray(span.childrenSpans)) {
        for (const child of span.childrenSpans) {
          const match = getMatchingTimeline(child);
          if (match) {
            return match;
          }
        }
      }
    };

    const timelineItem = getMatchingTimeline(data?.data?.run?.trace);
    if (timelineItem) {
      return new TimelineItem(runId, timelineItem);
    }

    await waitUpTo(400, start);
  }

  return;
};

interface CheckIntrospection {
  name: string;
  triggers: FunctionConfig["triggers"];
}

export const checkIntrospection = ({ name, triggers }: CheckIntrospection) => {
  describe("introspection", () => {
    it("should be registered in SDK UI", async () => {
      const res = await retryFetch(5, "http://localhost:3000/api/inngest");

      await expect(res.json()).resolves.toMatchObject({
        has_signing_key: expect.any(Boolean),
        has_event_key: expect.any(Boolean),
        function_count: expect.any(Number),
        mode: expect.any(String),
      });
    });

    it("should be registered in Dev Server UI", async () => {
      const res = await fetch("http://localhost:8288/dev");

      const data = z
        .object({
          functions: z.array(
            z.object({
              name: z.string(),
              id: z.string(),
              triggers: z.array(
                z.object({ event: z.string() }).or(
                  z.object({
                    cron: z.string(),
                  }),
                ),
              ),
              steps: z.array(
                z.object({
                  id: z.string(),
                  name: z.string(),
                  uri: z.string().url(),
                }),
              ),
            }),
          ),
        })
        .parse(await res.json());

      expect(data.functions).toContainEqual(
        expect.objectContaining({
          name,
          triggers,
          steps: expect.arrayContaining([
            {
              id: "step",
              name: "step",
              uri: expect.stringMatching(
                new RegExp(`^http.+\\?fnId=.+-${slugify(name)}&stepId=step$`),
              ),
            },
          ]),
        }),
      );
    });
  });
};

/**
 * Get the current Node.js version.
 */
export const nodeVersion = process.version
  ? (() => {
      const [major, minor, patch] = process.versions.node
        .split(".")
        .map(Number);

      return { major, minor, patch };
    })()
  : undefined;
