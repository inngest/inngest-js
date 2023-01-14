/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import fetch from "cross-fetch";
import type { Request, Response } from "express";
import nock from "nock";
import httpMocks from "node-mocks-http";
import { ulid } from "ulid";
import { z } from "zod";
import { Inngest } from "../components/Inngest";
import { ServeHandler } from "../components/InngestCommHandler";
import { version } from "../version";

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

const inngest = new Inngest({ name: "test", eventKey: "event-key-123" });

export const testFramework = (
  /**
   * The name of the framework to test as it will appear in test logs
   */
  frameworkName: string,

  /**
   * The serve handler exported by this handler.
   */
  handler: { serve: ServeHandler },

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
    ) => any[] | void;

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
    handlerOpts: Parameters<typeof handler["serve"]>,
    reqOpts: Parameters<typeof httpMocks.createRequest>,
    env: Record<string, string | undefined> = {}
  ): Promise<HandlerStandardReturn> => {
    const serveHandler = handler.serve(...handlerOpts);

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
    const ret = await serveHandler(...args);

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
          ["Test", [], { landingPage: true }],
          [{ method: "GET" }]
        );

        expect(ret).toMatchObject({
          status: 200,
          body: expect.stringContaining("<!DOCTYPE html>"),
          headers: expect.objectContaining({
            "x-inngest-sdk": expect.stringContaining("inngest-js:v"),
          }),
        });
      });

      test("show landing page if forced on with conflicting env", async () => {
        const ret = await run(
          ["Test", [], { landingPage: true }],
          [{ method: "GET" }],
          { INNGEST_LANDING_PAGE: "false" }
        );

        expect(ret).toMatchObject({
          status: 200,
          body: expect.stringContaining("<!DOCTYPE html>"),
          headers: expect.objectContaining({
            "x-inngest-sdk": expect.stringContaining("inngest-js:v"),
          }),
        });
      });

      test("don't show landing page if forced off", async () => {
        const ret = await run(
          ["Test", [], { landingPage: false }],
          [{ method: "GET" }]
        );

        expect(ret).toMatchObject({
          status: 405,
          headers: expect.objectContaining({
            "x-inngest-sdk": expect.stringContaining("inngest-js:v"),
          }),
        });
      });

      test("don't show landing page if forced off with conflicting env", async () => {
        const ret = await run(
          ["Test", [], { landingPage: false }],
          [{ method: "GET" }],
          { INNGEST_LANDING_PAGE: "true" }
        );

        expect(ret).toMatchObject({
          status: 405,
          headers: expect.objectContaining({
            "x-inngest-sdk": expect.stringContaining("inngest-js:v"),
          }),
        });
      });

      test("show landing page if env var is set to truthy value", async () => {
        const ret = await run(["Test", []], [{ method: "GET" }], {
          INNGEST_LANDING_PAGE: "true",
        });

        expect(ret).toMatchObject({
          status: 200,
          body: expect.stringContaining("<!DOCTYPE html>"),
          headers: expect.objectContaining({
            "x-inngest-sdk": expect.stringContaining("inngest-js:v"),
          }),
        });
      });

      test("don't show landing page if env var is set to falsey value", async () => {
        const ret = await run(["Test", []], [{ method: "GET" }], {
          INNGEST_LANDING_PAGE: "false",
        });

        expect(ret).toMatchObject({
          status: 405,
          headers: expect.objectContaining({
            "x-inngest-sdk": expect.stringContaining("inngest-js:v"),
          }),
        });
      });

      test("if introspection is specified, return introspection data", async () => {
        const appName = "Test";

        const ret = await run(
          [appName, [], { landingPage: true }],
          [{ method: "GET", url: "/api/inngest?introspect=true" }]
        );

        const body = JSON.parse(ret.body);

        expect(ret).toMatchObject({
          status: 200,
          headers: expect.objectContaining({
            "x-inngest-sdk": expect.stringContaining("inngest-js:v"),
          }),
        });

        expect(body).toMatchObject({
          url: "https://localhost:3000/api/inngest",
          deployType: "ping",
          framework: expect.any(String),
          appName,
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

          const ret = await run(["Test", []], [{ method: "PUT" }]);

          const retBody = JSON.parse(ret.body);

          expect(ret).toMatchObject({
            status: 200,
            headers: expect.objectContaining({
              "x-inngest-sdk": expect.stringContaining("inngest-js:v"),
            }),
          });

          expect(reqToMock).toMatchObject({
            url: "https://localhost:3000/api/inngest",
          });

          expect(retBody).toMatchObject({
            message: "Successfully registered",
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
            ["Test", []],
            [{ method: "PUT", url: customUrl }]
          );

          const retBody = JSON.parse(ret.body);

          expect(ret).toMatchObject({
            status: 200,
            headers: expect.objectContaining({
              "x-inngest-sdk": expect.stringContaining("inngest-js:v"),
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

          await run(["Test", [fn1], { serveHost }], [{ method: "PUT" }]);

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

          await run(["Test", [fn1], { servePath }], [{ method: "PUT" }]);

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
          ["Test", [fn1], { serveHost, servePath }],
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
      test.todo("...");
    });
  });
};

/**
 * A Zod schema for an introspection result from the SDK UI or the dev server.
 */
export const introspectionSchema = z.object({
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
});

/**
 * A test helper used to send events to a local, unsecured dev server.
 *
 * Generates an ID and returns that ID for future use.
 */
export const sendEvent = async (
  name: string,
  data?: Record<string, any>,
  user?: Record<string, any>
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
): Promise<boolean> => {
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

    if (
      data?.data?.functionRun?.timeline?.some((entry: any) =>
        Object.keys(timeline).every(
          (key) => entry[key] === (timeline as any)[key]
        )
      )
    ) {
      return true;
    }

    await waitUpTo(1000, start);
  }

  return false;
};
