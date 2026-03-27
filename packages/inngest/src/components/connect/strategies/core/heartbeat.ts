/**
 * Heartbeat management for the active WebSocket connection.
 *
 * Sends periodic heartbeat pings and marks the connection as dead when
 * two consecutive heartbeats go unacknowledged, waking the reconcile loop
 * to trigger reconnection.
 */

import type { Logger } from "../../../../middleware/logger.ts";
import {
  ConnectMessage,
  GatewayMessageType,
} from "../../../../proto/src/components/connect/protobuf/connect.ts";
import { ensureUnsharedArrayBuffer } from "../../buffer.ts";
import type { ConnectionAccessor, WakeSignal } from "./types.ts";

export class HeartbeatManager {
  private interval: ReturnType<typeof setInterval> | undefined;
  private intervalMs = 10_000;

  constructor(
    private readonly accessor: ConnectionAccessor,
    private readonly wakeSignal: WakeSignal,
    private readonly logger: Logger,
  ) {}

  /**
   * Update the heartbeat interval. Restarts the timer if the interval changed
   * or if it wasn't running yet.
   */
  updateInterval(ms: number): void {
    if (ms === this.intervalMs && this.interval) return;
    this.intervalMs = ms;
    this.stop();
    this.start();
  }

  /** Stop the heartbeat timer. */
  stop(): void {
    clearInterval(this.interval);
    this.interval = undefined;
  }

  private start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), this.intervalMs);
  }

  private tick(): void {
    const conn = this.accessor.activeConnection;
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return;

    if (conn.pendingHeartbeats >= 2) {
      this.logger.warn(
        { connectionId: conn.id },
        "Consecutive heartbeats missed, reconnecting",
      );
      conn.dead = true;
      this.wakeSignal.wake();
      return;
    }

    conn.pendingHeartbeats++;
    conn.ws.send(
      ensureUnsharedArrayBuffer(
        ConnectMessage.encode(
          ConnectMessage.create({
            kind: GatewayMessageType.WORKER_HEARTBEAT,
          }),
        ).finish(),
      ),
    );
  }
}
