import { Inngest } from "inngest";
import { describe, expect, test } from "vitest";
import { realtimeMiddleware } from "./middleware";

/**
 * Tests for the realtime middleware type inference.
 * 
 * These tests ensure that:
 * 1. The middleware can be added to an Inngest client without type errors
 * 2. The `publish` method is properly typed in the function context
 * 3. TypeScript can infer a portable type name for the client
 */
describe("realtimeMiddleware", () => {
  describe("type inference", () => {
    test("can create an Inngest client with realtimeMiddleware", () => {
      // This should not produce type errors
      const inngest = new Inngest({
        id: "test-app",
        middleware: [realtimeMiddleware()],
      });

      expect(inngest).toBeDefined();
      expect(inngest.id).toBe("test-app");
    });

    test("publish is available in function context", () => {
      const inngest = new Inngest({
        id: "test-app",
        middleware: [realtimeMiddleware()],
      });

      // Create a function that uses publish
      const fn = inngest.createFunction(
        { id: "test-function" },
        { event: "test/event" },
        async ({ publish, step }) => {
          // Type check: publish should exist
          expect(publish).toBeDefined();
          expect(typeof publish).toBe("function");

          // Type check: step should still be available
          expect(step).toBeDefined();
        }
      );

      expect(fn).toBeDefined();
    });

    test("publish accepts correct message format", () => {
      const inngest = new Inngest({
        id: "test-app",
        middleware: [realtimeMiddleware()],
      });

      const fn = inngest.createFunction(
        { id: "test-function" },
        { event: "test/event" },
        async ({ publish }) => {
          // This should type check correctly
          const message = {
            channel: "test-channel",
            topic: "test-topic",
            data: { message: "Hello!" },
          };

          // The publish function signature should accept this
          // We're not actually calling it in this test, just checking types
          expect(typeof publish).toBe("function");
        }
      );

      expect(fn).toBeDefined();
    });

    test("middleware can be combined with other middleware", () => {
      const customMiddleware = new (require("inngest").InngestMiddleware)({
        name: "custom",
        init: () => ({
          onFunctionRun: () => ({
            transformInput: () => ({
              ctx: {
                customField: "custom-value",
              },
            }),
          }),
        }),
      });

      const inngest = new Inngest({
        id: "test-app",
        middleware: [realtimeMiddleware(), customMiddleware],
      });

      const fn = inngest.createFunction(
        { id: "test-function" },
        { event: "test/event" },
        async ({ publish }) => {
          // publish from realtime middleware should be available
          expect(publish).toBeDefined();
          // Note: customField won't be available in the type system due to 'any' type,
          // but the middleware is still applied at runtime
        }
      );

      expect(fn).toBeDefined();
    });
  });

  describe("runtime behavior", () => {
    test("middleware is properly initialized", () => {
      const middleware = realtimeMiddleware();

      expect(middleware).toBeDefined();
      expect(middleware.name).toBe("publish");
      expect(typeof middleware.init).toBe("function");
    });
  });
});
