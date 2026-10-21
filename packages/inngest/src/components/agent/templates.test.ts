/**
 * @module
 * Tests for `agent.anthropic()` and `agent.openai()` with fake clients. The
 * real SDKs are checked in `packages/test-agent-models`.
 */
import { NonRetriableError } from "../NonRetriableError.ts";
import { RetryAfterError } from "../RetryAfterError.ts";
import { agent } from "./loop.ts";

const request = {
  messages: [{ role: "user" as const, content: "hi" }],
  tools: [],
  turn: 1,
  maxTurns: 3,
};

const failing = (status: number, headers: unknown) => {
  return {
    messages: {
      create: () => {
        return Promise.reject(
          Object.assign(new Error(`status ${status}`), { status, headers }),
        );
      },
    },
  };
};

describe("model errors", () => {
  test.each([400, 401, 403, 404, 413, 422])(
    "%s is not retried",
    async (status) => {
      const model = agent.anthropic(failing(status, {}) as never, {} as never);

      await expect(model(request)).rejects.toBeInstanceOf(NonRetriableError);
    },
  );

  test("429 waits for retry-after, from plain or Headers-like headers", async () => {
    const plain = agent.anthropic(
      failing(429, { "retry-after": "5" }) as never,
      {} as never,
    );
    const headers = agent.anthropic(
      failing(529, new Headers({ "retry-after": "9" })) as never,
      {} as never,
    );

    await expect(plain(request)).rejects.toMatchObject({
      name: "RetryAfterError",
      retryAfter: "5",
    });
    await expect(headers(request)).rejects.toBeInstanceOf(RetryAfterError);
  });

  test("an overload with no retry-after, and any other error, retry as usual", async () => {
    const slow = agent.anthropic(failing(529, {}) as never, {} as never);
    const broken = agent.anthropic(failing(500, {}) as never, {} as never);

    await expect(slow(request)).rejects.toMatchObject({ status: 529 });
    await expect(broken(request)).rejects.toMatchObject({ status: 500 });
  });

  test("works on the Responses client too", async () => {
    const model = agent.openai(
      {
        responses: {
          create: () => {
            return Promise.reject(
              Object.assign(new Error("x"), { status: 400 }),
            );
          },
        },
      } as never,
      {} as never,
    );

    await expect(model(request)).rejects.toBeInstanceOf(NonRetriableError);
  });
});

describe("params", () => {
  test("gets the request and the turn, and its result is what is sent", async () => {
    const sent: unknown[] = [];
    const model = agent.anthropic(
      {
        messages: {
          create: (body: unknown, options: unknown) => {
            sent.push([body, options]);

            return Promise.resolve({ content: [], usage: undefined });
          },
        },
      } as never,
      {
        model: "m",
        max_tokens: 5,
        params: (params: unknown, turn: unknown) => {
          return { ...(params as object), seen: turn };
        },
      } as never,
    );

    await model(request);

    expect(sent).toEqual([
      [
        expect.objectContaining({
          model: "m",
          max_tokens: 5,
          seen: { turn: 1, maxTurns: 3 },
        }),
        { maxRetries: 0 },
      ],
    ]);
  });
});
