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
import { expBackoff, AuthError, ReconnectError } from "./util.js";

const ResponseAcknowlegeDeadline = 5_000;
const WorkerHeartbeatInterval = 10_000;

interface connectionEstablishData {
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

class WebSocketWorkerConnection implements WorkerConnection {
  /**
   * The current connection ID of the worker.
   *
   * Will be updated for every new connection attempt.
   */
  public _connectionId: string | undefined;

  private inngest: Inngest.Any;

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
   * The cleanup function to be run when initiating shutdown.
   *
   * This should always run in case the previous connection was already shut down.
   */
  private cleanupBeforeClose: (() => void | Promise<void>) | undefined;

  /**
   * The current state of the connection.
   */
  public state: ConnectionState = ConnectionState.CONNECTING;

  /**
   * A wait group to track in-flight requests.
   */
  private inProgressRequests = new WaitGroup();

  /**
   * A promise that resolves when the connection is closed on behalf of the
   * user by calling `close()` or when a shutdown signal is received.
   */
  private closingPromise: Promise<void> | undefined;
  private resolveClosingPromise:
    | ((value: void | PromiseLike<void>) => void)
    | undefined;

  /**
   * The current WebSocket connection.
   */
  private currentWs: WebSocket | undefined;

  /**
   * The last time the gateway heartbeat was received.
   */
  private lastGatewayHeartbeatAt: Date | undefined;

  /**
   * The buffer of messages to be sent to the gateway.
   */
  private messageBuffer: MessageBuffer;

  /**
   * A set of gateways to exclude from the connection.
   */
  private _excludeGateways: Set<string> = new Set();

  private options: ConnectHandlerOptions;

  private debug: Debugger;

  constructor(inngest: Inngest.Any, options: ConnectHandlerOptions) {
    this.inngest = inngest;

    this.options = this.applyDefaults(options);

    this.messageBuffer = new MessageBuffer(inngest);
    this.debug = debug("inngest:connect");

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

    // In case the previous connection disconnected, we still need to wait for all
    // in-flight requests to complete and flush buffered messages.
    if (this.cleanupBeforeClose) {
      this.debug("Running cleanup before close");
      await this.cleanupBeforeClose();
      this.cleanupBeforeClose = undefined;
    }

    this.state = ConnectionState.CLOSED;

    this.debug("Connection closed");

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
      this.debug("Failed to flush messages, using fallback key", err);
      await this.messageBuffer.flush(hashedFallbackKey);
    }

    const capabilities: Capabilities = {
      trust_probe: "v1",
      connect: "v1",
    };

    const functions: Array<FunctionConfig> = this.options.functions.flatMap(
      (f) => f["getConfig"](new URL("wss://connect"), undefined, true)
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

    let useSigningKey = hashedSigningKey;
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
          const switchToFallback = useSigningKey === hashedSigningKey;
          if (switchToFallback) {
            this.debug("Switching to fallback signing key");
          }
          useSigningKey = switchToFallback
            ? hashedFallbackKey
            : hashedSigningKey;
        }

        const delay = expBackoff(attempt);
        this.debug("Reconnecting in", delay, "ms");
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt++;
      }
    }
  }

  private setupHeartbeat(
    ws: WebSocket,
    hashedSigningKey: string | undefined,
    onConnectionError: (error: unknown) => void
  ) {
    const currentConnId = this._connectionId;

    const cancel = setInterval(() => {
      if (currentConnId !== this._connectionId) {
        this.debug("Connection ID changed, stopping heartbeat");
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
          onConnectionError(new Error("Gateway heartbeat missed"));
          return;
        }
        const timeSinceLastHeartbeat =
          new Date().getTime() - this.lastGatewayHeartbeatAt.getTime();
        if (timeSinceLastHeartbeat > WorkerHeartbeatInterval * 2) {
          this.debug("Gateway heartbeat missed");
          onConnectionError(new Error("Gateway heartbeat missed"));
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.messageBuffer.flush(hashedSigningKey);
      }, WorkerHeartbeatInterval / 2);
    }, WorkerHeartbeatInterval);

    return () => {
      this.debug("Clearing heartbeat interval");
      clearInterval(cancel);
    };
  }

  private async prepareConnection(
    requestHandler: (msg: GatewayExecutorRequestData) => Promise<SDKResponse>,
    hashedSigningKey: string | undefined,
    data: connectionEstablishData,
    attempt: number
  ): Promise<void> {
    this.debug("Preparing connection", {
      attempt,
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
    const msg = createStartRequest(Array.from(this._excludeGateways));

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

      throw new ReconnectError(
        `Failed initial API handshake request to ${targetUrl.toString()}, ${await resp.text()}`,
        attempt
      );
    }

    const startResp = await parseStartResponse(resp);

    const connectionId = ulid();

    this._connectionId = connectionId;

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
      this._excludeGateways.add(startResp.gatewayGroup);
      rejectWebsocketConnected?.(
        new ReconnectError("Connection timed out", attempt)
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

    this.debug("Connecting to gateway", {
      endpoint: finalEndpoint,
      gatewayGroup: startResp.gatewayGroup,
    });

    const ws = new WebSocket(finalEndpoint, ["v0.connect.inngest.com"]);
    ws.binaryType = "arraybuffer";

    let errored = false;
    const onConnectionError = (error: unknown) => {
      // Only process the first error per connection
      if (errored) {
        return;
      }
      errored = true;

      // If connection is still in the connecting state, we need to reject the promise
      // and attempt to reconnect
      if (
        this.state === ConnectionState.CONNECTING ||
        this.state === ConnectionState.RECONNECTING
      ) {
        this.debug("Connection error in connecting state, rejecting promise");

        clearTimeout(connectTimeout);

        // Make sure to close the WebSocket if it's still open
        ws.close();

        rejectWebsocketConnected?.(
          new ReconnectError(
            `Error while connecting: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
            attempt
          )
        );

        return;
      }

      // Don't attempt to reconnect if we're already closing or closed
      if (
        this.state === ConnectionState.CLOSING ||
        this.state === ConnectionState.CLOSED
      ) {
        return;
      }

      this.state = ConnectionState.RECONNECTING;
      this._excludeGateways.add(startResp.gatewayGroup);

      this.debug("Connection error", error);
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.connect(attempt + 1);
    };

    ws.onerror = (err) => onConnectionError(err);
    ws.onclose = (ev) => {
      onConnectionError(
        new ReconnectError(`Connection closed: ${ev.reason}`, attempt)
      );
    };

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

      {
        if (!setupState.receivedGatewayHello) {
          if (connectMessage.kind !== GatewayMessageType.GATEWAY_HELLO) {
            this._excludeGateways.add(startResp.gatewayGroup);
            rejectWebsocketConnected?.(
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

          setupState.sentWorkerConnect = true;
          return;
        }

        if (!setupState.receivedConnectionReady) {
          if (
            connectMessage.kind !== GatewayMessageType.GATEWAY_CONNECTION_READY
          ) {
            this._excludeGateways.add(startResp.gatewayGroup);
            rejectWebsocketConnected?.(
              new ReconnectError(
                `Expected ready message, got ${gatewayMessageTypeToJSON(
                  connectMessage.kind
                )}`,
                attempt
              )
            );
            return;
          }

          setupState.receivedConnectionReady = true;
          this.state = ConnectionState.ACTIVE;
          clearTimeout(connectTimeout);
          resolveWebsocketConnected?.();
          this.currentWs = ws;
          this.debug("Connection ready");
          attempt = 0;
          this._excludeGateways.delete(startResp.gatewayGroup);

          return;
        }
      }

      if (connectMessage.kind === GatewayMessageType.GATEWAY_CLOSING) {
        try {
          // Wait for new conn to be successfully established
          await this.connect();

          await this.cleanup();

          // Close original connection once new conn is established
          ws.close();
        } catch (err) {
          this.debug("Failed to reconnect after receiving draining message");
          ws.close();
        }
        return;
      }

      if (connectMessage.kind === GatewayMessageType.GATEWAY_HEARTBEAT) {
        this.lastGatewayHeartbeatAt = new Date();
        this.debug("Handled gateway heartbeat");
        return;
      }

      if (connectMessage.kind === GatewayMessageType.GATEWAY_EXECUTOR_REQUEST) {
        if (this.state !== ConnectionState.ACTIVE) {
          this.debug("Received request while not active, skipping");
          return;
        }

        const gatewayExecutorRequest = parseGatewayExecutorRequest(
          connectMessage.payload
        );

        this.debug(
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

          this.debug("Sending worker reply");

          this.messageBuffer.addPending(res, ResponseAcknowlegeDeadline);

          if (!this.currentWs) {
            this.debug("No current WebSocket, buffering response");
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

        this.debug("Acknowledging reply ack", replyAck.requestId);

        this.messageBuffer.acknowledgePending(replyAck.requestId);

        return;
      }

      this.debug("Unexpected message type", {
        kind: gatewayMessageTypeToJSON(connectMessage.kind),
        rawKind: connectMessage.kind,
        attempt,
        setupState: setupState,
        state: this.state,
      });
    };

    await websocketConnectedPromise;

    const heartbeatCleanup = this.setupHeartbeat(
      ws,
      hashedSigningKey,
      onConnectionError
    );
    this._cleanup.push(heartbeatCleanup);

    const closeConnectionCleanup = async () => {
      const isShutdown =
        this.state === ConnectionState.CLOSING ||
        this.state === ConnectionState.CLOSED;

      if (isShutdown) {
        this.debug("Running graceful shutdown");
      }

      if (ws.readyState === WebSocket.OPEN) {
        this.debug("Sending pause message");
        ws.send(
          ConnectMessage.encode(
            ConnectMessage.create({
              kind: GatewayMessageType.WORKER_PAUSE,
            })
          ).finish()
        );
      }

      if (isShutdown) {
        this.debug("Waiting for remaining messages to be processed");

        // Wait for remaining messages to be processed
        await this.inProgressRequests.wait();

        await this.messageBuffer.flush(hashedSigningKey);
      }

      this.debug("Closing connection");
      ws.close();
    };
    this._cleanup.push(closeConnectionCleanup);
    this.cleanupBeforeClose = closeConnectionCleanup;

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
