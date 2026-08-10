import type { Tracer } from "@opentelemetry/api";
import { assertType, describe, expect, expectTypeOf, test } from "vitest";
import { ExtendedTracesBehavior } from "../../proto/src/components/sdkFeatureObservations/protobuf/feature_observations.ts";
import { Inngest } from "../Inngest.ts";
import type { metadataSymbol } from "../InngestMetadata.ts";
import type { scoreSymbol } from "../InngestScore.ts";
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
      middleware: aiMiddleware({ traces: false }),
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
      middleware: aiMiddleware({ traces: false }),
    });

    expect(client["experimentalScoreEnabled"]).toBe(true);
    expect(client["experimentalMetadataEnabled"]).toBe(true);
    expect(sdkFeatureObservations.extendedTraces.get(client)?.behavior).toBe(
      ExtendedTracesBehavior.EXTENDED_TRACES_BEHAVIOR_OFF,
    );
  });

  test("traces default to the extendProvider behaviour", () => {
    const client = new Inngest({
      id: "test",
      middleware: aiMiddleware(),
    });

    expect(sdkFeatureObservations.extendedTraces.get(client)?.behavior).toBe(
      ExtendedTracesBehavior.EXTENDED_TRACES_BEHAVIOR_EXTEND_PROVIDER,
    );
  });
});
