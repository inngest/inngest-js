import { type RegisterOptions } from "../../types.js";
import { type InngestFunction } from "../InngestFunction.js";

export interface ConnectHandlerOptions extends RegisterOptions {
  /**
   * An array of the functions to serve and register with Inngest.
   */
  functions: readonly InngestFunction.Like[];

  instanceId: string;
  maxConcurrency?: number;
  abortSignal?: AbortSignal;
}

export interface WorkerConnection {
  connectionId: string;
  closed: Promise<void>;
  close: () => Promise<void>;
}
