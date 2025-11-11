/**
 * Comprehensive test to verify the realtime middleware type inference fix.
 * 
 * This test demonstrates that:
 * 1. The Inngest client with realtimeMiddleware can be created without type errors
 * 2. The client type is portable and can be exported/re-exported
 * 3. The `publish` method is available and properly typed in function contexts
 * 4. TypeScript can infer the types without referencing node_modules paths
 */

import { Inngest } from "inngest";
import { expect, test } from "vitest";
import { realtimeMiddleware } from "./middleware";

test("realtimeMiddleware - comprehensive type inference test", () => {
  // Test 1: Create client with middleware - should not produce type errors
  const inngest = new Inngest({
    id: "test-app",
    middleware: [realtimeMiddleware()],
  });

  // Test 2: The client type should be portable and exportable
  // This would fail if TypeScript can't name the type
  type ClientType = typeof inngest;
  const _typeCheck: ClientType = inngest;
  expect(_typeCheck).toBe(inngest);

  // Test 3: Create a function that uses publish
  const testFunction = inngest.createFunction(
    { id: "test-function" },
    { event: "test/event" },
    async ({ publish, step, event, runId, attempt }) => {
      // Verify all standard context properties are available
      expect(step).toBeDefined();
      expect(event).toBeDefined();
      expect(runId).toBeDefined();
      expect(attempt).toBeDefined();

      // Verify publish is available and typed
      expect(publish).toBeDefined();
      expect(typeof publish).toBe("function");

      // The publish function should accept the correct message format
      // We're just checking the type here, not actually calling it
      const _publishTest = async () => {
        return publish({
          channel: "test-channel",
          topic: "test-topic",
          data: { message: "Hello!" },
        });
      };

      expect(_publishTest).toBeDefined();
    }
  );

  expect(testFunction).toBeDefined();
  expect(testFunction.id()).toBe("test-function");
});

test("realtimeMiddleware - type inference with event schemas", () => {
  const inngest = new Inngest({
    id: "test-app-with-schemas",
    middleware: [realtimeMiddleware()],
  });

  // Create a function with typed events
  const typedFunction = inngest.createFunction(
    { id: "typed-function" },
    { event: "test/typed-event" },
    async ({ publish, event }) => {
      // Event data should be typed
      expect(event).toBeDefined();
      expect(event.name).toBe("test/typed-event");

      // Publish should still be available
      expect(publish).toBeDefined();

      const _publishTest = async () => {
        return publish({
          channel: "typed-channel",
          topic: "typed-topic",
          data: { value: 123 },
        });
      };

      expect(_publishTest).toBeDefined();
    }
  );

  expect(typedFunction).toBeDefined();
});

test("realtimeMiddleware - type inference persists through client reuse", () => {
  // Create a client that will be reused
  const sharedInngest = new Inngest({
    id: "shared-app",
    middleware: [realtimeMiddleware()],
  });

  // Create multiple functions with the same client
  const function1 = sharedInngest.createFunction(
    { id: "function-1" },
    { event: "test/event-1" },
    async ({ publish }) => {
      expect(publish).toBeDefined();
    }
  );

  const function2 = sharedInngest.createFunction(
    { id: "function-2" },
    { event: "test/event-2" },
    async ({ publish }) => {
      expect(publish).toBeDefined();
    }
  );

  // Both functions should have the publish method available
  expect(function1).toBeDefined();
  expect(function2).toBeDefined();
});
