export {
  type Connection,
  ConnectionCore,
  type ConnectionCoreCallbacks,
  type ConnectionCoreConfig,
} from "./connection.ts";
export { establishConnection } from "./handshake.ts";
export { HeartbeatManager } from "./heartbeat.ts";
export { RequestProcessor } from "./requestProcessor.ts";

export type {
  ConnectionAccessor,
  ConnectionEstablishData,
  ConnectionStrategy,
  RequestHandler,
  StrategyConfig,
  StrategyEvents,
  WakeSignal,
} from "./types.ts";
