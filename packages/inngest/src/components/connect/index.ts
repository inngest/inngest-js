import { InngestCommHandler } from "../InngestCommHandler.js";
import { ulid } from "ulid";
import { headerKeys, queryKeys } from "../../helpers/consts.js";
import { allProcessEnv, getPlatformName } from "../../helpers/env.js";
import { parseFnData } from "../../helpers/functions.js";
import { hashSigningKey } from "../../helpers/strings.js";
import {
  ConnectMessage,
  type GatewayExecutorRequestData,
  GatewayMessageType,
  gatewayMessageTypeToJSON,
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
import {
  ConnectionState,
  DEFAULT_SHUTDOWN_SIGNALS,
  type ConnectHandlerOptions,
  type WorkerConnection,
} from "./types.js";
import { WaitGroup } from "@jpwilliams/waitgroup";
import debug, { type Debugger } from "debug";
import { onShutdown, retrieveSystemAttributes } from "./os.js";
import { MessageBuffer } from "./buffer.js";
import {
  expBackoff,
  AuthError,
  ReconnectError,
  ConnectionLimitError,
} from "./util.js";

const ResponseAcknowlegeDeadline = 5_000;
const WorkerHeartbeatInterval = 10_000;

interface connectionEstablishData {
  marshaledFunctions: string;
  marshaledCapabilities: string;
  manualReadinessAck: boolean;
}

const ConnectWebSocketProtocol = "v0.connect.inngest.com";

type ConnectCommHandler = InngestCommHandler<
  [GatewayExecutorRequestData],
  SDKResponse,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
>;

class WebSocketWorkerConnection implements WorkerConnection {
  private inngest: Inngest.Any;
  private options: ConnectHandlerOptions;
  private debug: Debugger;

  /**
   * The current connection ID of the worker.
   *
   * Will be updated for every new connection attempt.
   */
  public _connectionId: string | undefined;

  /**
   * The current state of the connection.
   */
  public state: ConnectionState = ConnectionState.CONNECTING;

  /**
   * The current WebSocket connection.
   */
  private currentWs: WebSocket | undefined;

  /**
   * A wait group to track in-flight requests.
   */
  private inProgressRequests = new WaitGroup();

  /**
   * The buffer of messages to be sent to the gateway.
   */
  private messageBuffer: MessageBuffer;

  private _hashedSigningKey: string | undefined;
  private _hashedFallbackKey: string | undefined;

  /**
   * A set of gateways to exclude from the connection.
   */
  private excludeGateways: Set<string> = new Set();

  /**
   * The last time the gateway heartbeat was received.
   */
  private lastGatewayHeartbeatAt: Date | undefined;

  /**
   * The cleanup functions to be run when the connection is closed.
   *
   * These are specific to each connection attempt.
   */
  private _cleanup: (() => void | Promise<void>)[] = [];

  /**
   * Function to remove the shutdown signal handler.
   */
  private cleanupShutdownSignal: (() => void) | undefined;

  /**
   * A promise that resolves when the connection is closed on behalf of the
   * user by calling `close()` or when a shutdown signal is received.
   */
  private closingPromise: Promise<void> | undefined;
  private resolveClosingPromise:
    | ((value: void | PromiseLike<void>) => void)
    | undefined;

  constructor(inngest: Inngest.Any, options: ConnectHandlerOptions) {
    this.inngest = inngest;
    this.options = this.applyDefaults(options);
    this.debug = debug("inngest:connect");

    this.messageBuffer = new MessageBuffer(inngest);

    this.closingPromise = new Promise((resolve) => {
      this.resolveClosingPromise = resolve;
    });
  }

  private applyDefaults(opts: ConnectHandlerOptions): ConnectHandlerOptions {
    const options = { ...opts };
    if (!Array.isArray(options.handleShutdownSignals)) {
      options.handleShutdownSignals = DEFAULT_SHUTDOWN_SIGNALS;
    }
    return options;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async close(): Promise<void> {
    // Remove the shutdown signal handler
    if (this.cleanupShutdownSignal) {
      this.cleanupShutdownSignal();
      this.cleanupShutdownSignal = undefined;
    }

    this.state = ConnectionState.CLOSING;

    this.debug("Cleaning up connection resources");

    // Run all cleanup functions to stop heartbeats, etc.
    // If the previous connection was already closed, this will be a no-op.
    await this.cleanup();

    this._connectionId = undefined;
    this.currentWs = undefined;
    this.lastGatewayHeartbeatAt = undefined;

    this.state = ConnectionState.CLOSED;

    this.debug("Connection closed");

    this.debug("Waiting for in-flight requests to complete");

    await this.inProgressRequests.wait();

    this.debug("Flushing messages before closing");

    try {
      await this.messageBuffer.flush(this._hashedSigningKey);
    } catch (err) {
      this.debug("Failed to flush messages, using fallback key", err);
      await this.messageBuffer.flush(this._hashedFallbackKey);
    }

    this.resolveClosingPromise?.();
    return this.closed;
  }

  /**
   * A promise that resolves when the connection is closed on behalf of the
   * user by calling `close()` or when a shutdown signal is received.
   */
  get closed(): Promise<void> {
    if (!this.closingPromise) {
      throw new Error("No connection established");
    }
    return this.closingPromise;
  }

  /**
   * The current connection ID of the worker.
   */
  get connectionId(): string {
    if (!this._connectionId) {
      throw new Error("Connection not prepared");
    }
    return this._connectionId;
  }

  /**
   * Run all cleanup functions to stop heartbeats, etc.
   */
  private async cleanup() {
    for (const cleanup of this._cleanup) {
      await cleanup();
    }
    this._cleanup = [];
  }

  /**
   * Establish a persistent connection to the gateway.
   */
  public async connect(attempt = 0) {
    if (typeof WebSocket === "undefined") {
      throw new Error("WebSockets not supported in current environment");
    }

    if (
      this.state === ConnectionState.CLOSING ||
      this.state === ConnectionState.CLOSED
    ) {
      throw new Error("Connection already closed");
    }

    this.debug("Establishing connection");

    if (this.inngest["mode"].isCloud && !this.options.signingKey) {
      throw new Error("Signing key is required");
    }

    this._hashedSigningKey = this.options.signingKey
      ? hashSigningKey(this.options.signingKey)
      : undefined;

    if (this.options.signingKeyFallback) {
      this._hashedFallbackKey = hashSigningKey(this.options.signingKeyFallback);
    }

    try {
      await this.messageBuffer.flush(this._hashedSigningKey);
    } catch (err) {
      this.debug("Failed to flush messages, using fallback key", err);
      await this.messageBuffer.flush(this._hashedFallbackKey);
    }

    const capabilities: Capabilities = {
      trust_probe: "v1",
      connect: "v1",
    };

    const functions: Array<FunctionConfig> = this.options.functions.flatMap(
      (f) =>
        f["getConfig"]({
          baseUrl: new URL("wss://connect"),
          appPrefix: this.inngest.id,
          isConnect: true,
        })
    );

    const data: connectionEstablishData = {
      manualReadinessAck: false,

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

    if (
      this.options.handleShutdownSignals &&
      this.options.handleShutdownSignals.length > 0
    ) {
      this.setupShutdownSignal(this.options.handleShutdownSignals);
    }

    let useSigningKey = this._hashedSigningKey;
    while (
      ![ConnectionState.CLOSING, ConnectionState.CLOSED].includes(this.state)
    ) {
      try {
        await this.prepareConnection(
          requestHandler,
          useSigningKey,
          data,
          attempt
        );
        return this;
      } catch (err) {
        this.debug("Failed to connect", err);

        if (!(err instanceof ReconnectError)) {
          throw err;
        }

        attempt = err.attempt;

        if (err instanceof AuthError) {
          const switchToFallback = useSigningKey === this._hashedSigningKey;
          if (switchToFallback) {
            this.debug("Switching to fallback signing key");
          }
          useSigningKey = switchToFallback
            ? this._hashedFallbackKey
            : this._hashedSigningKey;
        }

        if (err instanceof ConnectionLimitError) {
          console.error(
            "You have reached the maximum number of concurrent connections. Please disconnect other active workers to continue."
          );
          // Continue reconnecting, do not throw.
        }

        const delay = expBackoff(attempt);
        this.debug("Reconnecting in", delay, "ms");
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt++;
      }
    }

    this.debug("Exiting connect loop");
  }

  private setupHeartbeat(
    ws: WebSocket,
    connectionId: string,
    hashedSigningKey: string | undefined,
    onMiss: () => void
  ) {
    const cancel = setInterval(() => {
      if (connectionId !== this._connectionId) {
        this.debug("Connection ID changed, stopping heartbeat", {
          initial: connectionId,
          current: this._connectionId,
        });
        clearInterval(cancel);
        return;
      }

      // Send worker heartbeat
      ws.send(
        ConnectMessage.encode(
          ConnectMessage.create({
            kind: GatewayMessageType.WORKER_HEARTBEAT,
          })
        ).finish()
      );

      // Wait for gateway to respond
      setTimeout(() => {
        if (!this.lastGatewayHeartbeatAt) {
          this.debug("Gateway heartbeat missed");
          onMiss();
          return;
        }
        const timeSinceLastHeartbeat =
          new Date().getTime() - this.lastGatewayHeartbeatAt.getTime();
        if (timeSinceLastHeartbeat > WorkerHeartbeatInterval * 2) {
          this.debug("Gateway heartbeat missed");
          onMiss();
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.messageBuffer.flush(hashedSigningKey);
      }, WorkerHeartbeatInterval / 2);
    }, WorkerHeartbeatInterval);

    return () => {
      this.debug("Clearing heartbeat interval", { connectionId });
      clearInterval(cancel);
    };
  }

  private async sendStartRequest(
    hashedSigningKey: string | undefined,
    attempt: number
  ) {
    const msg = createStartRequest(Array.from(this.excludeGateways));

    const headers: Record<string, string> = {
      "Content-Type": "application/protobuf",
      ...(hashedSigningKey
        ? { Authorization: `Bearer ${hashedSigningKey}` }
        : {}),
    };

    if (this.inngest.env) {
      headers[headerKeys.Environment] = this.inngest.env;
    }

    // refactor this to a more universal spot
    const targetUrl =
      await this.inngest["inngestApi"]["getTargetUrl"]("/v0/connect/start");

    let resp;
    try {
      resp = await fetch(targetUrl, {
        method: "POST",
        body: msg,
        headers: headers,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      throw new ReconnectError(
        `Failed initial API handshake request to ${targetUrl.toString()}, ${errMsg}`,
        attempt
      );
    }

    if (!resp.ok) {
      if (resp.status === 401) {
        throw new AuthError(
          `Failed initial API handshake request to ${targetUrl.toString()}, ${await resp.text()}`,
          attempt
        );
      }

      if (resp.status === 429) {
        throw new ConnectionLimitError(attempt);
      }

      throw new ReconnectError(
        `Failed initial API handshake request to ${targetUrl.toString()}, ${await resp.text()}`,
        attempt
      );
    }

    const startResp = await parseStartResponse(resp);

    return startResp;
  }

  private async prepareConnection(
    requestHandler: (msg: GatewayExecutorRequestData) => Promise<SDKResponse>,
    hashedSigningKey: string | undefined,
    data: connectionEstablishData,
    attempt: number
  ): Promise<void> {
    const connectionId = ulid();

    this.debug("Preparing connection", {
      attempt,
      connectionId,
    });

    // Clean up any previous connection state
    // Note: Never reset the message buffer, as there may be pending/unsent messages
    {
      this._connectionId = undefined;
      this.lastGatewayHeartbeatAt = undefined;

      // Flush any pending messages
      await this.messageBuffer.flush(hashedSigningKey);

      // Run all cleanup functions to stop heartbeats, etc.
      await this.cleanup();
    }

    const startedAt = new Date();

    const startResp = await this.sendStartRequest(hashedSigningKey, attempt);

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
      this.excludeGateways.add(startResp.gatewayGroup);
      rejectWebsocketConnected?.(
        new ReconnectError(`Connection ${connectionId} timed out`, attempt)
      );
    }, 10_000);

    let finalEndpoint = startResp.gatewayEndpoint;
    if (this.options.rewriteGatewayEndpoint) {
      const rewritten = this.options.rewriteGatewayEndpoint(
        startResp.gatewayEndpoint
      );
      this.debug("Rewriting gateway endpoint", {
        original: startResp.gatewayEndpoint,
        rewritten,
      });
      finalEndpoint = rewritten;
    }

    this.debug(`Connecting to gateway`, {
      endpoint: finalEndpoint,
      gatewayGroup: startResp.gatewayGroup,
      connectionId,
    });

    const ws = new WebSocket(finalEndpoint, [ConnectWebSocketProtocol]);
    ws.binaryType = "arraybuffer";

    let onConnectionError: (error: unknown) => void;
    {
      let erroredDuringInitialization = false;
      onConnectionError = (error: unknown) => {
        // Only process the first error per connection
        if (erroredDuringInitialization) {
          return;
        }
        erroredDuringInitialization = true;

        this.debug(`Connection error in connecting state, rejecting promise`, {
          connectionId,
        });

        this.excludeGateways.add(startResp.gatewayGroup);

        clearTimeout(connectTimeout);

        // Make sure to close the WebSocket if it's still open
        ws.close();

        rejectWebsocketConnected?.(
          new ReconnectError(
            `Error while connecting (${connectionId}): ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
            attempt
          )
        );
      };

      ws.onerror = (err) => onConnectionError(err);
      ws.onclose = (ev) => {
        onConnectionError(
          new ReconnectError(
            `Connection ${connectionId} closed: ${ev.reason}`,
            attempt
          )
        );
      };
    }

    /**
     * The current setup state of the connection.
     */
    const setupState = {
      receivedGatewayHello: false,
      sentWorkerConnect: false,
      receivedConnectionReady: false,
    };

    ws.onmessage = async (event) => {
      const messageBytes = new Uint8Array(event.data as ArrayBuffer);

      const connectMessage = parseConnectMessage(messageBytes);

      this.debug(
        `Received message: ${gatewayMessageTypeToJSON(connectMessage.kind)}`,
        {
          connectionId,
        }
      );

      if (!setupState.receivedGatewayHello) {
        if (connectMessage.kind !== GatewayMessageType.GATEWAY_HELLO) {
          onConnectionError(
            new ReconnectError(
              `Expected hello message, got ${gatewayMessageTypeToJSON(
                connectMessage.kind
              )}`,
              attempt
            )
          );
          return;
        }
        setupState.receivedGatewayHello = true;
      }

      if (!setupState.sentWorkerConnect) {
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
          systemAttributes: await retrieveSystemAttributes(),
          authData: {
            sessionToken: startResp.sessionToken,
            syncToken: startResp.syncToken,
          },
          config: {
            capabilities: new TextEncoder().encode(data.marshaledCapabilities),
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

        setupState.sentWorkerConnect = true;
        return;
      }

      if (!setupState.receivedConnectionReady) {
        if (
          connectMessage.kind !== GatewayMessageType.GATEWAY_CONNECTION_READY
        ) {
          onConnectionError(
            new ReconnectError(
              `Expected ready message, got ${gatewayMessageTypeToJSON(
                connectMessage.kind
              )}`,
              attempt
            )
          );
          return;
        }

        clearTimeout(connectTimeout);

        setupState.receivedConnectionReady = true;

        this.state = ConnectionState.ACTIVE;
        this.excludeGateways.delete(startResp.gatewayGroup);
        this.currentWs = ws;
        this._connectionId = connectionId;

        attempt = 0;

        this.debug(`Connection ready (${connectionId})`);
        resolveWebsocketConnected?.();

        return;
      }

      this.debug("Unexpected message type during setup", {
        kind: gatewayMessageTypeToJSON(connectMessage.kind),
        rawKind: connectMessage.kind,
        attempt,
        setupState: setupState,
        state: this.state,
        connectionId,
      });
    };

    await websocketConnectedPromise;

    {
      let erroredDuringRuntime = false;
      onConnectionError = (error: unknown) => {
        // Only process the first error per connection
        if (erroredDuringRuntime) {
          return;
        }
        erroredDuringRuntime = true;

        // Don't attempt to reconnect if we're already closing or closed
        if (
          this.state === ConnectionState.CLOSING ||
          this.state === ConnectionState.CLOSED
        ) {
          this.debug(
            `Connection error (${connectionId}) but already closing or closed, skipping`
          );
          return;
        }

        this.state = ConnectionState.RECONNECTING;
        this.excludeGateways.add(startResp.gatewayGroup);

        this.debug(`Connection error (${connectionId})`, error);
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.connect(attempt + 1);
      };

      ws.onerror = (err) => onConnectionError(err);
      ws.onclose = (ev) => {
        onConnectionError(
          new ReconnectError(`Connection closed: ${ev.reason}`, attempt)
        );
      };
    }

    ws.onmessage = async (event) => {
      const messageBytes = new Uint8Array(event.data as ArrayBuffer);

      const connectMessage = parseConnectMessage(messageBytes);

      if (connectMessage.kind === GatewayMessageType.GATEWAY_CLOSING) {
        try {
          // Wait for new conn to be successfully established
          await this.connect();

          await this.cleanup();

          // Close original connection once new conn is established
          ws.close();
        } catch (err) {
          this.debug("Failed to reconnect after receiving draining message", {
            connectionId,
          });
          ws.close();
        }
        return;
      }

      if (connectMessage.kind === GatewayMessageType.GATEWAY_HEARTBEAT) {
        this.lastGatewayHeartbeatAt = new Date();
        this.debug("Handled gateway heartbeat", {
          connectionId,
        });
        return;
      }

      if (connectMessage.kind === GatewayMessageType.GATEWAY_EXECUTOR_REQUEST) {
        if (this.state !== ConnectionState.ACTIVE) {
          this.debug("Received request while not active, skipping", {
            connectionId,
          });
          return;
        }

        const gatewayExecutorRequest = parseGatewayExecutorRequest(
          connectMessage.payload
        );

        this.debug("Received gateway executor request", {
          requestId: gatewayExecutorRequest.requestId,
          appId: gatewayExecutorRequest.appId,
          functionSlug: gatewayExecutorRequest.functionSlug,
          stepId: gatewayExecutorRequest.stepId,
          connectionId,
        });

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

          this.debug("Sending worker reply", {
            connectionId,
            requestId: gatewayExecutorRequest.requestId,
          });

          this.messageBuffer.addPending(res, ResponseAcknowlegeDeadline);

          if (!this.currentWs) {
            this.debug("No current WebSocket, buffering response", {
              connectionId,
              requestId: gatewayExecutorRequest.requestId,
            });
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

        this.debug("Acknowledging reply ack", {
          connectionId,
          requestId: replyAck.requestId,
        });

        this.messageBuffer.acknowledgePending(replyAck.requestId);

        return;
      }

      this.debug("Unexpected message type", {
        kind: gatewayMessageTypeToJSON(connectMessage.kind),
        rawKind: connectMessage.kind,
        attempt,
        setupState: setupState,
        state: this.state,
        connectionId,
      });
    };

    const heartbeatCleanup = this.setupHeartbeat(
      ws,
      connectionId,
      hashedSigningKey,
      () =>
        onConnectionError(
          new ReconnectError(
            `Gateway heartbeat missed (${connectionId})`,
            attempt
          )
        )
    );
    this._cleanup.push(heartbeatCleanup);

    const closeConnectionCleanup = () => {
      this.debug("Cleaning up connection", { connectionId });
      if (ws.readyState === WebSocket.OPEN) {
        this.debug("Sending pause message", { connectionId });
        ws.send(
          ConnectMessage.encode(
            ConnectMessage.create({
              kind: GatewayMessageType.WORKER_PAUSE,
            })
          ).finish()
        );
      }

      this.debug("Closing connection", { connectionId });
      ws.close();

      if (this._connectionId === connectionId) {
        this._connectionId = undefined;
        this.currentWs = undefined;
      }
    };
    this._cleanup.push(closeConnectionCleanup);

    return;
  }

  private setupShutdownSignal(signals: string[]) {
    if (this.cleanupShutdownSignal) {
      return;
    }

    this.debug(`Setting up shutdown signal handler for ${signals.join(", ")}`);

    const cleanupShutdownHandlers = onShutdown(signals, () => {
      this.debug("Received shutdown signal, closing connection");
      void this.close();
    });

    this.cleanupShutdownSignal = () => {
      this.debug("Cleaning up shutdown signal handler");
      cleanupShutdownHandlers();
    };
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
