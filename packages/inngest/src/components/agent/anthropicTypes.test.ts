/**
 * @module
 * Type tests for `anthropic()`: a real `@anthropic-ai/sdk` client fits
 * `client`, the result is an `AgentModel` that `agent.loop()` takes, and its
 * options are checked. The closures hold type-only code that never runs.
 */
import Anthropic from "@anthropic-ai/sdk";
import { expectTypeOf, test } from "vitest";
import { z } from "zod/v4";
import {
  type AnthropicModel,
  anthropic,
  anthropicPrices,
} from "./anthropic.ts";
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

    expectTypeOf(model).toExtend<AgentModel>();
    expectTypeOf(model).toEqualTypeOf<AnthropicModel>();
    expectTypeOf(model.with({ effort: "low" })).toEqualTypeOf<AnthropicModel>();
    expectTypeOf(agent.anthropic).toEqualTypeOf(anthropic);
    expectTypeOf(anthropicPrices).toEqualTypeOf<AgentPriceTable>();

    // A loop with a model and a prompt needs nothing else.
    void agent.loop({ model, prompt: "hi", price: anthropicPrices });

    // A direct call with a schema types its output.
    void (async () => {
      const { output } = await model({
        prompt: "hi",
        output: z.object({ ok: z.boolean() }),
      });

      expectTypeOf(output).toEqualTypeOf<{ ok: boolean }>();

      const plain = await model({ prompt: "hi" });

      expectTypeOf(plain).not.toHaveProperty("output");
    })();

    // @ts-expect-error the client can not change per call
    model.with({ client: new Anthropic() });

    // @ts-expect-error model is required
    anthropic({});
    // @ts-expect-error not a cache lifetime
    anthropic({ model: "m", cache: { ttl: "2h" } });
    // @ts-expect-error not an effort
    anthropic({ model: "m", effort: "huge" });
  };

  expectTypeOf(check).toBeFunction();
});
