import { DiagLogLevel, diag } from "@opentelemetry/api";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Inngest } from "../../Inngest.ts";
import { extendedTracesMiddleware } from "./middleware.ts";

describe("extendedTracesMiddleware", () => {
  afterEach(() => {
    diag.disable();
  });

  // Inngest only has diagnostics worth reading when it owns a span processor.
  // Installing its logger otherwise would swallow the host app's own OTel
  // diagnostics for no gain. "extendProvider" finds no provider here, and
  // "nonsense" stands in for a plain-JS caller passing an unknown behaviour,
  // which warns that it defaults to "off".
  test.for(["off", "extendProvider", "nonsense"])(
    "behaviour %s leaves the host app's diag logger in place",
    (behaviour) => {
      const logger = {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        verbose: vi.fn(),
        warn: vi.fn(),
      };
      diag.setLogger(logger, DiagLogLevel.ALL);

      new Inngest({
        id: "test",
        // @ts-expect-error `string` is wider than `Behaviour`
        middleware: [extendedTracesMiddleware({ behaviour })],
      });

      diag.error("from the host app");
      expect(logger.error).toHaveBeenCalledWith("from the host app");
    },
  );
});
