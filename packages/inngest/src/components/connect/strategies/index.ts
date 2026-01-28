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
 * By default, uses SameThreadStrategy. When `isolateExecution: true` is
 * specified and worker_threads is available, uses WorkerThreadStrategy instead.
 */
export async function createStrategy(
  config: StrategyConfig,
  options: ConnectHandlerOptions,
): Promise<ConnectionStrategy> {
  if (options.isolateExecution) {
    // Try to load worker thread strategy
    try {
      // Dynamic import to avoid bundling worker_threads in non-Node environments
      const { WorkerThreadStrategy } = await import("./workerThread/index.ts");
      return new WorkerThreadStrategy(config);
    } catch (err) {
      throw new Error("Failed to load worker thread strategy", { cause: err });
    }
  }

  // TODO: Default to `WorkerThreadStrategy` if worker threads are available.
  // Only make that change once we confirm that `WorkerThreadStrategy` is ready
  // for primetime

  return new SameThreadStrategy(config);
}
