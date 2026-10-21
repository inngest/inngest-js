/**
 * @module
 * Checks `agent.anthropic()` and `agent.openai()` against the real vendor
 * SDKs, which only this package installs: the types come from the client you
 * pass, and a real client's errors and retries behave as the templates expect.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { describe, expect, expectTypeOf, test } from "vitest";

import { agent } from "../inngest/src/components/agent/index.ts";
import { NonRetriableError } from "../inngest/src/components/NonRetriableError.ts";
import { RetryAfterError } from "../inngest/src/components/RetryAfterError.ts";

const request = {
  messages: [{ role: "user" as const, content: "hi" }],
  tools: [],
  turn: 1,
  maxTurns: 3,
};

const jsonResponse = (status: number, body: unknown, headers = {}) => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
};

describe("types", () => {
  test("a real Anthropic client is accepted and typed", () => {
    const model = agent.anthropic(new Anthropic({ apiKey: "k" }), {
      model: "claude-sonnet-5-5",
      max_tokens: 1024,
      temperature: 0.2,
      params: (params, { turn }) => {
        expectTypeOf(turn).toBeNumber();
        expectTypeOf(params.max_tokens).toBeNumber();

        return { ...params, thinking: { type: "adaptive" } };
      },
    });

    expectTypeOf(model).toBeFunction();
  });

  test("Anthropic options are checked", () => {
    const client = new Anthropic({ apiKey: "k" });

    // @ts-expect-error model and max_tokens are required
    agent.anthropic(client, {});

    // @ts-expect-error max_tokens is a number
    agent.anthropic(client, { model: "m", max_tokens: "lots" });

    // @ts-expect-error not a request option
    agent.anthropic(client, { model: "m", max_tokens: 1, nope: true });

    // @ts-expect-error we own messages
    agent.anthropic(client, { model: "m", max_tokens: 1, messages: [] });

    // @ts-expect-error streaming is not offered
    agent.anthropic(client, { model: "m", max_tokens: 1, stream: true });
  });

  test("Anthropic model is the SDK's own type", () => {
    type Options = Parameters<typeof agent.anthropic<Anthropic>>[1];

    expectTypeOf<Options["model"]>().toEqualTypeOf<Anthropic.Model>();
    expectTypeOf<"claude-sonnet-5-5">().toExtend<Options["model"]>();
  });

  test("a real OpenAI client is accepted and typed", () => {
    const model = agent.openai(new OpenAI({ apiKey: "k" }), {
      model: "gpt-5.1",
      max_output_tokens: 1024,
      params: (params) => {
        return { ...params, reasoning: { effort: "low" } };
      },
    });

    expectTypeOf(model).toBeFunction();
  });

  test("OpenAI options are checked", () => {
    const client = new OpenAI({ apiKey: "k" });

    // @ts-expect-error max_output_tokens is a number
    agent.openai(client, { model: "m", max_output_tokens: "lots" });

    // @ts-expect-error not a request option
    agent.openai(client, { model: "m", nope: true });

    // @ts-expect-error we own input
    agent.openai(client, { model: "m", input: "hi" });
  });

  test("something that is not a client is rejected", () => {
    // @ts-expect-error no messages.create
    agent.anthropic({}, { model: "m" });

    // @ts-expect-error no responses.create
    agent.openai(new Anthropic({ apiKey: "k" }), { model: "m" });
  });
});

describe("anthropic at runtime", () => {
  const modelWith = (respond: (init: RequestInit) => Response) => {
    let calls = 0;
    const client = new Anthropic({
      apiKey: "k",
      maxRetries: 5,
      fetch: async (_url, init) => {
        calls += 1;

        return respond(init as RequestInit);
      },
    });

    return {
      calls: () => calls,
      model: agent.anthropic(client, { model: "m", max_tokens: 10 }),
    };
  };

  test("maps a turn and returns the content verbatim", async () => {
    let sent: Record<string, unknown> = {};
    const content = [
      { type: "thinking", thinking: "hm", signature: "sig" },
      { type: "text", text: "ok" },
      { type: "tool_use", id: "t1", name: "read", input: { path: "a" } },
    ];
    const { model } = modelWith((init) => {
      sent = JSON.parse(init.body as string);

      return jsonResponse(200, {
        id: "m",
        type: "message",
        role: "assistant",
        model: "m",
        content,
        stop_reason: "tool_use",
        usage: { input_tokens: 3, output_tokens: 4 },
      });
    });
    const reply = await model({
      ...request,
      system: "sys",
      tools: [{ name: "read", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "text", text: "x" }] },
        {
          role: "tool",
          results: [
            {
              toolCallId: "t0",
              name: "read",
              input: {},
              content: "boom",
              isError: true,
            },
          ],
        },
      ],
    });

    expect(sent).toMatchObject({ system: "sys" });
    expect((sent.messages as unknown[])[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t0",
          content: "boom",
          is_error: true,
        },
      ],
    });
    expect(reply.message.content).toEqual(content);
    expect(reply.text).toBe("ok");
    expect(reply.toolCalls).toEqual([
      { id: "t1", name: "read", input: { path: "a" } },
    ]);
    expect(reply.usage).toEqual({ input: 3, output: 4 });
  });

  test("a bad request is not retried", async () => {
    const { model, calls } = modelWith(() => {
      return jsonResponse(400, {
        type: "error",
        error: { type: "x", message: "bad" },
      });
    });

    await expect(model(request)).rejects.toBeInstanceOf(NonRetriableError);
    expect(calls()).toBe(1);
  });

  test("a rate limit waits for retry-after, and the SDK does not retry", async () => {
    const { model, calls } = modelWith(() => {
      return jsonResponse(
        429,
        { type: "error", error: { type: "x", message: "slow" } },
        { "retry-after": "7" },
      );
    });
    const error = await model(request).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RetryAfterError);
    expect((error as RetryAfterError).retryAfter).toBe("7");
    expect(calls()).toBe(1);
  });

  test("params can change the request", async () => {
    let sent: Record<string, unknown> = {};
    const client = new Anthropic({
      apiKey: "k",
      fetch: async (_url, init) => {
        sent = JSON.parse((init as RequestInit).body as string);

        return jsonResponse(200, {
          content: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    const model = agent.anthropic(client, {
      model: "m",
      max_tokens: 10,
      params: (params) => {
        return { ...params, thinking: { type: "adaptive" } };
      },
    });

    await model({
      ...request,
      tools: [{ name: "a", input_schema: { type: "object" } }],
      toolChoice: "none",
    });

    expect(sent).toMatchObject({ thinking: { type: "adaptive" } });
    expect(sent).toMatchObject({ tool_choice: { type: "none" } });
  });
});

describe("openai at runtime", () => {
  const modelWith = (respond: (init: RequestInit) => Response) => {
    let calls = 0;
    const client = new OpenAI({
      apiKey: "k",
      maxRetries: 5,
      fetch: async (_url, init) => {
        calls += 1;

        return respond(init as RequestInit);
      },
    });

    return {
      calls: () => calls,
      model: agent.openai(client, { model: "m" }),
    };
  };

  test("maps a turn and returns the output items verbatim", async () => {
    let sent: Record<string, unknown> = {};
    const output = [
      { type: "reasoning", id: "r1", summary: [] },
      {
        type: "message",
        id: "m1",
        role: "assistant",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      },
      {
        type: "function_call",
        id: "f1",
        call_id: "c1",
        name: "read",
        arguments: '{"path":"a"}',
      },
    ];
    const { model } = modelWith((init) => {
      sent = JSON.parse(init.body as string);

      return jsonResponse(200, {
        id: "r",
        object: "response",
        output,
        usage: { input_tokens: 3, output_tokens: 4 },
      });
    });
    const reply = await model({
      ...request,
      system: "sys",
      tools: [
        { name: "read", description: "d", input_schema: { type: "object" } },
      ],
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [{ type: "reasoning", id: "r0", summary: [] }],
        },
        {
          role: "tool",
          results: [
            {
              toolCallId: "c0",
              name: "read",
              input: {},
              content: "boom",
              isError: true,
            },
          ],
        },
      ],
    });

    expect(sent).toMatchObject({ instructions: "sys" });
    expect((sent.tools as unknown[])[0]).toMatchObject({
      type: "function",
      name: "read",
      parameters: { type: "object" },
    });
    expect(sent.input).toEqual([
      { role: "user", content: "go" },
      { type: "reasoning", id: "r0", summary: [] },
      { type: "function_call_output", call_id: "c0", output: "Error: boom" },
    ]);
    expect(reply.message.content).toEqual(output);
    expect(reply.text).toBe("ok");
    expect(reply.toolCalls).toEqual([
      { id: "c1", name: "read", input: { path: "a" } },
    ]);
    expect(reply.usage).toEqual({ input: 3, output: 4 });
  });

  test("errors map by status", async () => {
    const bad = modelWith(() => {
      return jsonResponse(401, { error: { message: "no key" } });
    });
    const slow = modelWith(() => {
      return jsonResponse(
        429,
        { error: { message: "slow" } },
        { "retry-after": "2" },
      );
    });

    await expect(bad.model(request)).rejects.toBeInstanceOf(NonRetriableError);
    await expect(slow.model(request)).rejects.toBeInstanceOf(RetryAfterError);
    expect(bad.calls() + slow.calls()).toBe(2);
  });
});
