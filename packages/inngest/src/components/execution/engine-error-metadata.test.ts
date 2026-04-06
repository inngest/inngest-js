import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ExecutionVersion } from "../../helpers/consts.ts";
import { createClient } from "../../test/helpers.ts";
import { StepMode } from "../../types.ts";
import { InngestFunction } from "../InngestFunction.ts";
import type { MetadataUpdate } from "../InngestMetadata.ts";

describe("Error path metadata propagation", () => {
  const mockEvent = { name: "test/event", data: {} };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Helper: create an execution in Async (non-checkpoint) mode.
   * In this mode, step errors produce "step-ran" with an error opcode.
   */
  function createAsyncExecution(
    client: ReturnType<typeof createClient>,
    fn: InngestFunction<any, any, any, any, any>,
    overrides?: Record<string, unknown>,
  ) {
    return fn["createExecution"]({
      partialOptions: {
        client,
        data: fromPartial({ event: mockEvent, runId: "test-run-id", ...overrides }),
        runId: "test-run-id",
        stepState: {},
        stepCompletionOrder: [],
        reqArgs: [],
        headers: {},
        stepMode: StepMode.Async,
      },
    });
  }

  test("retriable step error includes metadata in the step-ran result", async () => {
    const client = createClient({ id: "test" });

    const fn = new InngestFunction(
      client,
      {
        id: "test-fn",
        triggers: [{ event: "test/event" }],
        retries: 3,
      },
      async ({ step }) => {
        await step.run("failing-step", () => {
          throw new Error("test error");
        });
      },
    );

    const execution = createAsyncExecution(client, fn, { attempt: 0 });

    // Pre-populate metadata for the step (keyed by unhashed display name)
    const metadataUpdates: MetadataUpdate[] = [
      {
        kind: "userland.test",
        scope: "step",
        op: "merge",
        values: { error_context: "before-throw" },
      },
    ];
    (
      execution as unknown as {
        state: { metadata: Map<string, MetadataUpdate[]> };
      }
    ).state.metadata = new Map([["failing-step", metadataUpdates]]);

    const result = await execution.start();

    // With retries > 0 and attempt 0, the step error produces "step-ran"
    // with the error opcode, and metadata should be included.
    expect(result.type).toBe("step-ran");
    if (result.type === "step-ran") {
      expect(result.step.error).toBeDefined();
      expect(result.step.metadata).toBeDefined();
      expect(result.step.metadata).toEqual(metadataUpdates);
    }
  });

  test("function-level error flushes metadata via API", async () => {
    const client = createClient({ id: "test" });

    // Mock the updateMetadata API call
    const mockUpdateMetadata = vi.fn().mockResolvedValue(undefined);
    (client as unknown as { updateMetadata: typeof mockUpdateMetadata })
      .updateMetadata = mockUpdateMetadata;

    // Function throws outside of step.run — metadata set in an earlier step
    // is still in state.metadata when the function rejects
    const fn = new InngestFunction(
      client,
      { id: "test-fn", triggers: [{ event: "test/event" }] },
      async () => {
        throw new Error("function-level error");
      },
    );

    const execution = createAsyncExecution(client, fn);

    // Pre-populate metadata (simulating metadata from a prior step that completed)
    const metadataUpdates: MetadataUpdate[] = [
      {
        kind: "userland.test",
        scope: "step",
        op: "merge",
        values: { error_context: "before-throw" },
      },
    ];
    (
      execution as unknown as {
        state: { metadata: Map<string, MetadataUpdate[]> };
      }
    ).state.metadata = new Map([["prior-step", metadataUpdates]]);

    const result = await execution.start();

    // Function-level throw produces function-rejected
    expect(result.type).toBe("function-rejected");

    // The metadata should have been flushed via the API
    expect(mockUpdateMetadata).toHaveBeenCalledTimes(1);
    expect(mockUpdateMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          run_id: "test-run-id",
          step_id: "prior-step",
        }),
        metadata: expect.arrayContaining([
          expect.objectContaining({
            kind: "userland.test",
            values: { error_context: "before-throw" },
          }),
        ]),
      }),
    );
  });

  test("metadata is cleared after flush so it is not sent twice", async () => {
    const client = createClient({ id: "test" });

    const mockUpdateMetadata = vi.fn().mockResolvedValue(undefined);
    (client as unknown as { updateMetadata: typeof mockUpdateMetadata })
      .updateMetadata = mockUpdateMetadata;

    const fn = new InngestFunction(
      client,
      { id: "test-fn", triggers: [{ event: "test/event" }] },
      async () => {
        throw new Error("function-level error");
      },
    );

    const execution = createAsyncExecution(client, fn);

    (
      execution as unknown as {
        state: { metadata: Map<string, MetadataUpdate[]> };
      }
    ).state.metadata = new Map([
      [
        "some-step",
        [
          {
            kind: "userland.test" as const,
            scope: "step" as const,
            op: "merge" as const,
            values: { key: "value" },
          },
        ],
      ],
    ]);

    await execution.start();

    // Verify the metadata map is cleared after flush
    const stateMetadata = (
      execution as unknown as {
        state: { metadata: Map<string, MetadataUpdate[]> };
      }
    ).state.metadata;
    expect(stateMetadata.size).toBe(0);
  });
});
