/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import type { Request, Response } from "express";
import httpMocks from "node-mocks-http";
import { ServeHandler } from "../express";

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
      ...reqOpts[0],
    });

    let envToPass = { ...env };

    /**
     * If we have `process` in this emulated environment, also mutate that to
     * account for common situations.
     */
    if (typeof process !== "undefined") {
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

    ["http", "https"].forEach((protocol) => {
      describe(`GET (landing page): ${protocol.toUpperCase()}`, () => {
        test("show landing page if forced on", async () => {
          const ret = await run(
            ["Test", [], { landingPage: true }],
            [{ method: "GET", protocol }]
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
            [{ method: "GET", protocol }],
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
            [{ method: "GET", protocol }]
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
            [{ method: "GET", protocol }],
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
          const ret = await run(["Test", []], [{ method: "GET", protocol }], {
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
          const ret = await run(["Test", []], [{ method: "GET", protocol }], {
            INNGEST_LANDING_PAGE: "false",
          });

          expect(ret).toMatchObject({
            status: 405,
            headers: expect.objectContaining({
              "x-inngest-sdk": expect.stringContaining("inngest-js:v"),
            }),
          });
        });

        test.todo("if introspection is specified, return introspection data");
      });

      describe(`PUT (register): ${protocol.toUpperCase()}`, () => {
        test.todo("register with correct URL from request");
        test.todo("register with dev server host from env if specified");
        test.todo("register with default dev server host if no env specified");
      });

      describe(`POST (run function): ${protocol.toUpperCase()}`, () => {
        test.todo("...");
      });
    });
  });
};
