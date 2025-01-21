import type { Inngest, InngestFunction, RegisterOptions } from "inngest";

export interface ConnectHandlerOptions extends RegisterOptions {
  /**
   * An array of the functions to serve and register with Inngest.
   */
  functions: readonly InngestFunction.Any[];

  instanceId: string;
  maxConcurrency?: number;
  abortSignal?: AbortSignal;
}

export interface WorkerConnection {
  connectionId: string;
  closed: Promise<void>;
  close: () => Promise<void>;
}
