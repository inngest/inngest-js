import { afterEach, describe, expect, test, vi } from "vitest";
import * as experimental from "../experimental";
import type { Inngest } from "./Inngest.ts";
import { buildTarget, UnscopedMetadataBuilder } from "./InngestMetadata.ts";

const mockClient = () =>
  ({
    _updateMetadata: vi.fn().mockResolvedValue(undefined),
  }) as unknown as Inngest;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildTarget", () => {
  test("uses execution context when no config provided", () => {
    const target = buildTarget({}, {
      execution: {
        ctx: { runId: "run-1", attempt: 2 },
        executingStep: { id: "step-1" },
      },
    } as unknown as experimental.AsyncContext);

    expect(target).toEqual({
      run_id: "run-1",
      step_id: "step-1",
      attempt: 2,
    });
  });

  test("does not leak context when run override is used", () => {
    const target = buildTarget({ runId: "other-run" }, {
      execution: {
        ctx: { runId: "current-run", attempt: 1 },
        executingStep: { id: "step-ctx" },
      },
    } as unknown as experimental.AsyncContext);

    expect(target).toEqual({ run_id: "other-run" });
  });

  test("supports explicit step overrides for other runs", () => {
    const target = buildTarget({ runId: "other-run", stepId: "custom-step" }, {
      execution: {
        ctx: { runId: "current-run", attempt: 1 },
        executingStep: { id: "step-ctx" },
      },
    } as unknown as experimental.AsyncContext);

    expect(target).toEqual({
      run_id: "other-run",
      step_id: "custom-step",
    });
  });

  test("throws when no run context is available", () => {
    expect(() => buildTarget({})).toThrow("No run context available");
  });
});

describe("MetadataBuilder.update", () => {
  test("batches updates when execution context supports metadata", async () => {
    const addMetadata = vi.fn();
    const ctx = {
      execution: {
        ctx: { runId: "run-ctx", attempt: 0 },
        executingStep: { id: "step-ctx" },
        instance: { addMetadata },
      },
    };

    vi.spyOn(experimental, "getAsyncCtx").mockResolvedValue(
      ctx as unknown as experimental.AsyncContext,
    );

    const client = mockClient();
    await new UnscopedMetadataBuilder(client).update({ foo: "bar" });

    expect(addMetadata).toHaveBeenCalledWith("step-ctx", "default", {
      foo: "bar",
    });
    expect(client["_updateMetadata"]).not.toHaveBeenCalled();
  });

  test("sends updates via API with execution headers when batching unavailable", async () => {
    const ctx = {
      execution: {
        ctx: { runId: "current-run" },
        instance: {
          options: { headers: { Authorization: "Bearer 123" } },
        },
      },
    };

    vi.spyOn(experimental, "getAsyncCtx").mockResolvedValue(
      ctx as unknown as experimental.AsyncContext,
    );

    const client = mockClient();
    await new UnscopedMetadataBuilder(client)
      .run("other-run")
      .update({ foo: "bar" });

    expect(client["_updateMetadata"]).toHaveBeenCalledWith({
      target: {
        run_id: "other-run",
      },
      metadata: [
        {
          kind: "default",
          op: "merge",
          values: { foo: "bar" },
        },
      ],
      headers: { Authorization: "Bearer 123" },
    });
  });
});
