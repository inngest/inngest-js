import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OutgoingOp } from "inngest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkflow, run } from "./workflow.js";
import type { WorkflowInput } from "./types.js";

function makeInput(overrides?: Partial<WorkflowInput>): WorkflowInput {
  return {
    event: { name: "app/user.created", data: { foo: "bar" }, ts: Date.now() },
    stepState: {},
    stepCompletionOrder: [],
    runId: "run-1",
    attempt: 0,
    ...overrides,
  };
}

describe("createWorkflow", () => {
  it("should return a WorkflowFunction with fn and config", () => {
    const workflow = createWorkflow({
      handler: async () => "ok",
    });

    expect(workflow.fn).toBeDefined();
    expect(workflow.config).toBeDefined();
    expect(workflow.config.handler).toBeTypeOf("function");
  });
});

describe("run", () => {
  let tmpDir: string;
  let inputPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-test-"));
    inputPath = path.join(tmpDir, "input.json");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should call onComplete when a stepless function resolves", async () => {
    const workflow = createWorkflow({
      handler: async ({ event }) => {
        return `hello ${event.data.foo}`;
      },
    });

    await fs.writeFile(inputPath, JSON.stringify(makeInput()));

    let completedData: unknown;
    await run(workflow, {
      inputPath,
      onComplete: async (data) => {
        completedData = data;
      },
    });

    expect(completedData).toBe("hello bar");
  });

  it("should call onStep when steps are discovered", async () => {
    const workflow = createWorkflow({
      handler: async ({ step }) => {
        await step.run("my-step", () => "step-result");
        return "done";
      },
    });

    await fs.writeFile(inputPath, JSON.stringify(makeInput()));

    let discoveredSteps: OutgoingOp[] | undefined;
    await run(workflow, {
      inputPath,
      onStep: async (steps) => {
        discoveredSteps = steps;
      },
    });

    expect(discoveredSteps).toBeDefined();
    expect(discoveredSteps!.length).toBeGreaterThan(0);
    expect(discoveredSteps![0].displayName).toBe("my-step");
  });

  it("should call onError when the function throws", async () => {
    const workflow = createWorkflow({
      handler: async () => {
        throw new Error("boom");
      },
    });

    await fs.writeFile(inputPath, JSON.stringify(makeInput()));

    let receivedError: unknown;
    let receivedRetriable: boolean | string | undefined;
    await run(workflow, {
      inputPath,
      onError: async (error, retriable) => {
        receivedError = error;
        receivedRetriable = retriable;
      },
    });

    expect(receivedError).toBeDefined();
    expect(receivedRetriable).toBeDefined();
  });

  it("should pass event data through to the handler", async () => {
    let receivedEvent: any;
    const workflow = createWorkflow({
      handler: async ({ event }) => {
        receivedEvent = event;
        return event.data.value;
      },
    });

    const input = makeInput({
      event: { name: "orders/placed", data: { value: 42 }, ts: Date.now() },
    });
    await fs.writeFile(inputPath, JSON.stringify(input));

    let completedData: unknown;
    await run(workflow, {
      inputPath,
      onComplete: async (data) => {
        completedData = data;
      },
    });

    expect(receivedEvent.name).toBe("orders/placed");
    expect(receivedEvent.data.value).toBe(42);
    expect(completedData).toBe(42);
  });

  it("should pass runId and attempt to the handler", async () => {
    let receivedRunId: string | undefined;
    let receivedAttempt: number | undefined;

    const workflow = createWorkflow({
      handler: async ({ runId, attempt }) => {
        receivedRunId = runId;
        receivedAttempt = attempt;
      },
    });

    const input = makeInput({ runId: "custom-run-id", attempt: 3 });
    await fs.writeFile(inputPath, JSON.stringify(input));

    await run(workflow, {
      inputPath,
      onComplete: async () => {},
    });

    expect(receivedRunId).toBe("custom-run-id");
    expect(receivedAttempt).toBe(3);
  });

  it("should use default callbacks when none provided", async () => {
    const workflow = createWorkflow({
      handler: async () => "default-result",
    });

    await fs.writeFile(inputPath, JSON.stringify(makeInput()));

    // Mock fs.writeFile to capture the default callback output
    const writeSpy = vi.spyOn(fs, "writeFile");

    await run(workflow, { inputPath });

    expect(writeSpy).toHaveBeenCalledWith(
      "/tmp/output",
      expect.stringContaining("function-resolved")
    );

    writeSpy.mockRestore();
  });
});
