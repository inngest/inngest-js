/**
 * @module
 * Type tests for `anthropic()`: a real `@anthropic-ai/sdk` client fits
 * `client`, the result is an `AgentModel` that `agent.loop()` takes, and its
 * options are checked. The closures hold type-only code that never runs.
 */
import Anthropic from "@anthropic-ai/sdk";
import { expectTypeOf, test } from "vitest";
import { z } from "zod/v4";
import { typesOnly } from "../agent/typeFixtures.ts";
import type { AgentModel, AgentPriceTable } from "../index.ts";
import { agent } from "../index.ts";
import {
  type AnthropicClient,
  type AnthropicModel,
  type AnthropicReply,
  anthropic,
  anthropicPrices,
} from "./anthropic.ts";

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
    expectTypeOf(anthropicPrices).toEqualTypeOf<AgentPriceTable>();

    // A loop with a model needs nothing else.
    void agent.loop({ model, price: anthropicPrices })("hi");

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

test("loop: the Anthropic client type takes no any and fits a typed client", () => {
  typesOnly(() => {
    expectTypeOf<
      Parameters<AnthropicClient["messages"]["create"]>[0]
    >().not.toBeAny();
    expectTypeOf<
      Parameters<AnthropicClient["messages"]["create"]>[1]
    >().not.toBeAny();

    const fake: AnthropicClient = {
      messages: {
        create: async (params: { model: string }): Promise<AnthropicReply> => {
          return { model: params.model } as unknown as AnthropicReply;
        },
      },
    };

    anthropic({ model: "claude-sonnet-4-5", client: fake });
    anthropic({ model: "claude-sonnet-4-5", client: new Anthropic() });
  });
});

test("loop: anthropic() types a structured reply and with() keeps the model type", () => {
  typesOnly(async () => {
    const model = anthropic({ model: "claude-sonnet-4-5" });
    const reply = await model({
      prompt: "How many?",
      output: z.object({ answer: z.string(), count: z.number() }),
    });

    expectTypeOf(reply.output).toEqualTypeOf<{
      answer: string;
      count: number;
    }>();
    expectTypeOf(model.with({ effort: "low", maxTokens: 50 })).toEqualTypeOf<
      typeof model
    >();

    const plain = await model({ prompt: "Hi" });

    expectTypeOf(plain.text).toEqualTypeOf<string | undefined>();
  });
});
