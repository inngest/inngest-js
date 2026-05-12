import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { KnownKeys } from "../helpers/types.ts";
import { StepMode, StepOpCode } from "../types.ts";
import * as als from "./execution/als.ts";
import { Inngest, internalLoggerSymbol } from "./Inngest.ts";
import type { InngestFunction } from "./InngestFunction.ts";
import {
  type SendScoreOptions,
  scoreMiddleware,
  type scoreSymbol,
  sendScore,
  sendStepScore,
} from "./InngestScore.ts";
import type { ExperimentalStepTools } from "./InngestStepTools.ts";

type Not<T extends boolean> = T extends true ? false : true;

type HasProperty<
  T,
  I extends string | number | symbol,
  E extends string | number | symbol = "",
> = T extends {
  [K in I]: unknown;
}
  ? Not<HasProperty<T, E>>
  : false;

const mockLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
});

const mockClient = () =>
  ({
    updateMetadata: vi.fn().mockResolvedValue(undefined),
    logger: mockLogger(),
    [internalLoggerSymbol]: mockLogger(),
  }) as unknown as Inngest;

const spyOnUpdateMetadata = (client: Inngest) =>
  vi
    .spyOn(
      client as unknown as { updateMetadata: () => Promise<void> },
      "updateMetadata",
    )
    .mockResolvedValue(undefined);

async function startFunction(
  fn: InngestFunction.Any,
  client: Inngest.Any,
  disableImmediateExecution = true,
) {
  const execution = fn["createExecution"]({
    partialOptions: {
      client,
      data: fromPartial({
        event: { name: "test", data: {} },
        events: [{ name: "test", data: {} }],
        runId: "run",
        attempt: 0,
        maxAttempts: 1,
      }),
      runId: "run",
      stepState: {},
      stepCompletionOrder: [],
      handlerKind: "main",
      requestedRunStep: undefined,
      disableImmediateExecution,
      reqArgs: [],
      headers: {},
      stepMode: StepMode.Async,
      queueItemId: "fake-queue-item-id",
    },
  });

  return execution.start();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendScore", () => {
  test("inngest.score writes step-scoped score metadata via API", async () => {
    vi.spyOn(als, "getAsyncCtx").mockResolvedValue(undefined);
    const client = new Inngest({ id: "app" });
    const updateMetadata = spyOnUpdateMetadata(client);

    await client.score({
      runId: "run",
      stepId: "step",
      name: "accuracy",
      value: 1,
    });

    expect(updateMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          run_id: "run",
          step_id: "step",
        }),
        metadata: [
          {
            kind: "inngest.score",
            op: "merge",
            values: { accuracy: 1 },
          },
        ],
      }),
    );
  });

  test("batches score metadata when targeting the current step", async () => {
    const addMetadata = vi.fn(() => true);
    vi.spyOn(als, "getAsyncCtx").mockResolvedValue({
      execution: {
        ctx: { runId: "run", attempt: 0 },
        executingStep: { id: "step" },
        instance: { addMetadata },
      },
    } as unknown as als.AsyncContext);

    const client = mockClient();
    await sendScore(client, {
      runId: "run",
      stepId: "step",
      name: "accuracy",
      value: 0.9,
    });

    expect(addMetadata).toHaveBeenCalledWith(
      "step",
      "inngest.score",
      "step",
      "merge",
      { accuracy: 0.9 },
    );
    expect(client["updateMetadata"]).not.toHaveBeenCalled();
  });

  test("batches score metadata when targeting the current indexed step by userland ID", async () => {
    const addMetadata = vi.fn(() => true);
    vi.spyOn(als, "getAsyncCtx").mockResolvedValue({
      execution: {
        ctx: { runId: "run", attempt: 0 },
        executingStep: {
          id: "my-step:1",
          userlandId: "my-step",
          userlandIndex: 1,
        },
        instance: { addMetadata },
      },
    } as unknown as als.AsyncContext);

    const client = mockClient();
    await sendScore(client, {
      runId: "run",
      stepId: "my-step",
      name: "accuracy",
      value: 0.9,
    });

    expect(addMetadata).toHaveBeenCalledWith(
      "my-step:1",
      "inngest.score",
      "step",
      "merge",
      { accuracy: 0.9 },
    );
    expect(client["updateMetadata"]).not.toHaveBeenCalled();
  });

  test("uses current step index when an indexed current-step write falls back to API", async () => {
    vi.spyOn(als, "getAsyncCtx").mockResolvedValue({
      execution: {
        ctx: { runId: "run", attempt: 0 },
        executingStep: {
          id: "my-step:1",
          userlandId: "my-step",
          userlandIndex: 1,
        },
        instance: { addMetadata: vi.fn(() => false) },
      },
    } as unknown as als.AsyncContext);

    const client = mockClient();
    await sendScore(client, {
      runId: "run",
      stepId: "my-step",
      name: "accuracy",
      value: 0.9,
    });

    expect(client["updateMetadata"]).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          run_id: "run",
          step_id: "my-step",
          step_index: 1,
        }),
      }),
    );
  });

  test("sends stepIndex when targeting a different indexed step", async () => {
    vi.spyOn(als, "getAsyncCtx").mockResolvedValue({
      execution: {
        ctx: { runId: "run", attempt: 0 },
        executingStep: {
          id: "my-step:1",
          userlandId: "my-step",
          userlandIndex: 1,
        },
        instance: { addMetadata: vi.fn(() => true) },
      },
    } as unknown as als.AsyncContext);

    const client = mockClient();
    await sendScore(client, {
      runId: "run",
      stepId: "my-step",
      stepIndex: 0,
      name: "accuracy",
      value: 0.9,
    });

    expect(client["updateMetadata"]).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          run_id: "run",
          step_id: "my-step",
          step_index: 0,
        }),
        metadata: [
          {
            kind: "inngest.score",
            op: "merge",
            values: { accuracy: 0.9 },
          },
        ],
      }),
    );
  });

  test("rejects missing step context before writing score metadata", async () => {
    vi.spyOn(als, "getAsyncCtx").mockResolvedValue(undefined);
    const client = mockClient();

    await expect(
      sendStepScore(client, {
        runId: "run",
        name: "accuracy",
        value: 1,
      }),
    ).rejects.toThrow("step() was called without a value");
    expect(client["updateMetadata"]).not.toHaveBeenCalled();
  });

  test("rejects invalid score input", async () => {
    const client = mockClient();

    await expect(
      sendScore(client, undefined as unknown as SendScoreOptions),
    ).rejects.toThrow("score options must be an object");

    await expect(
      sendScore(client, {
        runId: "",
        stepId: "step",
        name: "accuracy",
        value: 1,
      }),
    ).rejects.toThrow("runId must be a non-empty string");

    await expect(
      sendScore(client, {
        runId: "run",
        stepId: "",
        name: "accuracy",
        value: 1,
      }),
    ).rejects.toThrow("stepId must be a non-empty string");

    await expect(
      sendScore(client, {
        runId: "run",
        stepId: "step",
        value: 1,
      } as unknown as SendScoreOptions),
    ).rejects.toThrow("invalid score name");

    await expect(
      sendScore(client, {
        runId: "run",
        stepId: "step",
        name: "bad-name",
        value: 1,
      }),
    ).rejects.toThrow("invalid score name");

    await expect(
      sendScore(client, {
        runId: "run",
        stepId: "step",
        name: "accuracy",
        value: Number.NaN,
      }),
    ).rejects.toThrow("finite number");

    await expect(
      sendScore(client, {
        runId: "run",
        stepId: "step",
        name: "accuracy",
        value: true as unknown as number,
      }),
    ).rejects.toThrow("finite number");

    await expect(
      sendScore(client, {
        runId: "run",
        stepId: "step",
        stepIndex: 1.5,
        name: "accuracy",
        value: 1,
      }),
    ).rejects.toThrow("stepIndex must be a non-negative integer");
  });

  test("rejects explicitly empty step.score target ids", async () => {
    const client = mockClient();

    await expect(
      sendStepScore(client, {
        stepId: "",
        name: "accuracy",
        value: 1,
      }),
    ).rejects.toThrow("stepId must be a non-empty string");
  });
});

describe("scoreMiddleware", () => {
  test("score is only present as a step tool if the middleware is used", () => {
    const inngestWithoutMiddleware = new Inngest({
      id: "test",
      eventKey: "test-key-123",
    });

    inngestWithoutMiddleware.createFunction(
      { id: "test", triggers: [{ event: "foo" }] },
      ({ step }) => {
        assertType<HasProperty<typeof step, "score">>(false);
      },
    );

    const inngestWithMiddleware = new Inngest({
      id: "test",
      eventKey: "test-key-123",
      middleware: [scoreMiddleware()],
    });

    inngestWithMiddleware.createFunction(
      { id: "test", triggers: [{ event: "foo" }] },
      ({ step }) => {
        assertType<HasProperty<typeof step, "score">>(true);
        assertType<ExperimentalStepTools[typeof scoreSymbol]>(step.score);
        assertType<KnownKeys<typeof step>>("score");
      },
    );
  });

  test("step.score emits a durable score step", async () => {
    const client = new Inngest({
      id: "app",
      middleware: [scoreMiddleware()],
    });
    const fn = client.createFunction(
      { id: "fn", triggers: { event: "test" } },
      async ({ step }) => {
        await step.score("accuracy", { name: "accuracy", value: 1 });
      },
    );

    const result = await startFunction(fn, client);

    expect(result.type).toBe("steps-found");
    if (result.type !== "steps-found") {
      throw new Error(`Expected steps-found, got ${result.type}`);
    }

    expect(result.steps[0]).toEqual(
      expect.objectContaining({
        op: StepOpCode.StepPlanned,
        id: expect.any(String),
        displayName: "score:accuracy",
        userland: { id: "score:accuracy" },
      }),
    );
  });

  test("step.score rejects invalid input before planning a durable step", async () => {
    const client = new Inngest({
      id: "app",
      middleware: [scoreMiddleware()],
    });
    const fn = client.createFunction(
      { id: "fn", triggers: { event: "test" } },
      async ({ step }) => {
        await step.score("accuracy", { name: "bad-name", value: 1 });
      },
    );

    const result = await startFunction(fn, client);

    expect(result.type).toBe("function-rejected");
    if (result.type !== "function-rejected") {
      throw new Error(`Expected function-rejected, got ${result.type}`);
    }

    expect(result.error).toMatchObject({
      message: expect.stringContaining("invalid score name"),
    });
  });

  test("step.score batches when the score step executes immediately", async () => {
    const client = new Inngest({
      id: "app",
      middleware: [scoreMiddleware()],
    });
    const updateMetadata = spyOnUpdateMetadata(client);
    const fn = client.createFunction(
      { id: "fn", triggers: { event: "test" } },
      async ({ step }) => {
        await step.score("accuracy", { name: "accuracy", value: 1 });
      },
    );

    const result = await startFunction(fn, client, false);

    expect(result.type).toBe("step-ran");
    if (result.type !== "step-ran") {
      throw new Error(`Expected step-ran, got ${result.type}`);
    }

    expect(result.step).toEqual(
      expect.objectContaining({
        metadata: [
          {
            kind: "inngest.score",
            scope: "step",
            op: "merge",
            values: { accuracy: 1 },
          },
        ],
      }),
    );
    expect(updateMetadata).not.toHaveBeenCalled();
  });
});
