import { InngestCommHandler } from "inngest";
import { ulid } from "ulid";
import { headerKeys, queryKeys } from "../../helpers/consts.js";
import { allProcessEnv, getPlatformName } from "../../helpers/env.js";
import { parseFnData } from "../../helpers/functions.js";
import { hashSigningKey } from "../../helpers/strings.js";
import {
  ConnectMessage,
  FlushResponse,
  type GatewayExecutorRequestData,
  GatewayMessageType,
  SDKResponse,
  SDKResponseStatus,
  WorkerConnectRequestData,
  WorkerRequestAckData,
} from "../../proto/src/components/connect/protobuf/connect.js";
import { type Capabilities, type FunctionConfig } from "../../types.js";
import { version } from "../../version.js";
import { PREFERRED_EXECUTION_VERSION } from "../execution/InngestExecution.js";
import { type Inngest } from "../Inngest.js";
import {
  createStartRequest,
  parseConnectMessage,
  parseGatewayExecutorRequest,
  parseStartResponse,
  parseWorkerReplyAck,
} from "./messages.js";
import { type ConnectHandlerOptions, type WorkerConnection } from "./types.js";
import { WaitGroup } from "@jpwilliams/waitgroup";

const ResponseAcknowlegeDeadline = 5_000;
const WorkerHeartbeatInterval = 10_000;

interface connectionEstablishData {
  numCpuCores: number;
  totalMem: number;
  os: string;
  marshaledFunctions: string;
  marshaledCapabilities: string;
  manualReadinessAck: boolean;
}

type ConnectCommHandler = InngestCommHandler<
  [GatewayExecutorRequestData],
  SDKResponse,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
>;

class ReconnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconnectError";
  }
}

enum ConnectionState {
  CONNECTING,
  ACTIVE,
  PAUSED,
  RECONNECTING,
  CLOSED,
}

class MessageBuffer {
  private buffered: Record<string, SDKResponse> = {};
  private pending: Record<string, SDKResponse> = {};
  private inngest: Inngest.Any;

  constructor(inngest: Inngest.Any) {
    this.inngest = inngest;
  }

  public append(response: SDKResponse) {
    this.buffered[response.requestId] = response;
    delete this.pending[response.requestId];
  }

  public addPending(response: SDKResponse, deadline: number) {
    this.pending[response.requestId] = response;
    setTimeout(() => {
      if (this.pending[response.requestId]) {
        console.log("Message not acknowledged in time", response.requestId);
        this.append(response);
      }
    }, deadline);
  }

  public acknowledgePending(requestId: string) {
    delete this.pending[requestId];
  }

  private async sendFlushRequest(
    hashedSigningKey: string | undefined,
    msg: SDKResponse
  ) {
    const headers: Record<string, string> = {
      "Content-Type": "application/protobuf",
      ...(hashedSigningKey
        ? { Authorization: `Bearer ${hashedSigningKey}` }
        : {}),
    };

    if (this.inngest.env) {
      headers[headerKeys.Environment] = this.inngest.env;
    }

    const resp = await fetch(
      // refactor this to a more universal spot
      await this.inngest["inngestApi"]["getTargetUrl"]("/v0/connect/flush"),
      {
        method: "POST",
        body: SDKResponse.encode(msg).finish(),
        headers: headers,
      }
    );

    if (!resp.ok) {
      console.error("Failed to flush messages", await resp.text());
      throw new Error("Failed to flush messages");
    }

    const flushResp = FlushResponse.decode(
      new Uint8Array(await resp.arrayBuffer())
    );

    return flushResp;
  }

  public async flush(hashedSigningKey: string | undefined) {
    if (Object.keys(this.buffered).length === 0) {
      return;
    }

    console.log(`Flushing ${Object.keys(this.buffered).length} messages`);

    for (let attempt = 0; attempt < 5; attempt++) {
      for (const [k, v] of Object.entries(this.buffered)) {
        try {
          await this.sendFlushRequest(hashedSigningKey, v);
          delete this.buffered[k];
        } catch (err) {
          console.error("Failed to flush message", k, err);
          break;
        }
      }

      if (Object.keys(this.buffered).length === 0) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, expBackoff(attempt)));
    }

    throw new Error("Failed to flush messages");
  }
}

class WebSocketWorkerConnection implements WorkerConnection {
  public _connectionId: string | undefined;

  private inngest: Inngest.Any;

  private ctx: AbortController;
  private _cleanup: (() => void | Promise<void>)[] = [];

  private state: ConnectionState = ConnectionState.CONNECTING;
  private inProgressRequests = new WaitGroup();
  private closingPromise: Promise<void> | undefined;
  private currentWs: WebSocket | undefined;

  private lastGatewayHeartbeatAt: Date | undefined;

  private messageBuffer: MessageBuffer;

  private setupState = {
    receivedGatewayHello: false,
    sentWorkerConnect: false,
    receivedConnectionReady: false,
  };

  private options: ConnectHandlerOptions;

  constructor(inngest: Inngest.Any, options: ConnectHandlerOptions) {
    this.inngest = inngest;
    this.options = options;
    this.ctx = new AbortController();
    this.messageBuffer = new MessageBuffer(inngest);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async close(): Promise<void> {
    this.ctx.abort();
    await this.cleanup();
    this.state = ConnectionState.CLOSED;
    return this.closed;
  }

  get closed(): Promise<void> {
    if (!this.closingPromise) {
      throw new Error("No connection established");
    }
    return this.closingPromise;
  }

  get connectionId(): string {
    if (!this._connectionId) {
      throw new Error("Connection not prepared");
    }
    return this._connectionId;
  }

  private isCanceled() {
    const signals: AbortSignal[] = [this.ctx.signal];
    if (this.options.abortSignal) {
      signals.push(this.options.abortSignal);
    }
    return AbortSignal.any(signals).aborted;
  }

  private async cleanup() {
    for (const cleanup of this._cleanup) {
      await cleanup();
    }
  }

  public async connect() {
    // Clean up any previous connection state
    // Note: Never reset the message buffer, as there may be pending/unsent messages
    {
      this.setupState = {
        receivedGatewayHello: false,
        sentWorkerConnect: false,
        receivedConnectionReady: false,
      };
      this._connectionId = undefined;
      this.lastGatewayHeartbeatAt = undefined;

      // Run all cleanup functions to stop heartbeats, etc.
      await this.cleanup();
    }

    console.log("Connecting...");

    if (this.inngest["mode"].isCloud && !this.options.signingKey) {
      throw new Error("Signing key is required");
    }

    const hashedSigningKey = this.options.signingKey
      ? hashSigningKey(this.options.signingKey)
      : undefined;

    let hashedFallbackKey = undefined;
    if (this.options.signingKeyFallback) {
      hashedFallbackKey = hashSigningKey(this.options.signingKeyFallback);
    }

    try {
      await this.messageBuffer.flush(hashedSigningKey);
    } catch (err) {
      console.error("Failed to flush messages, using fallback key", err);
      await this.messageBuffer.flush(hashedFallbackKey);
    }

    const capabilities: Capabilities = {
      trust_probe: "v1",
      connect: "v1",
    };

    const functions: Array<FunctionConfig> = this.options.functions.flatMap(
      (f) => f["getConfig"](new URL("http://example.com")) // refactor; base URL shouldn't be optional here; we likely need to fetch a different kind of config
    );

    const data: connectionEstablishData = {
      manualReadinessAck: false,

      // "os" for these with optional import
      numCpuCores: 0,
      totalMem: 0,
      os: "linux", // TODO Retrieve this

      marshaledCapabilities: JSON.stringify(capabilities),
      marshaledFunctions: JSON.stringify(functions),
    };

    const appName = this.inngest.id;

    const inngestCommHandler: ConnectCommHandler = new InngestCommHandler({
      client: this.inngest,
      functions: this.options.functions,
      frameworkName: "connect",
      skipSignatureValidation: true,
      handler: (msg: GatewayExecutorRequestData) => {
        const asString = new TextDecoder().decode(msg.requestPayload);
        const parsed = parseFnData(JSON.parse(asString));

        return {
          body() {
            return parsed;
          },
          method() {
            return "POST";
          },
          headers(key) {
            switch (key) {
              case headerKeys.ContentLength.toString():
                return asString.length.toString();
              case headerKeys.InngestExpectedServerKind.toString():
                return "connect";
              case headerKeys.RequestVersion.toString():
                return parsed.version.toString();
              case headerKeys.Signature.toString():
                // Note: Signature is disabled for connect
                return null;
              case headerKeys.TraceParent.toString():
              case headerKeys.TraceState.toString():
                return null;
              default:
                return null;
            }
          },
          transformResponse({ body, headers, status }) {
            let sdkResponseStatus: SDKResponseStatus = SDKResponseStatus.DONE;
            switch (status) {
              case 200:
                sdkResponseStatus = SDKResponseStatus.DONE;
                break;
              case 206:
                sdkResponseStatus = SDKResponseStatus.NOT_COMPLETED;
                break;
              case 500:
                sdkResponseStatus = SDKResponseStatus.ERROR;
                break;
            }

            return SDKResponse.create({
              requestId: msg.requestId,
              envId: msg.envId,
              appId: msg.appId,
              status: sdkResponseStatus,
              body: new TextEncoder().encode(body),
              noRetry: headers[headerKeys.NoRetry] === "true",
              retryAfter: headers[headerKeys.RetryAfter],
              sdkVersion: `v${version}`,
              requestVersion: parseInt(
                headers[headerKeys.RequestVersion] ??
                  PREFERRED_EXECUTION_VERSION.toString(),
                10
              ),
            });
          },
          url() {
            const baseUrl = new URL("http://connect.inngest.com");

            const functionId = `${appName}-${msg.functionSlug}`;
            baseUrl.searchParams.set(queryKeys.FnId, functionId);

            if (msg.stepId) {
              baseUrl.searchParams.set(queryKeys.StepId, msg.stepId);
            }

            return baseUrl;
          },
          isProduction: () => {
            try {
              // eslint-disable-next-line @inngest/internal/process-warn
              const isProd = process.env.NODE_ENV === "production";
              return isProd;
            } catch (err) {
              // no-op
            }
          },
        };
      },
    });
    const requestHandler = inngestCommHandler.createHandler();

    let attempt = 0;
    while (!this.isCanceled()) {
      try {
        await this.prepareConnection(requestHandler, hashedSigningKey, data);
        return this;
      } catch (err) {
        console.error("Failed to connect", err);

        if (!(err instanceof ReconnectError)) {
          throw err;
        }

        const delay = expBackoff(attempt);
        console.log("Reconnecting in", delay, "ms");
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt++;
      }
    }
  }

  private onConnectionError(error: unknown) {
    this.state = ConnectionState.RECONNECTING;

    console.error("Connection error", error);
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.connect();
  }

  private setupHeartbeat(ws: WebSocket, hashedSigningKey: string | undefined) {
    const currentConnId = this._connectionId;
    const cancel = setInterval(() => {
      if (currentConnId !== this._connectionId) {
        console.log("Connection ID changed, stopping heartbeat");
        clearInterval(cancel);
        return;
      }

      // Send worker heartbeat
      const pingMsg = ConnectMessage.create({
        kind: GatewayMessageType.WORKER_HEARTBEAT,
      });
      ws.send(ConnectMessage.encode(pingMsg).finish());

      // Wait for gateway to respond
      setTimeout(() => {
        if (!this.lastGatewayHeartbeatAt) {
          console.error("Gateway heartbeat missed");
          this.onConnectionError(new Error("Gateway heartbeat missed"));
          return;
        }
        const timeSinceLastHeartbeat =
          new Date().getTime() - this.lastGatewayHeartbeatAt.getTime();
        if (timeSinceLastHeartbeat > WorkerHeartbeatInterval * 2) {
          console.error("Gateway heartbeat missed");
          this.onConnectionError(new Error("Gateway heartbeat missed"));
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.messageBuffer.flush(hashedSigningKey);
      }, WorkerHeartbeatInterval / 2);
    }, WorkerHeartbeatInterval);
    this._cleanup.push(() => clearInterval(cancel));
  }

  private async prepareConnection(
    requestHandler: (msg: GatewayExecutorRequestData) => Promise<SDKResponse>,
    hashedSigningKey: string | undefined,
    data: connectionEstablishData
  ): Promise<void> {
    const startedAt = new Date();
    const msg = createStartRequest();

    const headers: Record<string, string> = {
      "Content-Type": "application/protobuf",
      ...(hashedSigningKey
        ? { Authorization: `Bearer ${hashedSigningKey}` }
        : {}),
    };

    if (this.inngest.env) {
      headers[headerKeys.Environment] = this.inngest.env;
    }

    const resp = await fetch(
      // refactor this to a more universal spot
      await this.inngest["inngestApi"]["getTargetUrl"]("/v0/connect/start"),
      {
        method: "POST",
        body: msg,
        headers: headers,
      }
    );

    if (!resp.ok) {
      throw new ReconnectError("Failed to prepare connection");
    }

    const startResp = await parseStartResponse(resp);

    const connectionId = ulid();

    this._connectionId = connectionId;

    if (typeof WebSocket === "undefined") {
      throw new Error("WebSockets not supported in current environment");
    }

    let resolveWebsocketConnected:
      | ((value: void | PromiseLike<void>) => void)
      | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rejectWebsocketConnected: ((reason?: any) => void) | undefined;
    const websocketConnectedPromise = new Promise((resolve, reject) => {
      resolveWebsocketConnected = resolve;
      rejectWebsocketConnected = reject;
    });

    const connectTimeout = setTimeout(() => {
      rejectWebsocketConnected?.(new Error("Connection timed out"));
    }, 10_000);

    const ws = new WebSocket(startResp.gatewayEndpoint, [
      "v0.connect.inngest.com",
    ]);
    ws.binaryType = "arraybuffer";
    ws.onerror = (err) => this.onConnectionError(err);
    ws.onclose = (ev) => {
      this.onConnectionError(new Error(`Connection closed: ${ev.reason}`));
    };

    ws.onmessage = async (event) => {
      const messageBytes = new Uint8Array(event.data as ArrayBuffer);

      console.debug("Received WebSocket message");

      {
        if (!this.setupState.receivedGatewayHello) {
          const helloMessage = parseConnectMessage(messageBytes);
          if (helloMessage.kind !== GatewayMessageType.GATEWAY_HELLO) {
            throw new Error(`Expected hello message, got ${helloMessage.kind}`);
          }
          this.setupState.receivedGatewayHello = true;
        }

        if (!this.setupState.sentWorkerConnect) {
          const workerConnectRequestMsg = WorkerConnectRequestData.create({
            appName: this.inngest.id,
            environment: this.inngest.env || undefined,
            platform: getPlatformName({
              ...allProcessEnv(),
            }),
            sdkVersion: `v${version}`,
            sdkLanguage: "typescript",
            framework: "connect",
            workerManualReadinessAck: data.manualReadinessAck,
            systemAttributes: {
              cpuCores: data.numCpuCores,
              memBytes: data.totalMem,
              os: data.os,
            },
            authData: {
              sessionToken: startResp.sessionToken,
              syncToken: startResp.syncToken,
            },
            config: {
              capabilities: new TextEncoder().encode(
                data.marshaledCapabilities
              ),
              functions: new TextEncoder().encode(data.marshaledFunctions),
            },
            startedAt: startedAt,
            sessionId: {
              connectionId: connectionId,
              buildId: this.inngest.buildId,
              instanceId: this.options.instanceId,
            },
          });

          const workerConnectRequestMsgBytes = WorkerConnectRequestData.encode(
            workerConnectRequestMsg
          ).finish();

          ws.send(
            ConnectMessage.encode(
              ConnectMessage.create({
                kind: GatewayMessageType.WORKER_CONNECT,
                payload: workerConnectRequestMsgBytes,
              })
            ).finish()
          );

          this.setupState.sentWorkerConnect = true;
          return;
        }

        if (!this.setupState.receivedConnectionReady) {
          const readyMessage = parseConnectMessage(messageBytes);
          if (
            readyMessage.kind !== GatewayMessageType.GATEWAY_CONNECTION_READY
          ) {
            throw new Error("Expected ready message");
          }

          this.setupState.receivedConnectionReady = true;
          this.state = ConnectionState.ACTIVE;
          clearTimeout(connectTimeout);
          resolveWebsocketConnected?.();
          this.currentWs = ws;
          console.log("Connection ready");

          return;
        }
      }

      // Run loop
      if (this.isCanceled()) {
        console.log("Connection is canceled, returning early");
        // TODO Handle abort closure
        return;
      }

      const connectMessage = parseConnectMessage(messageBytes);

      console.log(`Received message: ${connectMessage.kind}`);

      if (connectMessage.kind === GatewayMessageType.GATEWAY_CLOSING) {
        try {
          // Wait for new conn to be successfully established
          await this.connect();

          await this.cleanup();

          // Close original connection once new conn is established
          ws.close();
        } catch (err) {
          console.log("Failed to reconnect after receiving draining message");
          ws.close();
        }
        return;
      }

      if (connectMessage.kind === GatewayMessageType.GATEWAY_HEARTBEAT) {
        this.lastGatewayHeartbeatAt = new Date();
        console.log("Received heartbeat");
        return;
      }

      if (connectMessage.kind === GatewayMessageType.GATEWAY_EXECUTOR_REQUEST) {
        const gatewayExecutorRequest = parseGatewayExecutorRequest(
          connectMessage.payload
        );

        console.log(
          "Received gateway executor request",
          gatewayExecutorRequest.requestId
        );

        // Ack received request
        ws.send(
          ConnectMessage.encode(
            ConnectMessage.create({
              kind: GatewayMessageType.WORKER_REQUEST_ACK,
              payload: WorkerRequestAckData.encode(
                WorkerRequestAckData.create({
                  appId: gatewayExecutorRequest.appId,
                  functionSlug: gatewayExecutorRequest.functionSlug,
                  requestId: gatewayExecutorRequest.requestId,
                  stepId: gatewayExecutorRequest.stepId,
                })
              ).finish(),
            })
          ).finish()
        );

        this.inProgressRequests.add(1);
        try {
          const res = await requestHandler(gatewayExecutorRequest);

          console.log("Sending worker reply");

          this.messageBuffer.addPending(res, ResponseAcknowlegeDeadline);

          if (!this.currentWs) {
            console.error("No current WebSocket, buffering response");
            this.messageBuffer.append(res);
            return;
          }

          // Send reply back to gateway
          this.currentWs.send(
            ConnectMessage.encode(
              ConnectMessage.create({
                kind: GatewayMessageType.WORKER_REPLY,
                payload: SDKResponse.encode(res).finish(),
              })
            ).finish()
          );
        } finally {
          this.inProgressRequests.done();
        }

        return;
      }

      if (connectMessage.kind === GatewayMessageType.WORKER_REPLY_ACK) {
        const replyAck = parseWorkerReplyAck(connectMessage.payload);

        console.log("Acknowledging reply ack", replyAck.requestId);

        this.messageBuffer.acknowledgePending(replyAck.requestId);

        return;
      }

      console.error("Unknown message type", connectMessage.kind);
    };

    await websocketConnectedPromise;

    this.setupHeartbeat(ws, hashedSigningKey);

    const closeConnectionCleanup = async () => {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }

      ws.send(
        ConnectMessage.encode(
          ConnectMessage.create({
            kind: GatewayMessageType.WORKER_PAUSE,
          })
        ).finish()
      );

      // Wait for remaining messages to be processed
      await this.inProgressRequests.wait();

      await this.messageBuffer.flush(hashedSigningKey);

      ws.close();
    };
    this._cleanup.push(closeConnectionCleanup);

    return;
  }
}

export const connect = async (
  inngest: Inngest.Any,
  options: ConnectHandlerOptions
  // eslint-disable-next-line @typescript-eslint/require-await
): Promise<WorkerConnection> => {
  const conn = new WebSocketWorkerConnection(inngest, options);

  await conn.connect();

  return conn;
};

function expBackoff(attempt: number) {
  const backoffTimes = [
    1000, 2000, 5000, 10000, 20000, 30000, 60000, 120000, 300000,
  ];
  // If attempt exceeds array length, use the last (maximum) value
  return backoffTimes[Math.min(attempt, backoffTimes.length - 1)];
}
