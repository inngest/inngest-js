/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import type { Request, Response } from "express";
import nock from "nock";
import httpMocks from "node-mocks-http";
import { ServeHandler } from "../express";
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
      headers: {
        host: "localhost:3000",
      },
      url: "/api/inngest",
      protocol: "https",
      ...reqOpts[0],
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
      });

      test.todo("register with dev server host from env if specified");
      test.todo("register with default dev server host if no env specified");
    });

    describe("POST (run function)", () => {
      test.todo("...");
    });
  });
};
