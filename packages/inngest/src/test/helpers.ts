/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { Inngest, InngestFunction } from "@local";
import { type ServeHandlerOptions } from "@local/components/InngestCommHandler";
import {
  createStepTools,
  getStepOptions,
} from "@local/components/InngestStepTools";
import {
  ExecutionVersion,
  IInngestExecution,
  InngestExecution,
  InngestExecutionOptions,
  PREFERRED_EXECUTION_VERSION,
} from "@local/components/execution/InngestExecution";
import { ServerTiming } from "@local/helpers/ServerTiming";
import {
  envKeys,
  headerKeys,
  queryKeys,
  serverKind,
} from "@local/helpers/consts";
import { type Env } from "@local/helpers/env";
import { slugify } from "@local/helpers/strings";
import { EventPayload, type FunctionConfig } from "@local/types";
import { fromPartial } from "@total-typescript/shoehorn";
import fetch from "cross-fetch";
import { type Request, type Response } from "express";
import nock from "nock";
import httpMocks from "node-mocks-http";
import { z } from "zod";

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
    ...(args as ConstructorParameters<typeof Inngest>)
  ) as unknown as Inngest<T["0"]>;
};

export const testClientId = "__test_client__";

export const getStepTools = (
  client: Inngest.Any = createClient({ id: testClientId }),
  executionOptions: Partial<InngestExecutionOptions> = {}
) => {
  const execution = client
    .createFunction({ id: "test" }, { event: "test" }, () => undefined)
    ["createExecution"]({
      version: PREFERRED_EXECUTION_VERSION,
      partialOptions: {
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
export const runFnWithStack = (
  fn: InngestFunction.Any,
  stepState: InngestExecutionOptions["stepState"],
  opts?: {
    executionVersion?: ExecutionVersion;
    runStep?: string;
    onFailure?: boolean;
    event?: EventPayload;
    stackOrder?: InngestExecutionOptions["stepCompletionOrder"];
    disableImmediateExecution?: boolean;
  }
) => {
  const execution = fn["createExecution"]({
    version: opts?.executionVersion ?? PREFERRED_EXECUTION_VERSION,
    partialOptions: {
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
    },
  });

  return execution.start();
};

const inngest = createClient({ id: "test", eventKey: "event-key-123" });

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ret: any
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
  }
) => {
  type ServeHandler = string & { __serveHandler: true };

  const getServeHandler = (
    handlerOpts: Parameters<(typeof handler)["serve"]>
  ) => {
    const serveHandler = handler.serve({
      ...handlerOpts[0],

      /**
       * For testing, the fetch implementation has to be stable for us to
       * appropriately mock out the network requests.
       */
      fetch,
    });

    return serveHandler;
  };

  /**
   * Create a helper function for running tests against the given serve handler.
   */
  const run = async (
    handlerOpts: Parameters<(typeof handler)["serve"]> | ServeHandler,
    reqOpts: Parameters<typeof httpMocks.createRequest>,
    env: Env = {}
  ): Promise<HandlerStandardReturn> => {
    const serveHandler = Array.isArray(handlerOpts)
      ? getServeHandler(handlerOpts)
      : handlerOpts;

    const host = "localhost:3000";

    const mockReqOpts: httpMocks.RequestOptions = {
      hostname: "localhost",
      url: "/api/inngest",
      protocol: "https",
      ...reqOpts[0],
      headers: {
        ...reqOpts[0]?.headers,
        host,
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

    const args = opts?.transformReq?.(req, res, envToPass) ?? [req, res];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
          ]
        );

        const body = JSON.parse(ret.body);

        expect(ret).toMatchObject({
          status: 200,
          headers: expect.objectContaining({
            [headerKeys.SdkVersion]: expect.stringContaining("inngest-js:v"),
            [headerKeys.InngestExpectedServerKind]: serverKind.Dev,
            [headerKeys.Framework]: expect.stringMatching(
              handler.frameworkName
            ),
          }),
        });

        expect(body).toMatchObject({
          function_count: 0,
          has_event_key: false,
          has_signing_key: false,
          mode: "dev",
          extra: expect.objectContaining({
            is_mode_explicit: true,
          }),
        });
      });

      test("can pick up delayed event key from environment", async () => {
        const ret = await run(
          [{ client: createClient({ id: "test" }), functions: [] }],
          [{ method: "GET" }],
          { [envKeys.InngestEventKey]: "event-key-123" }
        );

        const body = JSON.parse(ret.body);

        expect(body).toMatchObject({
          has_event_key: true,
        });
      });

      test("can pick up delayed signing key from environment", async () => {
        const ret = await run(
          [{ client: createClient({ id: "test" }), functions: [] }],
          [{ method: "GET" }],
          { [envKeys.InngestSigningKey]: "signing-key-123" }
        );

        const body = JSON.parse(ret.body);

        expect(body).toMatchObject({
          has_signing_key: true,
        });
      });
    });

    describe("PUT (register)", () => {
      describe("prod env registration", () => {
        test("register with correct default URL from request", async () => {
          let reqToMock;

          nock("https://api.inngest.com")
            .post("/fn/register", (b) => {
              reqToMock = b;

              // eslint-disable-next-line @typescript-eslint/no-unsafe-return
              return b;
            })
            .reply(200, {
              status: 200,
            });

          const ret = await run(
            [{ client: inngest, functions: [] }],
            [
              {
                method: "PUT",
                url: "/api/inngest",
                headers: { [headerKeys.InngestServerKind]: serverKind.Dev },
              },
            ]
          );

          const retBody = JSON.parse(ret.body);

          expect(ret).toMatchObject({
            status: 200,
            headers: expect.objectContaining({
              [headerKeys.SdkVersion]: expect.stringContaining("inngest-js:v"),
              [headerKeys.InngestExpectedServerKind]: serverKind.Dev,
              [headerKeys.Framework]: expect.stringMatching(
                handler.frameworkName
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
            [{ client: inngest, functions: [] }],
            [
              {
                method: "PUT",
                headers: { [headerKeys.InngestServerKind]: serverKind.Dev },
              },
            ],
            {
              [envKeys.IsNetlify]: "true",
            }
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

              // eslint-disable-next-line @typescript-eslint/no-unsafe-return
              return b;
            })
            .reply(200, {
              status: 200,
            });

          const ret = await run(
            [{ client: inngest, functions: [] }],
            [
              {
                method: "PUT",
                url: customUrl,
                headers: { [headerKeys.InngestServerKind]: serverKind.Dev },
              },
            ]
          );

          const retBody = JSON.parse(ret.body);

          expect(ret).toMatchObject({
            status: 200,
            headers: expect.objectContaining({
              [headerKeys.SdkVersion]: expect.stringContaining("inngest-js:v"),
              [headerKeys.InngestExpectedServerKind]: serverKind.Dev,
              [headerKeys.Framework]: expect.stringMatching(
                handler.frameworkName
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

        test("register with overwritten host when specified", async () => {
          let reqToMock;

          nock("https://api.inngest.com")
            .post("/fn/register", (b) => {
              reqToMock = b;

              // eslint-disable-next-line @typescript-eslint/no-unsafe-return
              return b;
            })
            .reply(200, {
              status: 200,
            });

          const fn1 = inngest.createFunction(
            { id: "fn1" },
            { event: "demo/event.sent" },
            () => "fn1"
          );
          const serveHost = "https://example.com";
          const stepId = "step";

          await run(
            [{ client: inngest, functions: [fn1], serveHost }],
            [{ method: "PUT" }]
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

        test("register with overwritten path when specified", async () => {
          let reqToMock;

          nock("https://api.inngest.com")
            .post("/fn/register", (b) => {
              reqToMock = b;

              // eslint-disable-next-line @typescript-eslint/no-unsafe-return
              return b;
            })
            .reply(200, {
              status: 200,
            });

          const fn1 = inngest.createFunction(
            { id: "fn1" },
            { event: "demo/event.sent" },
            () => "fn1"
          );
          const servePath = "/foo/bar/inngest/endpoint";
          const stepId = "step";

          await run(
            [{ client: inngest, functions: [fn1], servePath }],
            [{ method: "PUT" }]
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
                client: new Inngest({ id: "Test", env: "FOO", isDev: false }),
                functions: [],
              },
            ],
            [
              {
                method: "PUT",
                headers: { [headerKeys.InngestServerKind]: serverKind.Dev },
              },
            ]
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

      test("register with overwritten host and path when specified", async () => {
        let reqToMock;

        nock("https://api.inngest.com")
          .post("/fn/register", (b) => {
            reqToMock = b;

            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return b;
          })
          .reply(200, {
            status: 200,
          });

        const fn1 = inngest.createFunction(
          { id: "fn1" },
          { event: "demo/event.sent" },
          () => "fn1"
        );
        const serveHost = "https://example.com";
        const servePath = "/foo/bar/inngest/endpoint";
        const stepId = "step";

        await run(
          [{ client: inngest, functions: [fn1], serveHost, servePath }],
          [{ method: "PUT" }]
        );

        expect(reqToMock).toMatchObject({
          url: `${serveHost}${servePath}`,
          functions: [
            {
              steps: {
                [stepId]: {
                  runtime: {
                    url: `${serveHost}${servePath}?fnId=test-fn1&stepId=${stepId}`,
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
          serveHandler = getServeHandler([
            { client: inngest, functions: [] },
          ]) as ServeHandler;

          makeReqWithDeployId = async (deployId: string) => {
            let reqToMock;

            const scope = nock("https://api.inngest.com")
              .post("/fn/register", (b) => {
                reqToMock = b;

                // eslint-disable-next-line @typescript-eslint/no-unsafe-return
                return b;
              })
              .query((q) =>
                deployId
                  ? q[queryKeys.DeployId] === deployId
                  : !(queryKeys.DeployId in q)
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

    describe("POST (run function)", () => {
      describe("signature validation", () => {
        const client = createClient({ id: "test" });

        const fn = client.createFunction(
          { name: "Test", id: "test" },
          { event: "demo/event.sent" },
          () => "fn"
        );
        const env = {
          DENO_DEPLOYMENT_ID: "1",
          NODE_ENV: "production",
          ENVIRONMENT: "production",
          INNGEST_DEV: "0",
        };
        test("should throw an error in prod with no signature", async () => {
          const ret = await run(
            [{ client: inngest, functions: [fn], signingKey: "test" }],

            [{ method: "POST", headers: {} }],
            env
          );
          expect(ret.status).toEqual(500);
          expect(JSON.parse(ret.body)).toMatchObject({
            type: "internal",
            message: expect.stringContaining(
              `No ${headerKeys.Signature} provided`
            ),
          });
        });
        test("should throw an error with an invalid signature", async () => {
          const ret = await run(
            [{ client: inngest, functions: [fn], signingKey: "test" }],
            [{ method: "POST", headers: { [headerKeys.Signature]: "t=&s=" } }],
            env
          );
          expect(ret.status).toEqual(500);
          expect(JSON.parse(ret.body)).toMatchObject({
            type: "internal",
            message: expect.stringContaining(
              `Invalid ${headerKeys.Signature} provided`
            ),
          });
        });
        test("should throw an error with an expired signature", async () => {
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const ret = await run(
            [{ client: inngest, functions: [fn], signingKey: "test" }],
            [
              {
                method: "POST",
                headers: {
                  [headerKeys.Signature]: `t=${Math.round(
                    yesterday.getTime() / 1000
                  )}&s=expired`,
                },
                url: "/api/inngest?fnId=test-test",
                body: { event: {}, events: [{}] },
              },
            ],
            env
          );
          expect(ret).toMatchObject({
            status: 500,
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
            name: "inngest/scheduled.timer",
            ts: 1674082830001,
            user: {},
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
                client: inngest,
                functions: [fn],
                signingKey:
                  "signkey-test-f00f3005a3666b359a79c2bc3380ce2715e62727ac461ae1a2618f8766029c9f",
                __testingAllowExpiredSignatures: true,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as any,
            ],
            [
              {
                method: "POST",
                headers: {
                  [headerKeys.Signature]:
                    "t=1687306735&s=70312c7815f611a4aa0b6f985910a85a6c232c845838d7f49f1d05fd8b2b0779",
                },
                url: "/api/inngest?fnId=test-test&stepId=step",
                body,
              },
            ],
            env
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
              name: "inngest/scheduled.timer",
              ts: 1674082830001,
              user: {},
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
                  client: inngest,
                  functions: [fn],
                  signingKey: "fake",
                  signingKeyFallback:
                    "signkey-test-f00f3005a3666b359a79c2bc3380ce2715e62727ac461ae1a2618f8766029c9f",
                  __testingAllowExpiredSignatures: true,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any,
              ],
              [
                {
                  method: "POST",
                  headers: {
                    [headerKeys.Signature]:
                      "t=1687306735&s=70312c7815f611a4aa0b6f985910a85a6c232c845838d7f49f1d05fd8b2b0779",
                  },
                  url: "/api/inngest?fnId=test-test&stepId=step",
                  body,
                },
              ],
              env
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
              name: "inngest/scheduled.timer",
              ts: 1674082830001,
              user: {},
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
                  client: inngest,
                  functions: [fn],
                  signingKey: "fake",
                  signingKeyFallback: "another-fake",
                  __testingAllowExpiredSignatures: true,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any,
              ],
              [
                {
                  method: "POST",
                  headers: {
                    [headerKeys.Signature]:
                      "t=1687306735&s=70312c7815f611a4aa0b6f985910a85a6c232c845838d7f49f1d05fd8b2b0779",
                  },
                  url: "/api/inngest?fnId=test-test&stepId=step",
                  body,
                },
              ],
              env
            );
            expect(ret).toMatchObject({
              status: 500,
              body: expect.stringContaining("Invalid signature"),
            });
          });
        });
      });

      describe("malformed payloads", () => {
        const fn = inngest.createFunction(
          { name: "Test", id: "test" },
          { event: "demo/event.sent" },
          () => "fn"
        );
        const env = {
          INNGEST_DEV: "1",
        };

        test("should throw an error with an invalid JSON body", async () => {
          const ret = await run(
            [{ client: inngest, functions: [fn], signingKey: "test" }],
            [
              {
                method: "POST",
                url: "/api/inngest?fnId=test-test",
                body: undefined,
              },
            ],
            env
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
  user?: Record<string, unknown>
): Promise<string> => {
  const res = await fetch("http://localhost:8288/e/key", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, data: data || {}, user, ts: Date.now() }),
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
  name: string
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  name: string
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let run: any;

    for (let i = 0; i < data?.data?.stream?.length ?? 0; i++) {
      const item = data?.data?.stream[i];

      if (item?.id !== eventId) {
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  | "StepInvoking";

class TimelineItem {
  public runId: string;
  public id: string;
  public type: string;
  public stepName: string | null;
  public createdAt: string;

  // Unsafe, but fine for testing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(runId: string, item: any) {
    this.runId = runId;
    this.id = item.id;
    this.type = item.type;
    this.stepName = item.stepName;
    this.createdAt = item.createdAt;
  }

  public async getOutput() {
    const res = await fetch("http://localhost:8288/v0/gql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `query GetRunTimelineOutput($runId: ID!, $historyItemId: ULID!) {
            functionRun(query: {functionRunId: $runId}) {
              historyItemOutput(id: $historyItemId)
            }
          }`,
        variables: {
          runId: this.runId,
          historyItemId: this.id,
        },
        operationName: "GetRunTimelineOutput",
      }),
    });

    if (!res.ok) {
      throw new Error(await res.text());
    }

    const data = await res.json();

    const payload = data?.data?.functionRun?.historyItemOutput || "null";
    if (typeof payload !== "string") {
      throw new Error("Invalid payload");
    }

    return JSON.parse(payload);
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
    stepName?: string;
    type: HistoryItemType;
    attempt?: number;
  },
  attempts = 140
): Promise<TimelineItem | undefined> => {
  for (let i = 0; i < attempts; i++) {
    const start = new Date();

    const res = await fetch("http://localhost:8288/v0/gql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `query GetRunTimeline($runId: ID!) {
          functionRun(query: {functionRunId: $runId}) {
            history {
              id
              type
              stepName
              createdAt
              attempt
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timelineItem = data?.data?.functionRun?.history?.find((entry: any) =>
      Object.keys(timeline).every(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (key) => entry[key] === (timeline as any)[key]
      )
    );

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
                  })
                )
              ),
              steps: z.array(
                z.object({
                  id: z.string(),
                  name: z.string(),
                  uri: z.string().url(),
                })
              ),
            })
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
                new RegExp(`^http.+\\?fnId=.+-${slugify(name)}&stepId=step$`)
              ),
            },
          ]),
        })
      );
    });
  });
};

/**
 * assert the subject satisfies the specified type T
 * @type T the type to check against.
 */
export function assertType<T>(subject: T): asserts subject is T {}
