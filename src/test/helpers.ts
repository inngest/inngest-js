/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { Inngest } from "@local";
import { type ServeHandler } from "@local/components/InngestCommHandler";
import { envKeys, headerKeys } from "@local/helpers/consts";
import { slugify } from "@local/helpers/strings";
import { type FunctionTrigger } from "@local/types";
import { version } from "@local/version";
import fetch from "cross-fetch";
import { type Request, type Response } from "express";
import nock from "nock";
import httpMocks from "node-mocks-http";
import { ulid } from "ulid";
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

const inngest = createClient({ name: "test", eventKey: "event-key-123" });

export const testFramework = (
  /**
   * The name of the framework to test as it will appear in test logs. Also used
   * to check that the correct headers are being sent.
   */
  frameworkName: string,

  /**
   * The serve handler exported by this handler.
   */
  handler: { name: string; serve: ServeHandler },

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
    transformReq?: (
      req: Request,
      res: Response,
      env: Record<string, string | undefined>
    ) => unknown[] | void;

    /**
     * Specify a transformer for a given response, which will be used to
     * understand whether a response was valid or not. Must return a particular
     * pattern.
     */
    transformRes?: (
      /**
       * The Response object that was passed in to the handler. Depending on the
       * handler, this may not be exposed to the handler, so you may need the
       * next option, which is the returned value from the handler.
       */
      res: Response,

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
  /**
   * Create a helper function for running tests against the given serve handler.
   */
  const run = async (
    handlerOpts: Parameters<(typeof handler)["serve"]>,
    reqOpts: Parameters<typeof httpMocks.createRequest>,
    env: Record<string, string | undefined> = {}
  ): Promise<HandlerStandardReturn> => {
    const [nameOrInngest, functions, givenOpts] = handlerOpts;
    const serveHandler = handler.serve(nameOrInngest, functions, {
      ...givenOpts,

      /**
       * For testing, the fetch implementation has to be stable for us to
       * appropriately mock out the network requests.
       */
      fetch,
    });

    const [req, res] = createReqRes({
      hostname: "localhost",
      url: "/api/inngest",
      protocol: "https",
      ...reqOpts[0],
      headers: {
        ...reqOpts[0]?.headers,
        host: "localhost:3000",
      },
    });

    let envToPass = { ...env };

    /**
     * If we have `process` in this emulated environment, also mutate that to
     * account for common situations.
     */
    if (typeof process !== "undefined" && "env" in process) {
      process.env = { ...process.env, ...envToPass };
      envToPass = { ...process.env };
    }

    const args = opts?.transformReq?.(req, res, envToPass) ?? [req, res];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ret = await (serveHandler as (...args: any[]) => any)(...args);

    return (
      opts?.transformRes?.(res, ret) ?? {
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
    });

    if (opts?.handlerTests) {
      describe("Serve return", opts.handlerTests);
    }

    describe("GET (landing page)", () => {
      test("show landing page if forced on", async () => {
        const ret = await run(
          [inngest, [], { landingPage: true }],
          [{ method: "GET" }]
        );

        expect(ret).toMatchObject({
          status: 200,
          body: expect.stringContaining("<!DOCTYPE html>"),
          headers: expect.objectContaining({
            [headerKeys.SdkVersion]: expect.stringContaining("inngest-js:v"),
            [headerKeys.Framework]: expect.stringMatching(handler.name),
          }),
        });
      });

      test("return correct platform", async () => {
        const ret = await run(
          [inngest, [], { landingPage: true }],
          [{ method: "GET" }],
          { [envKeys.IsNetlify]: "true" }
        );

        expect(ret).toMatchObject({
          headers: expect.objectContaining({
            [headerKeys.Platform]: "netlify",
          }),
        });
      });

      test("show landing page if forced on with conflicting env", async () => {
        const ret = await run(
          [inngest, [], { landingPage: true }],
          [{ method: "GET" }],
          { INNGEST_LANDING_PAGE: "false" }
        );

        expect(ret).toMatchObject({
          status: 200,
          body: expect.stringContaining("<!DOCTYPE html>"),
          headers: expect.objectContaining({
            [headerKeys.SdkVersion]: expect.stringContaining("inngest-js:v"),
            [headerKeys.Framework]: expect.stringMatching(handler.name),
          }),
        });
      });

      test("don't show landing page if forced off", async () => {
        const ret = await run(
          [inngest, [], { landingPage: false }],
          [{ method: "GET" }]
        );

        expect(ret).toMatchObject({
          status: 403,
          headers: expect.objectContaining({
            [headerKeys.SdkVersion]: expect.stringContaining("inngest-js:v"),
            [headerKeys.Framework]: expect.stringMatching(handler.name),
          }),
          body: expect.stringContaining(
            "Landing page requested but is disabled"
          ),
        });
      });

      test("don't show landing page if forced off with conflicting env", async () => {
        const ret = await run(
          [inngest, [], { landingPage: false }],
          [{ method: "GET" }],
          { INNGEST_LANDING_PAGE: "true" }
        );

        expect(ret).toMatchObject({
          status: 403,
          headers: expect.objectContaining({
            [headerKeys.SdkVersion]: expect.stringContaining("inngest-js:v"),
            [headerKeys.Framework]: expect.stringMatching(handler.name),
          }),
          body: expect.stringContaining(
            "Landing page requested but is disabled"
          ),
        });
      });

      test("show landing page if env var is set to truthy value", async () => {
        const ret = await run([inngest, []], [{ method: "GET" }], {
          INNGEST_LANDING_PAGE: "true",
        });

        expect(ret).toMatchObject({
          status: 200,
          body: expect.stringContaining("<!DOCTYPE html>"),
          headers: expect.objectContaining({
            [headerKeys.SdkVersion]: expect.stringContaining("inngest-js:v"),
            [headerKeys.Framework]: expect.stringMatching(handler.name),
          }),
        });
      });

      test("don't show landing page if env var is set to falsey value", async () => {
        const ret = await run([inngest, []], [{ method: "GET" }], {
          INNGEST_LANDING_PAGE: "false",
        });

        expect(ret).toMatchObject({
          status: 403,
          headers: expect.objectContaining({
            [headerKeys.SdkVersion]: expect.stringContaining("inngest-js:v"),
            [headerKeys.Framework]: expect.stringMatching(handler.name),
          }),
          body: expect.stringContaining(
            "Landing page requested but is disabled"
          ),
        });
      });

      test("if introspection is specified, return introspection data", async () => {
        const ret = await run(
          [inngest, [], { landingPage: true }],
          [{ method: "GET", url: "/api/inngest?introspect=true" }]
        );

        const body = JSON.parse(ret.body);

        expect(ret).toMatchObject({
          status: 200,
          headers: expect.objectContaining({
            [headerKeys.SdkVersion]: expect.stringContaining("inngest-js:v"),
            [headerKeys.Framework]: expect.stringMatching(handler.name),
          }),
        });

        expect(body).toMatchObject({
          url: "https://localhost:3000/api/inngest",
          deployType: "ping",
          framework: expect.any(String),
          appName: "test",
          functions: [],
          sdk: `js:v${version}`,
          v: "0.1",
          hasSigningKey: false,
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

          const ret = await run([inngest, []], [{ method: "PUT" }]);

          const retBody = JSON.parse(ret.body);

          expect(ret).toMatchObject({
            status: 200,
            headers: expect.objectContaining({
              [headerKeys.SdkVersion]: expect.stringContaining("inngest-js:v"),
              [headerKeys.Framework]: expect.stringMatching(handler.name),
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

          const ret = await run([inngest, []], [{ method: "PUT" }], {
            [envKeys.IsNetlify]: "true",
          });

          expect(ret).toMatchObject({
            headers: expect.objectContaining({
              [headerKeys.Platform]: "netlify",
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
            [inngest, []],
            [{ method: "PUT", url: customUrl }]
          );

          const retBody = JSON.parse(ret.body);

          expect(ret).toMatchObject({
            status: 200,
            headers: expect.objectContaining({
              [headerKeys.SdkVersion]: expect.stringContaining("inngest-js:v"),
              [headerKeys.Framework]: expect.stringMatching(handler.name),
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
            "fn1",
            "demo/event.sent",
            () => "fn1"
          );
          const serveHost = "https://example.com";
          const stepId = "step";

          await run([inngest, [fn1], { serveHost }], [{ method: "PUT" }]);

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
            "fn1",
            "demo/event.sent",
            () => "fn1"
          );
          const servePath = "/foo/bar/inngest/endpoint";
          const stepId = "step";

          await run([inngest, [fn1], { servePath }], [{ method: "PUT" }]);

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
          nock("https://api.inngest.com").post("/fn/register").reply(200);

          const ret = await run(
            [new Inngest({ name: "Test", env: "FOO" }), []],
            [{ method: "PUT" }]
          );

          expect(ret).toMatchObject({
            status: 200,
            headers: expect.objectContaining({
              [headerKeys.Environment]: expect.stringMatching("FOO"),
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
          "fn1",
          "demo/event.sent",
          () => "fn1"
        );
        const serveHost = "https://example.com";
        const servePath = "/foo/bar/inngest/endpoint";
        const stepId = "step";

        await run(
          [inngest, [fn1], { serveHost, servePath }],
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

      test.todo("register with dev server host from env if specified");
      test.todo("register with default dev server host if no env specified");
    });

    describe("POST (run function)", () => {
      describe("signature validation", () => {
        const client = createClient({ name: "test" });

        const fn = client.createFunction(
          { name: "Test", id: "test" },
          { event: "demo/event.sent" },
          () => "fn"
        );
        const env = {
          DENO_DEPLOYMENT_ID: "1",
          NODE_ENV: "production",
          ENVIRONMENT: "production",
        };
        test("should throw an error in prod with no signature", async () => {
          const ret = await run(
            [inngest, [fn], { signingKey: "test" }],
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
            [inngest, [fn], { signingKey: "test" }],
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
            [inngest, [fn], { signingKey: "test" }],
            [
              {
                method: "POST",
                headers: {
                  [headerKeys.Signature]: `t=${Math.round(
                    yesterday.getTime() / 1000
                  )}&s=expired`,
                },
                url: "/api/inngest?fnId=test",
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
              inngest,
              [fn],
              {
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
                url: "/api/inngest?fnId=test&stepId=step",
                body,
              },
            ],
            env
          );
          expect(ret).toMatchObject({
            status: 200,
            body: '"fn"',
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
  const id = ulid();

  const res = await fetch("http://localhost:8288/e/key", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id, name, data: data || {}, user, ts: Date.now() }),
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }

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
  for (let i = 0; i < 5; i++) {
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

    await waitUpTo(1000, start);
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
  for (let i = 0; i < 5; i++) {
    const start = new Date();

    const res = await fetch("http://localhost:8288/v0/gql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `query GetEventRuns($eventId: ID!) {
        event(query: {eventId: $eventId}) {
          id
          functionRuns {
            id
            name
          }
        }
      }`,
        variables: {
          eventId,
        },
        operationName: "GetEventRuns",
      }),
    });

    if (!res.ok) {
      throw new Error(await res.text());
    }

    const data = await res.json();

    const run = data?.data?.event?.functionRuns?.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (run: any) => run.name === name
    );

    if (run) {
      return run.id;
    }

    await waitUpTo(1000, start);
  }

  throw new Error("Event run not found");
};

/**
 * A test helper used to query a local, unsecured dev server to see if a given
 * run has a particular item in its timeline.
 *
 * If found within 5 seconds, returns `true`, else returns `false`.
 */
export const runHasTimeline = async (
  runId: string,
  timeline: {
    __typename: "StepEvent" | "FunctionEvent";
    name?: string;
    stepType?: string;
    functionType?: string;
    output?: string;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> => {
  for (let i = 0; i < 5; i++) {
    const start = new Date();

    const res = await fetch("http://localhost:8288/v0/gql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `query GetRunTimeline($runId: ID!) {
          functionRun(query: {functionRunId: $runId}) {
            timeline {
              __typename
              ... on StepEvent {
                name
                createdAt
                stepType: type
                output
              }
              ... on FunctionEvent {
                createdAt
                functionType: type
                output
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timelineItem = data?.data?.functionRun?.timeline?.find((entry: any) =>
      Object.keys(timeline).every(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (key) => entry[key] === (timeline as any)[key]
      )
    );

    if (timelineItem) {
      return timelineItem;
    }

    await waitUpTo(1000, start);
  }

  return;
};

interface CheckIntrospection {
  name: string;
  triggers: FunctionTrigger[];
}

export const checkIntrospection = ({ name, triggers }: CheckIntrospection) => {
  describe("introspection", () => {
    it("should be registered in SDK UI", async () => {
      const res = await fetch("http://127.0.0.1:3000/api/inngest?introspect");

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
              steps: z.object({
                step: z.object({
                  id: z.literal("step"),
                  name: z.literal("step"),
                  runtime: z.object({
                    type: z.literal("http"),
                    url: z.string().url(),
                  }),
                }),
              }),
            })
          ),
        })
        .parse(await res.json());

      expect(data.functions).toContainEqual({
        name,
        id: expect.stringMatching(new RegExp(`^.*-${slugify(name)}$`)),
        triggers,
        steps: {
          step: {
            id: "step",
            name: "step",
            runtime: {
              type: "http",
              url: expect.stringMatching(
                new RegExp(`^http.+\\?fnId=.+-${slugify(name)}&stepId=step$`)
              ),
            },
          },
        },
      });
    });

    it("should be registered in Dev Server UI", async () => {
      const res = await fetch("http://localhost:8288/dev");

      const data = z
        .object({
          handlers: z.array(
            z.object({
              sdk: z.object({
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
                    steps: z.object({
                      step: z.object({
                        id: z.literal("step"),
                        name: z.literal("step"),
                        runtime: z.object({
                          type: z.literal("http"),
                          url: z.string().url(),
                        }),
                      }),
                    }),
                  })
                ),
              }),
            })
          ),
        })
        .parse(await res.json());

      expect(data.handlers[0]?.sdk.functions).toContainEqual({
        name,
        id: expect.stringMatching(new RegExp(`^.*-${slugify(name)}$`)),
        triggers,
        steps: {
          step: {
            id: "step",
            name: "step",
            runtime: {
              type: "http",
              url: expect.stringMatching(
                new RegExp(`^http.+\\?fnId=.+-${slugify(name)}&stepId=step$`)
              ),
            },
          },
        },
      });
    });
  });
};
