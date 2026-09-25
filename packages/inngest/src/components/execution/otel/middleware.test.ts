import { InngestTestEngine } from "@inngest/test";
import { context, createContextKey } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Inngest } from "../../../index.ts";
import { extendedTracesMiddleware } from "./middleware.ts";

const REQUEST_CONTEXT_KEY = createContextKey("inngest:otel:test-request-ctx");

describe("extendedTracesMiddleware", () => {
  // Use the async-hooks context manager so that `context.with()` populates the
  // active OTel context within the user's handler scope, mirroring how a
  // real-world provider (e.g. Langfuse's `propagateAttributes`) works.
  beforeEach(() => {
    context.setGlobalContextManager(new AsyncHooksContextManager().enable());
  });

  afterEach(() => {
    context.disable();
  });

  it("preserves third-party OTel context inside `step.run` callbacks", async () => {
    const inngest = new Inngest({
      id: "otel-context-middleware",
      middleware: [extendedTracesMiddleware({ behaviour: "off" })],
    });

    const fn = inngest.createFunction(
      { id: "otel-context-middleware-fn", triggers: [{ event: "test/event" }] },
      async ({ step }) => {
        // Simulate a third-party library (e.g. Langfuse's
        // `propagateAttributes`) setting OTel context around a `step.run` call.
        const ctx = context
          .active()
          .setValue(REQUEST_CONTEXT_KEY, "request-value-123");

        return context.with(ctx, async () => {
          return step.run("otel-context-step", () => {
            return context.active().getValue(REQUEST_CONTEXT_KEY);
          });
        });
      },
    );

    const t = new InngestTestEngine({ function: fn });
    const { result, error } = await t.execute({
      events: [{ name: "test/event", data: {} }],
    });

    expect(error).toBeUndefined();
    expect(result).toBe("request-value-123");
  });
});
