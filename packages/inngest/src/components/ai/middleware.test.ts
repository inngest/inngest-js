import { type Tracer, trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { assertType, describe, expect, expectTypeOf, test, vi } from "vitest";
import { ExtendedTracesBehavior } from "../../proto/src/components/sdkFeatureObservations/protobuf/feature_observations.ts";
import { clientProcessorMap } from "../execution/otel/access.ts";
import { extendedTracesMiddleware } from "../execution/otel/middleware.ts";
import { Inngest } from "../Inngest.ts";
import { metadataMiddleware, type metadataSymbol } from "../InngestMetadata.ts";
import { scoreMiddleware, type scoreSymbol } from "../InngestScore.ts";
import type { ExperimentalStepTools } from "../InngestStepTools.ts";
import { sdkFeatureObservations } from "../sdkFeatureObservations.ts";
import { aiMiddleware } from "./middleware.ts";

const assertAiContext = (ctx: {
  tracer: Tracer;
  step: {
    metadata: ExperimentalStepTools[typeof metadataSymbol];
    score: ExperimentalStepTools[typeof scoreSymbol];
  };
}) => {
  assertType<Tracer>(ctx.tracer);
  assertType<ExperimentalStepTools[typeof metadataSymbol]>(ctx.step.metadata);
  assertType<ExperimentalStepTools[typeof scoreSymbol]>(ctx.step.score);
};

describe("aiMiddleware", () => {
  test("score, metadata, and tracer are only present if the middleware is used", () => {
    const inngestWithoutMiddleware = new Inngest({
      id: "test",
      eventKey: "test-key-123",
    });

    inngestWithoutMiddleware.createFunction(
      { id: "test", triggers: [{ event: "foo" }] },
      (ctx) => {
        expectTypeOf(ctx).not.toHaveProperty("tracer");
        expectTypeOf(ctx.step).not.toHaveProperty("score");
        expectTypeOf(ctx.step).not.toHaveProperty("metadata");
      },
    );

    const inngestWithMiddleware = new Inngest({
      id: "test",
      eventKey: "test-key-123",
      middleware: [aiMiddleware()],
    });

    inngestWithMiddleware.createFunction(
      { id: "test", triggers: [{ event: "foo" }] },
      (ctx) => {
        assertAiContext(ctx);
      },
    );
  });

  test("onRegister enables score and metadata on the client", () => {
    const client = new Inngest({
      id: "test",
      middleware: [aiMiddleware({ traces: false })],
    });

    expect(client["experimentalScoreEnabled"]).toBe(true);
    expect(client["experimentalMetadataEnabled"]).toBe(true);
    expect(sdkFeatureObservations.extendedTraces.get(client)?.behavior).toBe(
      ExtendedTracesBehavior.EXTENDED_TRACES_BEHAVIOR_OFF,
    );
  });

  test("wrapRequest delegates to the traces middleware", async () => {
    trace.setGlobalTracerProvider(new BasicTracerProvider());
    try {
      const AiMiddleware = aiMiddleware();
      const client = new Inngest({ id: "test", middleware: [AiMiddleware] });
      const processor = clientProcessorMap.get(client);
      if (!processor) {
        throw new Error("traces onRegister did not register a processor");
      }
      const flush = vi.spyOn(processor, "forceFlush").mockResolvedValue();

      const middleware = new AiMiddleware({ client });
      const response = { body: "", headers: {}, status: 200 };
      const next = vi.fn(async () => response);

      await expect(
        middleware.wrapRequest({
          fn: null,
          next,
          requestArgs: [],
          requestInfo: {
            body: async () => undefined,
            headers: {},
            method: "POST",
            url: new URL("http://localhost/api/inngest"),
          },
          runId: "run_1",
        }),
      ).resolves.toBe(response);
      expect(next).toHaveBeenCalledOnce();
      expect(flush).toHaveBeenCalledOnce();
    } finally {
      trace.disable();
    }
  });

  test("the bundle forwards every hook the inner middlewares implement", () => {
    const AiMiddleware = aiMiddleware({ traces: false });
    const inner = [
      scoreMiddleware(),
      metadataMiddleware(),
      extendedTracesMiddleware({ behaviour: "off" }),
    ];

    const hooksOf = (cls: (typeof inner)[number] | typeof AiMiddleware) =>
      [
        ...Object.getOwnPropertyNames(cls),
        ...Object.getOwnPropertyNames(cls.prototype),
      ].filter(
        (name) =>
          !["constructor", "length", "name", "prototype"].includes(name),
      );

    const delegated = hooksOf(AiMiddleware);
    for (const cls of inner) {
      expect(delegated).toEqual(expect.arrayContaining(hooksOf(cls)));
    }
  });
});
