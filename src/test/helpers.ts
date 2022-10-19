import { ServeHandler } from "../express";

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
  describe(`${
    frameworkName.charAt(0).toUpperCase() + frameworkName.slice(1)
  } handler`, () => {
    opts?.lifecycleChanges?.();

    if (opts?.envTests) {
      describe("Environment checks", opts.envTests);
    }

    if (opts?.handlerTests) {
      describe("Serve return", opts.handlerTests);
    }

    describe("GET (landing page)", () => {
      test.todo("show landing page if forced on");
      test.todo("show landing page if forced on with conflicting env");
      test.todo("don't show landing page if forced off");
      test.todo("don't show landing page if forced off with conflicting env");
      test.todo("show landing page if env var is set to truthy value");
      test.todo("don't show landing page if env var is set to falsey value");
      test.todo("if introspection is specified, return introspection data");
    });

    describe("PUT (register)", () => {
      test.todo("register with correct URL from request");
      test.todo("register with dev server host from env if specified");
      test.todo("register with default dev server host if no env specified");
    });

    describe("POST (run function)", () => {
      test.todo("...");
    });
  });
};
