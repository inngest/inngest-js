/**
 * Periodic worker status reporter for the active WebSocket connection.
 *
 * Sends WORKER_STATUS messages at a gateway-configured interval so the
 * gateway can observe in-flight requests and shutdown state. The interval
 * is opt-in: the gateway sends "0s" or "" to disable it.
 */

import type { Logger } from "../../../../middleware/logger.ts";
import {
  ConnectMessage,
  GatewayMessageType,
  WorkerStatusData,
} from "../../../../proto/src/components/connect/protobuf/connect.ts";
import { ensureUnsharedArrayBuffer } from "../../buffer.ts";
import type { ConnectionAccessor } from "./types.ts";

export class StatusReporter {
  private interval: ReturnType<typeof setInterval> | undefined;
  private intervalMs = 0;

  constructor(
    private readonly accessor: ConnectionAccessor,
    private readonly logger: Logger,
  ) {}

  /**
   * Update the status reporting interval. Restarts the timer if the interval
   * changed or if it wasn't running yet. A value of 0 disables reporting.
   */
  updateInterval(ms: number): void {
    if (ms === this.intervalMs && (this.interval || ms === 0)) return;
    this.intervalMs = ms;
    this.stop();
    if (ms > 0) {
      this.start();
    }
  }

  /** Stop the status reporting timer. */
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

    const inFlightRequestIds = Object.keys(
      this.accessor.inProgressRequests.requestLeases,
    );

    const statusPayload = WorkerStatusData.encode(
      WorkerStatusData.create({
        inFlightRequestIds,
        shutdownRequested: this.accessor.shutdownRequested,
      }),
    ).finish();

    conn.ws.send(
      ensureUnsharedArrayBuffer(
        ConnectMessage.encode(
          ConnectMessage.create({
            kind: GatewayMessageType.WORKER_STATUS,
            payload: statusPayload,
          }),
        ).finish(),
      ),
    );

    this.logger.debug(
      {
        connectionId: conn.id,
        inFlightRequestCount: inFlightRequestIds.length,
        shutdownRequested: this.accessor.shutdownRequested,
      },
      "Worker status sent",
    );
  }
}
