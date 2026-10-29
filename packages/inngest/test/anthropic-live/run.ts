/**
 * @module
 * A real-API smoke test of `anthropic()`: two model calls on a conversation
 * that grows, checking that the second reads the first's cache, and that the
 * usage prices to a few cents or less. It needs ANTHROPIC_API_KEY in the
 * environment and prints token counts only, never the key. Set
 * ANTHROPIC_LIVE_RECORD to a file path to also write the two replies as a
 * fixture for the e2e scenario.
 *
 * Run it with `pnpm test:anthropic-live`.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  type AnthropicClient,
  type AnthropicReply,
  anthropic,
  anthropicPrices,
} from "../../src/components/agent/anthropic.ts";
import { priceOf } from "../../src/components/agent/cost.ts";
import type {
  AgentMessage,
  AgentModelRequest,
} from "../../src/components/agent/loop.ts";

const model = "claude-haiku-5-5";

// Long enough to pass the model's cache minimum, and different on every run
// so that the first call of a run writes the cache.
const system = `You are a terse assistant (${randomUUID()}). ${"Answer in as few words as you can, and use a tool when one fits. ".repeat(160)}`;

const tools = [
  {
    name: "add",
    description: "Adds two numbers",
    input_schema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];

const fail = (message: string): never => {
  console.error(`FAIL ${message}`);
  process.exit(1);
};

const main = async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    fail("ANTHROPIC_API_KEY is not set");
  }

  // The raw replies, for the fixture.
  const raw: AnthropicReply[] = [];
  const sdk = new Anthropic({ maxRetries: 0 });
  const recording: AnthropicClient = {
    messages: {
      create: async (body, options) => {
        const answer = await sdk.messages.create(body, options);

        raw.push(answer as unknown as AnthropicReply);

        return answer as unknown as AnthropicReply;
      },
    },
  };
  const claude = anthropic({
    model,
    client: recording,
    maxTokens: 400,
    cache: { ttl: "5m" },
  });
  const messages: AgentMessage[] = [
    { role: "user", content: "What is 2 + 3? Use the add tool." },
  ];
  const request = (turn: number): AgentModelRequest => {
    return { system, messages, tools, turn, maxTurns: 4 };
  };

  const first = await claude(request(1));
  console.log("call 1 usage", first.usage);

  const call = first.toolCalls[0];

  if (!call) {
    return fail("the model did not call the add tool");
  }

  messages.push(first.message, {
    role: "tool",
    results: [
      {
        toolCallId: call.id,
        name: call.name,
        input: call.input,
        content: "5",
      },
    ],
  });

  const second = await claude(request(2));
  console.log("call 2 usage", second.usage);

  if (!first.usage?.cacheWrite) {
    fail("call 1 wrote nothing to the cache");
  }

  if (!second.usage?.cacheRead) {
    fail("call 2 read nothing from the cache");
  }

  const usd =
    priceOf(anthropicPrices, first.usage, model) +
    priceOf(
      anthropicPrices,
      second.usage as NonNullable<typeof second.usage>,
      model,
    );

  console.log(
    `PASS cache read ${second.usage.cacheRead} tokens on call 2; cost $${usd.toFixed(5)}`,
  );

  if (usd > 0.05) {
    fail(`cost $${usd} is more than the smoke test should spend`);
  }

  // A different prefix, so the entry is new and shows its lifetime.
  const hour = await anthropic({
    model,
    client: new Anthropic({ maxRetries: 0 }),
    maxTokens: 50,
    cache: { ttl: "1h" },
  })({
    system: `${system} (one hour)`,
    messages: [{ role: "user", content: "Say hi." }],
    tools,
    turn: 1,
    maxTurns: 1,
  });

  console.log("1h usage", hour.usage);

  if (!hour.usage?.cacheWrite1h) {
    fail("the one-hour call wrote nothing with the one-hour lifetime");
  }

  if (process.env.ANTHROPIC_LIVE_RECORD) {
    writeFileSync(
      process.env.ANTHROPIC_LIVE_RECORD,
      `${JSON.stringify({ model, replies: raw.slice(0, 2) }, null, 2)}\n`,
    );
  }
};

await main();
