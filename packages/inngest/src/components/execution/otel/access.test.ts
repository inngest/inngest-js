import type { Span } from "@opentelemetry/api";
import type { Inngest } from "../../Inngest.ts";
import { clientProcessorMap, registerClientProcessor } from "./access.ts";

const createClient = () => ({}) as Inngest.Any;

const createProcessor = () => ({
  clearStepExecution: vi.fn(),
  declareStartingSpan: vi.fn(),
  declareStepExecution: vi.fn(),
});

const createSpan = () =>
  ({
    spanContext: () => ({ spanId: "span-1" }),
  }) as Span;

describe("registerClientProcessor", () => {
  test("always stores a registry that fans out lifecycle calls", () => {
    const client = createClient();
    const processor1 = createProcessor();
    const processor2 = createProcessor();

    registerClientProcessor(client, processor1);
    const firstRegisteredValue = clientProcessorMap.get(client);

    registerClientProcessor(client, processor2);
    const secondRegisteredValue = clientProcessorMap.get(client);

    expect(secondRegisteredValue).toBe(firstRegisteredValue);

    secondRegisteredValue?.declareStartingSpan({
      runId: "run-1",
      span: createSpan(),
      traceparent: undefined,
      tracestate: undefined,
    });
    secondRegisteredValue?.declareStepExecution(
      "root-span",
      "step-1",
      0,
      "hashed-step-1",
      1,
    );
    secondRegisteredValue?.clearStepExecution("root-span");

    expect(processor1.declareStartingSpan).toHaveBeenCalledTimes(1);
    expect(processor2.declareStartingSpan).toHaveBeenCalledTimes(1);
    expect(processor1.declareStepExecution).toHaveBeenCalledTimes(1);
    expect(processor2.declareStepExecution).toHaveBeenCalledTimes(1);
    expect(processor1.clearStepExecution).toHaveBeenCalledTimes(1);
    expect(processor2.clearStepExecution).toHaveBeenCalledTimes(1);
  });
});
