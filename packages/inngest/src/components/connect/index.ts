// Export types for convenience
export {
  DEFAULT_SHUTDOWN_SIGNALS,
  type ConnectApp,
  type ConnectHandlerOptions,
  ConnectionState,
  type WorkerConnection,
};

export const connect = async (
  options: ConnectHandlerOptions
): Promise<WorkerConnection> => {
  const conn = new WebSocketWorkerConnection(options);

  await conn.start();

  return conn;
};
