import { MessageHandler } from "./messages";
import type {
  ConnectApp,
  ConnectHandlerOptions,
  ConnectionState,
  DEFAULT_SHUTDOWN_SIGNALS,
  WorkerConnection,
} from "./types";

// Export types for convenience
export {
  type DEFAULT_SHUTDOWN_SIGNALS,
  type ConnectApp,
  type ConnectHandlerOptions,
  ConnectionState,
  type WorkerConnection,
};

export const connect = async (
  options: ConnectHandlerOptions
): Promise<WorkerConnection> => {
  const conn = new MessageHandler(options);

  // Set up function configs, etc.
  await conn.setup();

  // Start reconciler
  await conn.startReconciler();

  const attempts = 10;
  const res = await conn.waitForConnection(attempts);
  if (!res.connected) {
    throw new Error(`Initial connection failed after ${attempts} attempts`);
  }

  return conn;
};
