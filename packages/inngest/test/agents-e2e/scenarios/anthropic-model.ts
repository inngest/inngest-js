/**
 * @module
 * `anthropic()` in a real run: a loop whose model is the Anthropic adapter,
 * answered by two replies recorded from the live API
 * (`fixtures/anthropic-haiku.json`, made by `pnpm test:anthropic-live`). The
 * run keeps one durable step per model call, prices the cached tokens, writes
 * the cache scores, and a second loop in the same run takes its own step IDs.
 */
import { readFileSync } from "node:fs";
import { tool } from "inngest/experimental";
import {
  type AnthropicClient,
  type AnthropicReply,
  agent,
  anthropic,
  anthropicPrices,
} from "inngest/experimental/agents";
import { z } from "zod/v4";
import { scenario } from "../kit/driver.ts";

const recorded = JSON.parse(
  readFileSync(
    new URL("../fixtures/anthropic-haiku.json", import.meta.url),
    "utf8",
  ),
) as { model: string; replies: AnthropicReply[] };

/**
 * Answers from the recording: the reply that called the tool for a request
 * that has none of its results yet, and the final one otherwise.
 */
const replay = (): AnthropicClient => {
  return {
    messages: {
      create: async (body: {
        tools?: unknown[];
        messages: { content: unknown[] }[];
      }) => {
        const [toolCall, final] = recorded.replies as [
          AnthropicReply,
          AnthropicReply,
        ];
        const results = body.messages.some((message) => {
          return JSON.stringify(message.content).includes("tool_result");
        });

        return body.tools && !results ? toolCall : final;
      },
    },
  };
};

export const anthropicModel = scenario({
  id: "anthropic-model",
  owner: "agents-anthropic",
  functions: ({ client, event }) => {
    return [
      client.createFunction(
        { id: "anthropic-model-fn", triggers: [{ event: event("go") }] },
        async () => {
          const add = tool.step({
            description: "Adds numbers",
            input: z.object({ a: z.number(), b: z.number() }),
            run: ({ a, b }) => {
              return a + b;
            },
          });
          const model = anthropic({
            model: recorded.model,
            client: replay(),
          });
          const first = await agent.loop({
            model,
            system: "Be terse.",
            prompt: "What is 2 + 3?",
            tools: { add },
            context: false,
            price: anthropicPrices,
          });
          const second = await agent.loop({
            model,
            prompt: "Say the answer.",
            price: anthropicPrices,
          });

          return {
            text: first.text,
            stopped: first.stopped,
            usage: first.usage,
            secondText: second.text,
          };
        },
      ),
    ];
  },
  run: async (ctx) => {
    const run = await ctx.finished(
      await ctx.send("go", {}, { startsRun: true }),
    );

    ctx.expect.run(run).toComplete();
    ctx.expect
      .run(run)
      .toHaveSteps(
        "agent:model:1",
        "agent:1.0:add",
        "agent:model:2",
        "agent-2:model:1",
      );

    const output = run.output as {
      text: string;
      stopped: string;
      usage: {
        input: number;
        output: number;
        usd: number;
        cacheWrite: number;
        cacheRead: number;
      };
      secondText: string;
    };
    const [call, last] = recorded.replies.map((reply) => {
      return reply.usage;
    }) as [AnthropicReply["usage"], AnthropicReply["usage"]];

    ctx.check(
      "the loop ends done with the recorded answer",
      output.stopped === "done" &&
        output.text === "5" &&
        output.secondText === "5",
      output,
    );
    ctx.check(
      "usage adds the recorded cache writes and reads to the input",
      output.usage.cacheWrite ===
        (call.cache_creation_input_tokens ?? 0) +
          (last.cache_creation_input_tokens ?? 0) &&
        output.usage.cacheRead === (last.cache_read_input_tokens ?? 0) &&
        output.usage.input >= output.usage.cacheRead + output.usage.cacheWrite,
      output.usage,
    );
    ctx.check(
      "the cost is priced from the default table",
      output.usage.usd > 0 && output.usage.usd < 0.01,
      output.usage,
    );

    const scores = await ctx.scores(run.id);
    const second = scores.step("agent:model:2");

    ctx.check(
      "the second model step has its cache scores",
      second["agent.cache_read_tokens"] === (last.cache_read_input_tokens ?? 0),
      second,
    );
  },
});
