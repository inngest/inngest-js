import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OutgoingOp } from "inngest";
import { StepOpCode } from "inngest/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInput, run, writeOutput } from "./workflow.js";
import type { WorkflowHandler, WorkflowInput } from "./types.js";

function makeInput(overrides?: Partial<WorkflowInput>): WorkflowInput {
  return {
    event: { name: "app/user.created", data: { foo: "bar" }, ts: Date.now() },
    state: {},
    stack: [],
    runId: "run-1",
    attempt: 0,
    ...overrides,
  };
}

describe("run", () => {
  it("should emit RunComplete when a stepless function resolves", async () => {
    const handler: WorkflowHandler = async ({ event }) => {
      return `hello ${event.data.foo}`;
    };

    let ops: OutgoingOp[] | undefined;
    await run(handler, {
      input: makeInput(),
      onResult: async (result) => {
        ops = result;
      },
    });

    expect(ops).toHaveLength(1);
    expect(ops![0].op).toBe(StepOpCode.RunComplete);
    expect(ops![0].data).toBe("hello bar");
  });

  it("should emit step opcodes when steps are discovered", async () => {
    const handler: WorkflowHandler = async ({ step }) => {
      await step.run("my-step", () => "step-result");
      return "done";
    };

    let ops: OutgoingOp[] | undefined;
    await run(handler, {
      input: makeInput(),
      onResult: async (result) => {
        ops = result;
      },
    });

    expect(ops).toBeDefined();
    expect(ops!.length).toBeGreaterThan(0);
    expect(ops![0].displayName).toBe("my-step");
  });

  it("should emit StepError for retriable errors", async () => {
    const handler: WorkflowHandler = async () => {
      throw new Error("boom");
    };

    let ops: OutgoingOp[] | undefined;
    await run(handler, {
      input: makeInput(),
      onResult: async (result) => {
        ops = result;
      },
    });

    expect(ops).toHaveLength(1);
    expect(ops![0].op).toBe(StepOpCode.StepError);
    expect(ops![0].error).toBeDefined();
  });

  it("should emit StepFailed for non-retriable errors", async () => {
    const { NonRetriableError } = await import("inngest");
    const handler: WorkflowHandler = async () => {
      throw new NonRetriableError("fatal");
    };

    let ops: OutgoingOp[] | undefined;
    await run(handler, {
      input: makeInput(),
      onResult: async (result) => {
        ops = result;
      },
    });

    expect(ops).toHaveLength(1);
    expect(ops![0].op).toBe(StepOpCode.StepFailed);
  });

  it("should accept any event name", async () => {
    let receivedEvent: any;
    const handler: WorkflowHandler = async ({ event }) => {
      receivedEvent = event;
      return event.data.value;
    };

    let ops: OutgoingOp[] | undefined;
    await run(handler, {
      input: makeInput({
        event: { name: "orders/placed", data: { value: 42 }, ts: Date.now() },
      }),
      onResult: async (result) => {
        ops = result;
      },
    });

    expect(receivedEvent.name).toBe("orders/placed");
    expect(ops![0].op).toBe(StepOpCode.RunComplete);
    expect(ops![0].data).toBe(42);
  });

  it("should pass runId and attempt to the handler", async () => {
    let receivedRunId: string | undefined;
    let receivedAttempt: number | undefined;

    const handler: WorkflowHandler = async ({ runId, attempt }) => {
      receivedRunId = runId;
      receivedAttempt = attempt;
    };

    await run(handler, {
      input: makeInput({ runId: "custom-run-id", attempt: 3 }),
      onResult: async () => {},
    });

    expect(receivedRunId).toBe("custom-run-id");
    expect(receivedAttempt).toBe(3);
  });

  it("should silently succeed when no onResult is provided", async () => {
    const handler: WorkflowHandler = async () => "result";
    await expect(run(handler, { input: makeInput() })).resolves.toBeUndefined();
  });

  it("should emit StepFailed when step tools are filtered", async () => {
    const handler: WorkflowHandler = async ({ step }) => {
      await (step as any).sleep("nap", "1h");
    };

    let ops: OutgoingOp[] | undefined;
    await run(handler, {
      input: makeInput(),
      allowedStepTools: ["run"],
      onResult: async (result) => {
        ops = result;
      },
    });

    expect(ops).toHaveLength(1);
    expect(ops![0].op).toBe(StepOpCode.StepFailed);
  });
});

describe("readInput", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should read and parse a WorkflowInput from a file", async () => {
    const expected = makeInput({ runId: "from-file" });
    const filePath = path.join(tmpDir, "input.json");
    await fs.writeFile(filePath, JSON.stringify(expected));

    const result = await readInput(filePath);
    expect(result.runId).toBe("from-file");
    expect(result.event.name).toBe("app/user.created");
  });
});

describe("writeOutput", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should write JSON to a file", async () => {
    const filePath = path.join(tmpDir, "output.json");
    await writeOutput({ type: "function-resolved", data: "hello" }, filePath);

    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.type).toBe("function-resolved");
    expect(parsed.data).toBe("hello");
  });
});
