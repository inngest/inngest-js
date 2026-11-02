/**
 * @module
 * Tests for `classifyModelError` and the loop's use of the first.
 */

import { describe, expect, test } from "vitest";
import { Inngest } from "../../../components/Inngest.ts";
import { NonRetriableError } from "../../../components/NonRetriableError.ts";
import { RetryAfterError } from "../../../components/RetryAfterError.ts";
import { runFnWithStack, testClientId } from "../../../test/helpers.ts";
import { StepOpCode } from "../../../types.ts";
import { agent } from "./loop.ts";
import { failsOnceWithRetryAfter, model, runLoop } from "./loopKit.ts";
import { classifyModelError, sortModelError } from "./modelErrors.ts";

const failure = (fields: Record<string, unknown>, message = "boom") => {
  return Object.assign(new Error(message), fields);
};

describe("classifyModelError", () => {
  test.each([
    { name: "a 400", error: failure({ status: 400 }) },
    { name: "a 401", error: failure({ status: 401 }) },
    { name: "a 404", error: failure({ status: 404 }) },
    { name: "a 422", error: failure({ status: 422 }) },
    { name: "statusCode", error: failure({ statusCode: 400 }) },
    {
      name: "an AWS SDK 400",
      error: failure({ $metadata: { httpStatusCode: 400 } }),
    },
    { name: "response.status", error: failure({ response: { status: 403 } }) },
    {
      name: "an Anthropic body with no status",
      error: failure({
        error: { type: "error", error: { type: "invalid_request_error" } },
      }),
    },
    {
      name: "an OpenAI error type with no status",
      error: failure({ error: { type: "invalid_request_error" } }),
    },
    { name: "an OpenAI code", error: failure({ code: "invalid_api_key" }) },
    {
      name: "OpenAI out of quota, sent as a 429",
      error: failure({ status: 429, error: { type: "insufficient_quota" } }),
    },
  ])(
    "makes $name non-retriable, keeping the original as its cause",
    ({ error }) => {
      const classified = classifyModelError(error);

      expect(classified).toBeInstanceOf(NonRetriableError);
      expect((classified as NonRetriableError).message).toBe("boom");
      expect((classified as NonRetriableError).cause).toBe(error);
    },
  );

  test.each([
    { name: "a 408", error: failure({ status: 408 }) },
    { name: "a 409", error: failure({ status: 409 }) },
    { name: "a 429", error: failure({ status: 429 }) },
    {
      name: "an AWS SDK throttle",
      error: failure({ $metadata: { httpStatusCode: 429 } }),
    },
    { name: "a 500", error: failure({ status: 500 }) },
    { name: "a 529 overloaded", error: failure({ status: 529 }) },
    {
      name: "an overloaded error type",
      error: failure({ error: { type: "overloaded_error" } }),
    },
    {
      name: "a rate limit type with a 429",
      error: failure({ status: 429, error: { type: "rate_limit_error" } }),
    },
    { name: "a network error", error: failure({ code: "ECONNRESET" }) },
    { name: "an error with no status", error: new Error("boom") },
    {
      name: "a wrapper whose cause is an HTTP error",
      error: failure({ cause: { status: 404 } }),
    },
    {
      name: "a 500 whose body says invalid request",
      error: failure({ status: 500, error: { type: "invalid_request_error" } }),
    },
  ])("leaves $name to retry", ({ error }) => {
    expect(classifyModelError(error)).toBe(error);
  });

  test("passes through values that aren't objects and errors already non-retriable", () => {
    const already = new NonRetriableError("stop");

    expect(classifyModelError("text")).toBe("text");
    expect(classifyModelError(undefined)).toBeUndefined();
    expect(classifyModelError(already)).toBe(already);
  });
});

describe("agent.loop and model errors", () => {
  const stepOpOf = async (error: unknown) => {
    const client = new Inngest({ id: testClientId });
    const fn = client.createFunction(
      { id: "agent", triggers: [{ event: "agent/run" }] },
      async () => {
        await runLoop({
          model: model(async () => {
            throw error;
          }),
          prompt: "go",
          tools: {},
        });
      },
    );
    const found = await runFnWithStack(fn, {});
    const first = found.type === "steps-found" ? found.steps[0] : undefined;
    const ran = (await runFnWithStack(fn, {}, { runStep: first?.id })) as {
      step: { op: StepOpCode };
    };

    return ran.step.op;
  };

  test("fails a rejected request for good instead of retrying it", async () => {
    expect(await stepOpOf(failure({ status: 400 }))).toBe(
      StepOpCode.StepFailed,
    );
  });

  test("retries a rate limit and a server error", async () => {
    expect(await stepOpOf(failure({ status: 429 }))).toBe(StepOpCode.StepError);
    expect(await stepOpOf(failure({ status: 503 }))).toBe(StepOpCode.StepError);
  });
});

describe("retry-after for any model function", () => {
  const request = { messages: [], tools: [], turn: 1, maxTurns: 1 };
  const answer = model(async () => {
    return {
      message: { role: "assistant" as const, content: [] },
      toolCalls: [],
    };
  });

  test("a rate limit that names a wait becomes a retry after that wait, and the next call is made", async () => {
    const flaky = failsOnceWithRetryAfter(answer, 2);
    const error = await flaky(request).catch((caught) =>
      sortModelError(caught),
    );

    expect(error).toBeInstanceOf(RetryAfterError);
    expect(await flaky(request)).toMatchObject({ toolCalls: [] });
  });

  test("a final 4xx is not retried", () => {
    expect(sortModelError(failure({ status: 400 }))).toBeInstanceOf(
      NonRetriableError,
    );
  });

  test("a plain model function's rate limit makes the loop's model step retry", async () => {
    const client = new Inngest({ id: testClientId });
    const fn = client.createFunction(
      { id: "agent", triggers: [{ event: "agent/run" }] },
      async () => {
        await agent.loop({
          model: failsOnceWithRetryAfter(answer),
        })("go");
      },
    );
    const found = await runFnWithStack(fn, {});
    const first = found.type === "steps-found" ? found.steps[0] : undefined;
    const ran = (await runFnWithStack(fn, {}, { runStep: first?.id })) as {
      step: { op: StepOpCode };
    };

    expect(ran.step.op).toBe(StepOpCode.StepError);
  });
});
