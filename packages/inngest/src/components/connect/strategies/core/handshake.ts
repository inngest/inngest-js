/**
 * Connection establishment logic: HTTP start request + WebSocket handshake.
 *
 * This module is stateless — callers pass in configuration and receive a
 * fully-handshaked {@link Connection} object. Post-handshake handler wiring
 * (error/close/message) is the caller's responsibility.
 */

import ms from "ms";
import { headerKeys } from "../../../../helpers/consts.ts";
import { allProcessEnv, getPlatformName } from "../../../../helpers/env.ts";
import { resolveApiBaseUrl } from "../../../../helpers/url.ts";
import type { Logger } from "../../../../middleware/logger.ts";
import {
  ConnectMessage,
  GatewayConnectionReadyData,
  GatewayMessageType,
  gatewayMessageTypeToJSON,
  WorkerConnectRequestData,
  WorkerDisconnectReason,
  workerDisconnectReasonToJSON,
} from "../../../../proto/src/components/connect/protobuf/connect.ts";
import { version } from "../../../../version.ts";
import { ensureUnsharedArrayBuffer } from "../../buffer.ts";
import { createStartRequest, parseConnectMessage } from "../../messages.ts";
import { getHostname, retrieveSystemAttributes } from "../../os.ts";
import { AuthError, ConnectionLimitError, ReconnectError } from "../../util.ts";
import type { Connection, ConnectionCoreConfig } from "./connection.ts";

const ConnectWebSocketProtocol = "v0.connect.inngest.com";

export interface EstablishConnectionResult {
  conn: Connection;
  gatewayGroup: string;
}

/**
 * Send the HTTP start request to the Inngest API to obtain a gateway endpoint
 * and session tokens.
 */
export async function sendStartRequest(
  config: ConnectionCoreConfig,
  hashedSigningKey: string | undefined,
  attempt: number,
  excludeGateways: Set<string>,
  logger: Logger,
) {
  const msg = createStartRequest(Array.from(excludeGateways));

  const headers: Record<string, string> = {
    "Content-Type": "application/protobuf",
    ...(hashedSigningKey
      ? { Authorization: `Bearer ${hashedSigningKey}` }
      : {}),
  };

  if (config.envName) {
    headers[headerKeys.Environment] = config.envName;
  }

  const targetUrl = new URL(
    "/v0/connect/start",
    await resolveApiBaseUrl({
      apiBaseUrl: config.apiBaseUrl,
      mode: config.mode,
    }),
  );

  let resp;
  try {
    resp = await fetch(targetUrl, {
      method: "POST",
      body: new Uint8Array(msg),
      headers: headers,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    throw new ReconnectError(
      `Failed initial API handshake request to ${targetUrl.toString()}, ${errMsg}`,
      attempt,
    );
  }

  if (!resp.ok) {
    if (resp.status === 401) {
      throw new AuthError(
        `Failed initial API handshake request to ${targetUrl.toString()}${
          config.envName ? ` (env: ${config.envName})` : ""
        }, ${await resp.text()}`,
        attempt,
      );
    }

    if (resp.status === 429) {
      throw new ConnectionLimitError(attempt);
    }

    throw new ReconnectError(
      `Failed initial API handshake request to ${targetUrl.toString()}, ${await resp.text()}`,
      attempt,
    );
  }

  const { parseStartResponse } = await import("../../messages.ts");
  return parseStartResponse(resp);
}

/**
 * Establish a WebSocket connection to the gateway.
 *
 * Performs the full handshake sequence (HTTP start → WS open → HELLO →
 * WORKER_CONNECT → CONNECTION_READY) and returns a {@link Connection} with
 * post-handshake handlers left unset — the caller must wire `ws.onerror`,
 * `ws.onclose`, and `ws.onmessage`.
 */
export async function establishConnection(
  config: ConnectionCoreConfig,
  hashedSigningKey: string | undefined,
  attempt: number,
  excludeGateways: Set<string>,
  logger: Logger,
): Promise<EstablishConnectionResult> {
  logger.debug({ attempt }, "Preparing connection");

  const startedAt = new Date();
  const startResp = await sendStartRequest(
    config,
    hashedSigningKey,
    attempt,
    excludeGateways,
    logger,
  );

  const connectionId = startResp.connectionId;

  let resolveWsConnected: (() => void) | undefined;
  let rejectWsConnected: ((reason?: unknown) => void) | undefined;
  const wsConnectedPromise = new Promise<void>((resolve, reject) => {
    resolveWsConnected = resolve;
    rejectWsConnected = reject;
  });

  const connectTimeout = setTimeout(() => {
    excludeGateways.add(startResp.gatewayGroup);
    rejectWsConnected?.(
      new ReconnectError(`Connection ${connectionId} timed out`, attempt),
    );
  }, 10_000);

  const finalEndpoint = config.gatewayUrl || startResp.gatewayEndpoint;
  if (finalEndpoint !== startResp.gatewayEndpoint) {
    logger.debug(
      { original: startResp.gatewayEndpoint, override: finalEndpoint },
      "Overriding gateway endpoint",
    );
  }

  logger.debug(
    {
      endpoint: finalEndpoint,
      gatewayGroup: startResp.gatewayGroup,
      connectionId,
    },
    "Connecting to gateway",
  );

  const ws = new WebSocket(finalEndpoint, [ConnectWebSocketProtocol]);
  ws.binaryType = "arraybuffer";

  // Track whether we've rejected/resolved the handshake promise so we
  // don't double-settle from concurrent error/close events.
  let settled = false;

  const rejectHandshake = (error: unknown) => {
    if (settled) return;
    settled = true;

    excludeGateways.add(startResp.gatewayGroup);
    clearTimeout(connectTimeout);

    ws.onerror = () => {};
    ws.onclose = () => {};
    ws.close(
      4001,
      workerDisconnectReasonToJSON(WorkerDisconnectReason.UNEXPECTED),
    );

    rejectWsConnected?.(
      new ReconnectError(
        `Error while connecting (${connectionId}): ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        attempt,
      ),
    );
  };

  ws.onerror = (err) => rejectHandshake(err);
  ws.onclose = (ev) => {
    rejectHandshake(
      new ReconnectError(
        `Connection ${connectionId} closed: ${ev.reason}`,
        attempt,
      ),
    );
  };

  const setupState = {
    receivedGatewayHello: false,
    sentWorkerConnect: false,
    receivedConnectionReady: false,
  };

  let heartbeatIntervalMs: number | undefined;
  let extendLeaseIntervalMs: number | undefined;
  let statusIntervalMs: number | undefined;

  ws.onmessage = async (event) => {
    const messageBytes = new Uint8Array(event.data as ArrayBuffer);
    const connectMessage = parseConnectMessage(messageBytes);

    logger.debug(
      { kind: gatewayMessageTypeToJSON(connectMessage.kind), connectionId },
      "Received message",
    );

    if (!setupState.receivedGatewayHello) {
      if (connectMessage.kind !== GatewayMessageType.GATEWAY_HELLO) {
        rejectHandshake(
          new ReconnectError(
            `Expected hello message, got ${gatewayMessageTypeToJSON(
              connectMessage.kind,
            )}`,
            attempt,
          ),
        );
        return;
      }
      setupState.receivedGatewayHello = true;
    }

    if (!setupState.sentWorkerConnect) {
      const workerConnectRequestMsg = WorkerConnectRequestData.create({
        connectionId: startResp.connectionId,
        environment: config.envName,
        platform: getPlatformName({ ...allProcessEnv() }),
        sdkVersion: `v${version}`,
        sdkLanguage: "typescript",
        framework: "connect",
        workerManualReadinessAck: config.connectionData.manualReadinessAck,
        systemAttributes: await retrieveSystemAttributes(),
        authData: {
          sessionToken: startResp.sessionToken,
          syncToken: startResp.syncToken,
        },
        apps: config.connectionData.apps,
        capabilities: new TextEncoder().encode(
          config.connectionData.marshaledCapabilities,
        ),
        startedAt: startedAt,
        instanceId: config.instanceId || (await getHostname()),
        maxWorkerConcurrency: config.maxWorkerConcurrency,
      });

      const workerConnectRequestMsgBytes = WorkerConnectRequestData.encode(
        workerConnectRequestMsg,
      ).finish();

      ws.send(
        ensureUnsharedArrayBuffer(
          ConnectMessage.encode(
            ConnectMessage.create({
              kind: GatewayMessageType.WORKER_CONNECT,
              payload: workerConnectRequestMsgBytes,
            }),
          ).finish(),
        ),
      );

      setupState.sentWorkerConnect = true;
      return;
    }

    if (!setupState.receivedConnectionReady) {
      if (connectMessage.kind !== GatewayMessageType.GATEWAY_CONNECTION_READY) {
        rejectHandshake(
          new ReconnectError(
            `Expected ready message, got ${gatewayMessageTypeToJSON(
              connectMessage.kind,
            )}`,
            attempt,
          ),
        );
        return;
      }

      const readyPayload = GatewayConnectionReadyData.decode(
        connectMessage.payload,
      );

      setupState.receivedConnectionReady = true;

      heartbeatIntervalMs =
        readyPayload.heartbeatInterval.length > 0
          ? ms(readyPayload.heartbeatInterval as ms.StringValue)
          : 10_000;
      extendLeaseIntervalMs =
        readyPayload.extendLeaseInterval.length > 0
          ? ms(readyPayload.extendLeaseInterval as ms.StringValue)
          : 5_000;

      statusIntervalMs =
        readyPayload.statusInterval.length > 0
          ? ms(readyPayload.statusInterval as ms.StringValue)
          : 0;

      resolveWsConnected?.();
      return;
    }

    logger.warn(
      {
        kind: gatewayMessageTypeToJSON(connectMessage.kind),
        rawKind: connectMessage.kind,
        attempt,
        setupState,
        connectionId,
      },
      "Unexpected message type during setup",
    );
  };

  await wsConnectedPromise;

  clearTimeout(connectTimeout);
  excludeGateways.delete(startResp.gatewayGroup);

  // Build the Connection object
  const conn: Connection = {
    id: connectionId,
    ws,
    pendingHeartbeats: 0,
    dead: false,
    heartbeatIntervalMs: heartbeatIntervalMs ?? 10_000,
    extendLeaseIntervalMs: extendLeaseIntervalMs ?? 5_000,
    statusIntervalMs: statusIntervalMs ?? 0,
    close: () => {
      if (conn.dead) return;
      conn.dead = true;
      ws.onerror = () => {};
      ws.onclose = () => {};
      ws.close();
    },
  };

  logger.info(
    { connectionId, gatewayGroup: startResp.gatewayGroup },
    "Connection established",
  );

  return { conn, gatewayGroup: startResp.gatewayGroup };
}
