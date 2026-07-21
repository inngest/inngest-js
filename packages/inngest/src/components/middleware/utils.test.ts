import { Temporal } from "temporal-polyfill";
import { describe, expect, test } from "vitest";
import { ConsoleLogger } from "../../middleware/logger.ts";
import { StepOpCode } from "../../types.ts";
import {
  isSleepInput,
  optsFromStepInput,
  stepTypeFromOpCode,
} from "./utils.ts";

const logger = new ConsoleLogger();

describe("stepTypeFromOpCode", () => {
  test("StepPlanned without type returns 'run'", () => {
    expect(stepTypeFromOpCode(StepOpCode.StepPlanned, undefined, logger)).toBe(
      "run",
    );
    expect(stepTypeFromOpCode(StepOpCode.StepPlanned, {}, logger)).toBe("run");
    expect(
      stepTypeFromOpCode(StepOpCode.StepPlanned, { type: undefined }, logger),
    ).toBe("run");
  });

  test("StepPlanned with type 'step.sendEvent' returns 'sendEvent'", () => {
    expect(
      stepTypeFromOpCode(
        StepOpCode.StepPlanned,
        { type: "step.sendEvent" },
        logger,
      ),
    ).toBe("sendEvent");
  });

  test("StepPlanned with type 'step.realtime.publish' returns 'realtime.publish'", () => {
    expect(
      stepTypeFromOpCode(
        StepOpCode.StepPlanned,
        {
          type: "step.realtime.publish",
        },
        logger,
      ),
    ).toBe("realtime.publish");
  });

  test("StepPlanned with unknown type returns 'unknown'", () => {
    expect(
      stepTypeFromOpCode(
        StepOpCode.StepPlanned,
        { type: "step.whatever" },
        logger,
      ),
    ).toBe("unknown");
  });

  test("InvokeFunction returns 'invoke'", () => {
    expect(
      stepTypeFromOpCode(StepOpCode.InvokeFunction, undefined, logger),
    ).toBe("invoke");
  });

  test("Sleep returns 'sleep'", () => {
    expect(stepTypeFromOpCode(StepOpCode.Sleep, undefined, logger)).toBe(
      "sleep",
    );
  });

  test("WaitForEvent returns 'waitForEvent'", () => {
    expect(stepTypeFromOpCode(StepOpCode.WaitForEvent, undefined, logger)).toBe(
      "waitForEvent",
    );
  });

  test("WaitForSignal returns 'waitForSignal'", () => {
    expect(
      stepTypeFromOpCode(StepOpCode.WaitForSignal, undefined, logger),
    ).toBe("waitForSignal");
  });

  test("AiGateway with type 'step.ai.infer' returns 'ai.infer'", () => {
    expect(
      stepTypeFromOpCode(
        StepOpCode.AiGateway,
        { type: "step.ai.infer" },
        logger,
      ),
    ).toBe("ai.infer");
  });

  test("AiGateway with type 'step.ai.wrap' returns 'ai.wrap'", () => {
    expect(
      stepTypeFromOpCode(
        StepOpCode.AiGateway,
        { type: "step.ai.wrap" },
        logger,
      ),
    ).toBe("ai.wrap");
  });

  test("AiGateway with unknown type returns 'unknown'", () => {
    expect(
      stepTypeFromOpCode(
        StepOpCode.AiGateway,
        { type: "something.else" },
        logger,
      ),
    ).toBe("unknown");
  });

  test("unhandled opcode returns 'unknown'", () => {
    expect(stepTypeFromOpCode(StepOpCode.StepRun, undefined, logger)).toBe(
      "unknown",
    );
    expect(stepTypeFromOpCode(StepOpCode.Step, undefined, logger)).toBe(
      "unknown",
    );
  });

  test("Gateway returns 'fetch'", () => {
    expect(stepTypeFromOpCode(StepOpCode.Gateway, undefined, logger)).toBe(
      "fetch",
    );
  });

  test("Sandbox returns the action-specific step type", () => {
    expect(
      stepTypeFromOpCode(
        StepOpCode.Sandbox,
        {
          type: "step.sandbox.get",
          sandbox: {
            protocolVersion: 1,
            action: "get",
            input: [
              {
                sandboxId: "22222222-2222-4222-8222-222222222222",
              },
            ],
          },
        },
        logger,
      ),
    ).toBe("step.sandbox.get");
  });

  test("Sandbox rejects mismatched type and action", () => {
    expect(
      stepTypeFromOpCode(
        StepOpCode.Sandbox,
        {
          type: "step.sandbox.exec",
          sandbox: {
            protocolVersion: 1,
            action: "get",
            input: [
              {
                sandboxId: "22222222-2222-4222-8222-222222222222",
              },
            ],
          },
        },
        logger,
      ),
    ).toBe("unknown");
  });
});

describe("optsFromStepInput", () => {
  test("returns input[0] for invoke", () => {
    const opts = { function: "my-fn", payload: { data: { x: 1 } } };
    expect(optsFromStepInput("invoke", [opts])).toBe(opts);
  });

  test("returns input[0] for waitForEvent", () => {
    const opts = { timeout: "1s", if: "event.x == async.x" };
    expect(optsFromStepInput("waitForEvent", [opts])).toBe(opts);
  });

  test("returns undefined for run", () => {
    expect(optsFromStepInput("run", [42])).toBeUndefined();
  });

  test("returns undefined for sleep", () => {
    expect(optsFromStepInput("sleep", ["60s"])).toBeUndefined();
  });

  test("returns undefined when input is undefined", () => {
    expect(optsFromStepInput("invoke", undefined)).toBeUndefined();
    expect(optsFromStepInput("waitForEvent", undefined)).toBeUndefined();
  });

  test("returns undefined when input[0] is not an object", () => {
    expect(optsFromStepInput("invoke", ["not-an-object"])).toBeUndefined();
    expect(optsFromStepInput("invoke", [null])).toBeUndefined();
  });

  test("reconstructs only Sandbox input within the original envelope", () => {
    const originalOpts = {
      type: "step.sandbox.exec",
      experimentName: "experiment",
      sandbox: {
        protocolVersion: 1,
        action: "exec",
        target: {
          sandboxId: "22222222-2222-4222-8222-222222222222",
        },
        input: [
          {
            command: ["/bin/true"],
            timeoutMs: 1_000,
          },
        ],
      },
    };

    expect(
      optsFromStepInput(
        "step.sandbox.exec",
        [{ command: ["/bin/false"], timeoutMs: 2_000 }],
        originalOpts,
      ),
    ).toEqual({
      ...originalOpts,
      sandbox: {
        ...originalOpts.sandbox,
        input: [
          {
            command: ["/bin/false"],
            timeoutMs: 2_000,
          },
        ],
      },
    });

    expect(() =>
      optsFromStepInput(
        "step.sandbox.exec",
        [{ command: ["bin/false"], timeoutMs: 2_000 }],
        originalOpts,
      ),
    ).toThrow("command must begin with an absolute executable path");
  });
});

describe("isSleepInput", () => {
  test("accepts string, number, Date, and Temporal.Duration", () => {
    expect(isSleepInput("1h")).toBe(true);
    expect(isSleepInput(60_000)).toBe(true);
    expect(isSleepInput(new Date())).toBe(true);
    expect(isSleepInput(Temporal.Duration.from({ seconds: 1 }))).toBe(true);
  });

  test("rejects an invalid value", () => {
    expect(isSleepInput({})).toBe(false);
  });
});
