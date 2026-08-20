import type { ConnectHandlerOptions } from "../types.ts";
import type { ConnectionStrategy, StrategyConfig } from "./core/types.ts";
import { SameThreadStrategy } from "./sameThread/index.ts";

export type {
  BaseConnectionConfig,
  ConnectionEstablishData,
  ConnectionStrategy,
  RequestHandler,
  StrategyConfig,
  StrategyEvents,
} from "./core/types.ts";
export { SameThreadStrategy } from "./sameThread/index.ts";

/**
 * Creates a connection strategy based on the provided options.
 *
 * By default, uses WorkerThreadStrategy when worker_threads is available.
 * When `isolateExecution: false` is specified, uses SameThreadStrategy instead.
 */
export async function createStrategy(
  config: StrategyConfig,
  options: ConnectHandlerOptions,
): Promise<ConnectionStrategy> {
  if (options.isolateExecution === false) {
    return new SameThreadStrategy(config);
  }

  // Default: use worker thread strategy for execution isolation
  try {
    // Dynamic import to avoid bundling worker_threads in non-Node environments
    const { WorkerThreadStrategy } = await import("./workerThread/index.ts");
    return new WorkerThreadStrategy(config);
  } catch (err) {
    throw new Error("Failed to load worker thread strategy", { cause: err });
  }
}
