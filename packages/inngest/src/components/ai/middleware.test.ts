import type { Tracer } from "@opentelemetry/api";
import { assertType, describe, expect, expectTypeOf, test } from "vitest";
import { dependencyInjectionMiddleware } from "../../middleware/dependencyInjection.ts";
import { ExtendedTracesBehavior } from "../../proto/src/components/sdkFeatureObservations/protobuf/feature_observations.ts";
import { Inngest } from "../Inngest.ts";
import type { metadataSymbol } from "../InngestMetadata.ts";
import type { scoreSymbol } from "../InngestScore.ts";
import type { ExperimentalStepTools } from "../InngestStepTools.ts";
import { sdkFeatureObservations } from "../sdkFeatureObservations.ts";
import { type AiMiddlewareOptions, aiMiddleware } from "./middleware.ts";

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
      middleware: aiMiddleware({ traces: { behaviour: "off" } }),
    });

    inngestWithMiddleware.createFunction(
      { id: "test", triggers: [{ event: "foo" }] },
      (ctx) => {
        assertAiContext(ctx);
      },
    );

    // The docs tell users to spread the bundle alongside their own middleware.
    // The ctx extensions only survive while that spread stays a tuple.
    const inngestWithComposedMiddleware = new Inngest({
      id: "test",
      eventKey: "test-key-123",
      middleware: [
        ...aiMiddleware({ traces: { behaviour: "off" } }),
        dependencyInjectionMiddleware({ greeting: "hello" }),
      ],
    });

    inngestWithComposedMiddleware.createFunction(
      { id: "test", triggers: [{ event: "foo" }] },
      (ctx) => {
        assertAiContext(ctx);
        assertType<string>(ctx.greeting);
      },
    );
  });

  test("onRegister enables score and metadata, and passes traces through", () => {
    const client = new Inngest({
      id: "test",
      middleware: aiMiddleware({ traces: { behaviour: "off" } }),
    });

    expect(client["experimentalScoreEnabled"]).toBe(true);
    expect(client["experimentalMetadataEnabled"]).toBe(true);

    const behaviourOf = (options?: AiMiddlewareOptions) =>
      sdkFeatureObservations.extendedTraces.get(
        new Inngest({ id: "test", middleware: aiMiddleware(options) }),
      )?.behavior;

    expect(behaviourOf()).toBe(
      ExtendedTracesBehavior.EXTENDED_TRACES_BEHAVIOR_EXTEND_PROVIDER,
    );
    expect(behaviourOf({ traces: { behaviour: "off" } })).toBe(
      ExtendedTracesBehavior.EXTENDED_TRACES_BEHAVIOR_OFF,
    );
  });
});
