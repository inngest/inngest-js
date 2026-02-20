import { describe, expect, test } from "vitest";
import { ConsoleLogger } from "../../middleware/logger.ts";
import { StepOpCode } from "../../types.ts";
import { optsFromStepInput, stepTypeFromOpCode } from "./utils.ts";

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
});
