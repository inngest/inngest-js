/**
 * @module
 * EXPERIMENTAL: a warning on the run's trace. It is a log line and, when a step
 * is running, a warning on that step's metadata, the way scores ride on a step.
 * It adds no step of its own.
 */

import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import { warningMetadataKind } from "../../../components/InngestMetadata.ts";

/**
 * Warns on the run's trace. Returns whether the warning was attached to a
 * step; outside a step it is only logged. It never throws: a warning is never
 * worth failing a run.
 * @param logger Where the line is logged, if the run has one.
 * @param code What the warning is about, such as `thread.fresh`.
 * @param message What the person reading the trace sees.
 */
export const traceWarning = (
  logger: { warn: (message: string) => void } | undefined,
  code: string,
  message: string,
): boolean => {
  logger?.warn(message);

  const execution = getAsyncCtxSync()?.execution;
  const running = execution?.executingStep;

  if (!execution || !running?.id) {
    return false;
  }

  const sdkCode = `sdk.agent.${code}`;

  try {
    return execution.instance.addMetadata(
      running.id,
      warningMetadataKind(sdkCode),
      "step",
      "set",
      { [sdkCode]: message },
    );
  } catch {
    return false;
  }
};
