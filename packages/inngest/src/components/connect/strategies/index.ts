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
 * Checks if worker_threads is available in the current environment.
 */
function isWorkerThreadsAvailable(): boolean {
  try {
    // Check if we're in a Node.js environment with worker_threads support
    if (typeof process === "undefined" || !process.versions?.node) {
      return false;
    }

    // Try to load worker_threads
    require("node:worker_threads");
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a connection strategy based on the provided options.
 *
 * By default, uses SameThreadStrategy. When `useWorkerThread: true` is
 * specified and worker_threads is available, uses WorkerThreadStrategy instead.
 */
export function createStrategy(
  config: StrategyConfig,
  options: ConnectHandlerOptions,
): ConnectionStrategy {
  if (options.useWorkerThread) {
    // Check if worker_threads is available
    if (!isWorkerThreadsAvailable()) {
      throw new Error("Worker threads are not supported in this environment");
    }

    // Try to load worker thread strategy
    try {
      // Dynamic import to avoid bundling worker_threads in non-Node environments
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { WorkerThreadStrategy } = require("./workerThread/index.ts");
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
