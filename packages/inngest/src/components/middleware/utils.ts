import { isRecord } from "../../helpers/types";
import type { Logger } from "../../middleware/logger";
import { type SendEventBaseOutput, StepOpCode } from "../../types";
import type { Middleware } from "./middleware";
import type { ExtractLiteralStrings } from "./types";

export function isTimeStrInput(
  value: unknown,
): value is string | number | Date {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    value instanceof Date
  );
}

/**
 * Build an onion-style middleware chain for `wrapSendEvent`.
 *
 * Same pattern as `buildWrapRequestChain` but wraps the outgoing HTTP call
 * in `client.send()` instead of the incoming execution request.
 */
export function buildWrapSendEventChain(
  middleware: Middleware.BaseMiddleware[],
  handler: () => Promise<SendEventBaseOutput>,
  payloads: Middleware.WrapSendEventArgs["events"],
  functionInfo: Middleware.FunctionInfo | null,
): () => Promise<SendEventBaseOutput> {
  let chain: () => Promise<SendEventBaseOutput> = handler;
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i];
    if (mw?.wrapSendEvent) {
      const next = chain;
      chain = () => mw.wrapSendEvent!({ next, events: payloads, functionInfo });
    }
  }
  return chain;
}

/**
 * Build an onion-style middleware chain for `wrapRequest`.
 *
 * Iterates in reverse order (so first middleware is outermost)
 * and returns a zero-arg function that kicks off the chain.
 */
export function buildWrapRequestChain({
  functionInfo,
  handler,
  middleware,
  requestInfo,
  runId,
}: {
  functionInfo: Middleware.FunctionInfo;
  handler: () => Promise<Middleware.Response>;
  middleware: Middleware.BaseMiddleware[];
  requestInfo: Middleware.Request;
  runId: string;
}): () => Promise<Middleware.Response> {
  let chain: () => Promise<Middleware.Response> = handler;
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i];
    if (mw?.wrapRequest) {
      const next = chain;
      chain = () => mw.wrapRequest!({ next, requestInfo, runId, functionInfo });
    }
  }
  return chain;
}

// Replace the "and can be any string" union member with "unknown". This
// improves static type safety within `stepTypeFromOpCode`, since it ensures we
// aren't returning any unknown StepType besides "unknown". We should never
// actually return "unknown" at runtime, but we need a default
type StepTypeFromOpCodeReturn =
  | ExtractLiteralStrings<Middleware.StepType>
  | "unknown";

/**
 * Convert an opcode (from the op) to a step type.
 */
export function stepTypeFromOpCode(
  op: StepOpCode,
  opts: Record<string, unknown> | undefined,
  logger: Logger,
): StepTypeFromOpCodeReturn {
  if (op === StepOpCode.AiGateway) {
    if (opts?.type === "step.ai.infer") {
      return "ai.infer";
    }
    if (opts?.type === "step.ai.wrap") {
      return "ai.wrap";
    }
  } else if (op === StepOpCode.Gateway) {
    return "fetch";
  } else if (op === StepOpCode.InvokeFunction) {
    return "invoke";
  } else if (op === StepOpCode.StepPlanned) {
    if (opts?.type === undefined) {
      return "run";
    }
    if (opts?.type === "step.sendEvent") {
      return "sendEvent";
    }
    if (opts?.type === "step.realtime.publish") {
      return "realtime.publish";
    }
  } else if (op === StepOpCode.Sleep) {
    return "sleep";
  } else if (op === StepOpCode.WaitForEvent) {
    return "waitForEvent";
  }

  logger.warn(
    `Unknown step type: op is "${op}" and opts.type is "${opts?.type}"`,
  );
  return "unknown";
}

/**
 * Convert the opts object (from the op) to a step input array.
 *
 * Paired with `optsFromStepInput` which reverses this for step kinds that
 * wrap the entire opts as `[opts]`.
 */
export function stepInputFromOpts(
  stepType: Middleware.StepType,
  opts?: Record<string, unknown>,
): unknown[] | undefined {
  if (stepType === "invoke" || stepType === "waitForEvent") {
    return [opts];
  }
  if (Array.isArray(opts?.input)) {
    return opts.input;
  }
  return undefined;
}

/**
 * Reverse of `stepInputFromOpts`: given middleware-transformed input, derive
 * the opts to use in the outgoing op.
 *
 * Returns undefined when the step kind doesn't derive opts from input.
 */
export function optsFromStepInput(
  stepType: Middleware.StepType,
  input: unknown[] | undefined,
): Record<string, unknown> | undefined {
  if (input === undefined) {
    return undefined;
  }

  // Step types where stepInputFromOpts wraps the entire opts as [opts]
  if (stepType === "invoke" || stepType === "waitForEvent") {
    const opts = input[0];
    if (isRecord(opts)) {
      return opts;
    }
  }

  return undefined;
}

/**
 * An error that is thrown when a code path is unreachable. Should never be
 * thrown at runtime.
 */
export class UnreachableError extends Error {
  constructor(...args: Parameters<typeof Error>) {
    super(...args);
    this.name = this.constructor.name;
  }
}
