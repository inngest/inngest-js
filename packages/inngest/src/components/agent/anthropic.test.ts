/**
 * @module
 * Tests for `anthropic()`: the request it builds, the cache breakpoints, the
 * reply it maps back, usage and cost, and how errors are sorted. A fake client
 * stands in for the SDK.
 */
import { describe, expect, test } from "vitest";
import { NonRetriableError } from "../NonRetriableError.ts";
import { RetryAfterError } from "../RetryAfterError.ts";
import {
  type AnthropicClient,
  type AnthropicOptions,
  type AnthropicReply,
  anthropic,
  anthropicPrices,
} from "./anthropic.ts";
import { priceOf } from "./cost.ts";
import type { AgentModelRequest } from "./loop.ts";

const reply = (over: Partial<AnthropicReply> = {}): AnthropicReply => {
  return {
    content: [{ type: "text", text: "hi", citations: null } as never],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
    ...over,
  };
};

// A request body, read loosely by the assertions.
// biome-ignore lint/suspicious/noExplicitAny: the assertions index into it
type Body = Record<string, any>;

/**
 * A client that answers from `replies` and keeps every request body.
 */
const fakeClient = (
  replies: (AnthropicReply | Error)[] = [reply()],
): {
  client: AnthropicClient;
  bodies: Body[];
  streamed: number;
} => {
  const bodies: Body[] = [];
  const state = { streamed: 0 };
  const next = async (body: Body) => {
    bodies.push(structuredClone(body));

    const answer = replies[bodies.length - 1] ?? replies[replies.length - 1];

    if (answer instanceof Error) {
      throw answer;
    }

    return answer as AnthropicReply;
  };

  return {
    bodies,
    get streamed() {
      return state.streamed;
    },
    client: {
      messages: {
        create: next,
        stream: (body: Body) => {
          state.streamed += 1;

          return { finalMessage: () => next(body) };
        },
      },
    },
  };
};

const sent = (fake: { bodies: Body[] }, index: number): Body => {
  return fake.bodies[index] as Body;
};

const request = (over: Partial<AgentModelRequest> = {}): AgentModelRequest => {
  return {
    system: "Be brief.",
    messages: [{ role: "user", content: "go" }],
    tools: [{ name: "add", input_schema: { type: "object" } }],
    turn: 1,
    maxTurns: 10,
    ...over,
  };
};

const make = (
  fake: ReturnType<typeof fakeClient>,
  options: Partial<AnthropicOptions> = {},
) => {
  return anthropic({
    model: "claude-sonnet-5-5",
    client: fake.client,
    ...options,
  });
};

describe("anthropic request", () => {
  test("sends the model, a default maxTokens, and a breakpoint on the system prompt and the last block", async () => {
    const fake = fakeClient();

    await make(fake)(request());

    expect(sent(fake, 0)).toEqual({
      model: "claude-sonnet-5-5",
      max_tokens: 16000,
      system: [
        {
          type: "text",
          text: "Be brief.",
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [{ name: "add", input_schema: { type: "object" } }],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "go",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    });
  });

  test("the one-hour lifetime goes on every breakpoint", async () => {
    const fake = fakeClient();

    await make(fake, { cache: { ttl: "1h" } })(request());

    const marks = JSON.stringify(sent(fake, 0)).match(/"ttl":"1h"/g);

    expect(marks).toHaveLength(2);
  });

  test("cache: false sends no breakpoints", async () => {
    const fake = fakeClient();

    await make(fake, { cache: false })(request());

    expect(JSON.stringify(sent(fake, 0))).not.toContain("cache_control");
  });

  test("with no system prompt the last tool carries the breakpoint", async () => {
    const fake = fakeClient();

    await make(fake)(
      request({
        system: undefined,
        tools: [
          { name: "a", input_schema: { type: "object" } },
          { name: "b", input_schema: { type: "object" } },
        ],
      }),
    );

    const { tools, system } = sent(fake, 0);

    expect(system).toBeUndefined();
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: "ephemeral" });
  });

  test("no tools sends no tools field, and a wrap-up turn forbids tool use only when there are tools", async () => {
    const fake = fakeClient();
    const claude = make(fake);

    await claude(request({ tools: [], toolChoice: "none" }));
    await claude(request({ toolChoice: "none" }));

    expect(sent(fake, 0).tools).toBeUndefined();
    expect(sent(fake, 0).tool_choice).toBeUndefined();
    expect(sent(fake, 1).tool_choice).toEqual({ type: "none" });
  });

  test("effort, thinking and params are sent, params last", async () => {
    const fake = fakeClient();

    await make(fake, {
      effort: "high",
      thinking: { type: "adaptive", display: "summarized" },
      maxTokens: 2000,
      params: { metadata: { user_id: "u" }, max_tokens: 99 },
    })(request());

    expect(sent(fake, 0)).toMatchObject({
      output_config: { effort: "high" },
      thinking: { type: "adaptive", display: "summarized" },
      metadata: { user_id: "u" },
      max_tokens: 99,
    });
  });

  test("volatile text goes after the breakpoint, in the last user message", async () => {
    const fake = fakeClient();

    await make(fake, { volatile: (r) => `turn ${r.turn}` })(
      request({ turn: 3 }),
    );

    const content = sent(fake, 0).messages[0].content;

    expect(content).toEqual([
      { type: "text", text: "go", cache_control: { type: "ephemeral" } },
      { type: "text", text: "turn 3" },
    ]);
  });

  test("tool results become one user message of tool_result blocks, errors flagged, and steering joins them", async () => {
    const fake = fakeClient();

    await make(fake)(
      request({
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "a", name: "add", input: { a: 1 } },
              { type: "tool_use", id: "b", name: "add", input: { a: 2 } },
            ],
          },
          {
            role: "tool",
            results: [
              { toolCallId: "a", name: "add", input: {}, content: "1" },
              {
                toolCallId: "b",
                name: "add",
                input: {},
                content: "boom",
                isError: true,
              },
            ],
          },
          { role: "user", content: "also this" },
        ],
      }),
    );

    const messages = sent(fake, 0).messages;

    expect(messages.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "a", content: "1" },
      {
        type: "tool_result",
        tool_use_id: "b",
        content: "boom",
        is_error: true,
      },
      {
        type: "text",
        text: "also this",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  test("a second breakpoint marks where the previous call's conversation ended, and an empty tool result is filled", async () => {
    const fake = fakeClient();

    await make(fake)(
      request({
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "a", name: "add", input: {} }],
          },
          {
            role: "tool",
            results: [{ toolCallId: "a", name: "add", input: {}, content: "" }],
          },
        ],
      }),
    );

    const messages = sent(fake, 0).messages;

    expect(messages[0].content[0].cache_control).toEqual({
      type: "ephemeral",
    });
    expect(messages[1].content[0].cache_control).toBeUndefined();
    expect(messages[2].content[0]).toMatchObject({
      content: "(no output)",
      cache_control: { type: "ephemeral" },
    });
  });

  test("joining adjacent messages leaves the loop's history untouched", async () => {
    const fake = fakeClient();
    const first = {
      role: "assistant" as const,
      content: [{ type: "text", text: "a" }],
    };
    const second = {
      role: "assistant" as const,
      content: [{ type: "text", text: "b" }],
    };
    const messages = [{ role: "user" as const, content: "go" }, first, second];
    const claude = make(fake);

    await claude(request({ messages }));
    await claude(request({ messages }));

    expect(first.content).toHaveLength(1);
    expect(sent(fake, 1).messages[1].content).toHaveLength(2);
  });

  test("streams above 21000 maxTokens, or when asked", async () => {
    const fake = fakeClient();

    await make(fake)(request());
    await make(fake, { maxTokens: 64000 })(request());
    await make(fake, { stream: true })(request());

    expect(fake.streamed).toBe(2);
  });

  test("passes timeout and maxRetries to the call", async () => {
    const seen: unknown[] = [];
    const claude = anthropic({
      model: "m",
      timeout: 1000,
      maxRetries: 2,
      client: {
        messages: {
          create: async (_body: unknown, options: unknown) => {
            seen.push(options);

            return reply();
          },
        },
      },
    });

    await claude(request());

    expect(seen).toEqual([{ timeout: 1000, maxRetries: 2 }]);
  });
});

describe("anthropic reply", () => {
  test("keeps thinking blocks with their signatures, drops extra fields, and returns text, calls and the model", async () => {
    const fake = fakeClient([
      reply({
        content: [
          { type: "thinking", thinking: "hm", signature: "sig", extra: 1 },
          { type: "redacted_thinking", data: "xx" },
          { type: "text", text: "one ", citations: null },
          { type: "text", text: "two" },
          {
            type: "tool_use",
            id: "t1",
            name: "add",
            input: { a: 1 },
            caller: {},
          },
          { type: "tool_use", id: "t2", name: "add", input: { a: 2 } },
        ] as never,
        stop_reason: "tool_use",
      }),
    ]);

    const answer = await make(fake)(request());

    expect(answer).toEqual({
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hm", signature: "sig" },
          { type: "redacted_thinking", data: "xx" },
          { type: "text", text: "one " },
          { type: "text", text: "two" },
          { type: "tool_use", id: "t1", name: "add", input: { a: 1 } },
          { type: "tool_use", id: "t2", name: "add", input: { a: 2 } },
        ],
      },
      text: "one two",
      toolCalls: [
        { id: "t1", name: "add", input: { a: 1 } },
        { id: "t2", name: "add", input: { a: 2 } },
      ],
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
      },
      model: "claude-sonnet-5-5",
    });
  });

  test("a reply with no content is sent back as a placeholder", async () => {
    const fake = fakeClient([reply({ content: [] })]);
    const claude = make(fake);
    const answer = await claude(request());

    expect(answer.message.content).toEqual([]);

    await claude(
      request({
        messages: [{ role: "user", content: "go" }, answer.message],
      }),
    );

    expect(sent(fake, 1).messages[1].content).toMatchObject([
      { type: "text", text: "(no reply)" },
    ]);
  });

  test("usage counts cached tokens in input and splits the one-hour writes", async () => {
    const fake = fakeClient([
      reply({
        usage: {
          input_tokens: 50,
          output_tokens: 7,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 200,
          cache_creation: { ephemeral_1h_input_tokens: 200 },
        },
      }),
    ]);

    const answer = await make(fake)(request());

    expect(answer.usage).toEqual({
      input: 1250,
      output: 7,
      cacheRead: 1000,
      cacheWrite: 200,
      cacheWrite1h: 200,
    });
  });

  test("a refusal fails for good, with its category", async () => {
    const fake = fakeClient([
      reply({
        stop_reason: "refusal",
        stop_details: { category: "cyber", explanation: "no" },
      }),
    ]);

    await expect(make(fake)(request())).rejects.toThrow(
      "refused the request (cyber): no",
    );
    await expect(make(fake)(request())).rejects.toBeInstanceOf(
      NonRetriableError,
    );
  });

  test("a reply cut off, in a tool call or in text, fails for good", async () => {
    const tool = reply({
      stop_reason: "max_tokens",
      content: [{ type: "tool_use", id: "t", name: "add", input: {} }] as never,
    });

    await expect(make(fakeClient([tool]))(request())).rejects.toThrow(
      "raise maxTokens",
    );
    await expect(
      make(fakeClient([reply({ stop_reason: "max_tokens" })]))(request()),
    ).rejects.toBeInstanceOf(NonRetriableError);
    await expect(
      make(fakeClient([reply({ stop_reason: "pause_turn" })]))(request()),
    ).rejects.toThrow("pause_turn");
  });

  test("empty text blocks are dropped from the reply", async () => {
    const answer = await make(
      fakeClient([
        reply({
          content: [
            { type: "text", text: "" },
            { type: "text", text: "ok" },
          ] as never,
        }),
      ]),
    )(request());

    expect(answer.message.content).toEqual([{ type: "text", text: "ok" }]);
  });
});

describe("anthropic cost", () => {
  test("prices cache reads and writes at their own rates", () => {
    const usage = {
      input: 1_000_000 + 1_000_000 + 1_000_000 + 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 2_000_000,
      cacheWrite1h: 1_000_000,
    };

    // plain 1M at 2, read 1M at 0.2, 5m write 1M at 2.5, 1h write 1M at 4,
    // output 1M at 10.
    expect(priceOf(anthropicPrices, usage, "claude-sonnet-5-5")).toBeCloseTo(
      18.7,
    );
  });

  test("a table without cache rates prices cached tokens as input", () => {
    expect(
      priceOf(
        { m: { input: 1, output: 2 } },
        {
          input: 1_000_000,
          output: 0,
          cacheRead: 500_000,
          cacheWrite: 500_000,
        },
        "m",
      ),
    ).toBeCloseTo(1);
  });

  test("the default table names the current models", () => {
    for (const id of [
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]) {
      expect(anthropicPrices[id]?.output).toBeGreaterThan(0);
    }

    expect(anthropicPrices["claude-opus-5-5"]?.cacheRead).toBeCloseTo(0.2);
    expect(anthropicPrices["claude-fable-5-1"]?.cacheRead).toBeCloseTo(0.25);
  });
});

describe("anthropic errors", () => {
  const apiError = (
    status: number,
    headers?: Record<string, string>,
  ): Error => {
    return Object.assign(new Error(`status ${status}`), { status, headers });
  };

  test.each([400, 401, 403, 404, 413])("a %i is final", async (status) => {
    const fake = fakeClient([apiError(status)]);

    await expect(make(fake)(request())).rejects.toBeInstanceOf(
      NonRetriableError,
    );
  });

  test.each([408, 409, 500, 502, 529])(
    "a %i is retried as it is",
    async (status) => {
      const fake = fakeClient([apiError(status)]);
      const error = await make(fake)(request()).catch((caught) => caught);

      expect(error).not.toBeInstanceOf(NonRetriableError);
      expect(error).not.toBeInstanceOf(RetryAfterError);
      expect(error.status).toBe(status);
    },
  );

  test("a 429 with retry-after waits that long", async () => {
    const fake = fakeClient([apiError(429, { "retry-after": "7" })]);
    const error = await make(fake)(request()).catch((caught) => caught);

    expect(error).toBeInstanceOf(RetryAfterError);
    expect(error.retryAfter).toBeDefined();
  });

  test("retry-after read from a Headers object, in milliseconds when given", async () => {
    const error = Object.assign(new Error("slow down"), {
      status: 429,
      headers: new Headers({ "retry-after-ms": "1500" }),
    });
    const caught = await make(fakeClient([error]))(request()).catch((e) => e);

    expect(caught).toBeInstanceOf(RetryAfterError);
  });

  test("a network error is retried", async () => {
    const fake = fakeClient([new Error("ECONNRESET")]);
    const error = await make(fake)(request()).catch((caught) => caught);

    expect(error.message).toBe("ECONNRESET");
    expect(error).not.toBeInstanceOf(NonRetriableError);
  });

  test("streaming without messages.stream fails for good", async () => {
    const claude = anthropic({
      model: "m",
      stream: true,
      client: { messages: { create: async () => reply() } },
    });

    await expect(claude(request())).rejects.toBeInstanceOf(NonRetriableError);
  });
});
