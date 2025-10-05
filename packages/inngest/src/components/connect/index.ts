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

  await conn.start();

  return conn;
};
