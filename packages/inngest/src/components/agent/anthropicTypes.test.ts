/**
 * @module
 * Type tests for `anthropic()`: a real `@anthropic-ai/sdk` client fits
 * `client`, the result is an `AgentModel` that `agent.loop()` takes, and its
 * options are checked. The closures hold type-only code that never runs.
 */
import Anthropic from "@anthropic-ai/sdk";
import { expectTypeOf, test } from "vitest";
import { anthropic, anthropicPrices } from "./anthropic.ts";
import type { AgentModel, AgentPriceTable } from "./index.ts";
import { agent } from "./index.ts";

test("the SDK's client and the result fit", () => {
  const check = () => {
    const model = anthropic({
      model: "claude-sonnet-5-5",
      client: new Anthropic(),
      cache: { ttl: "1h" },
      effort: "high",
    });

    expectTypeOf(model).toEqualTypeOf<AgentModel>();
    expectTypeOf(agent.anthropic).toEqualTypeOf(anthropic);
    expectTypeOf(anthropicPrices).toEqualTypeOf<AgentPriceTable>();

    // A loop with a model and a prompt needs nothing else.
    void agent.loop({ model, prompt: "hi", price: anthropicPrices });

    // @ts-expect-error model is required
    anthropic({});
    // @ts-expect-error not a cache lifetime
    anthropic({ model: "m", cache: { ttl: "2h" } });
    // @ts-expect-error not an effort
    anthropic({ model: "m", effort: "huge" });
  };

  expectTypeOf(check).toBeFunction();
});
