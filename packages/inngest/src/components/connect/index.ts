import { WaitGroup } from "@jpwilliams/waitgroup";
import debug, { type Debugger } from "debug";
import ms from "ms";
import { envKeys, headerKeys, queryKeys } from "../../helpers/consts.ts";
import {
  allProcessEnv,
  getEnvironmentName,
  getPlatformName,
} from "../../helpers/env.ts";
import { parseFnData } from "../../helpers/functions.ts";
import { hashSigningKey } from "../../helpers/strings.ts";
import {
  ConnectMessage,
  GatewayConnectionReadyData,
  type GatewayExecutorRequestData,
  GatewayMessageType,
  gatewayMessageTypeToJSON,
  SDKResponse,
  SDKResponseStatus,
  WorkerConnectRequestData,
  WorkerDisconnectReason,
  WorkerRequestAckData,
  WorkerRequestExtendLeaseAckData,
  WorkerRequestExtendLeaseData,
  workerDisconnectReasonToJSON,
} from "../../proto/src/components/connect/protobuf/connect.ts";
import type { Capabilities, FunctionConfig } from "../../types.ts";
import { version } from "../../version.ts";
import { PREFERRED_EXECUTION_VERSION } from "../execution/InngestExecution.ts";
import type { Inngest } from "../Inngest.ts";
import { InngestCommHandler } from "../InngestCommHandler.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { MessageBuffer } from "./buffer.ts";
import {
  createStartRequest,
  parseConnectMessage,
  parseGatewayExecutorRequest,
  parseStartResponse,
  parseWorkerReplyAck,
} from "./messages.ts";
import { getHostname, onShutdown, retrieveSystemAttributes } from "./os.ts";
import {
  type ConnectApp,
  type ConnectHandlerOptions,
  ConnectionState,
  DEFAULT_SHUTDOWN_SIGNALS,
  type WorkerConnection,
} from "./types.ts";
import {
  AuthError,
  ConnectionLimitError,
  expBackoff,
  parseTraceCtx,
  ReconnectError,
  waitWithCancel,
} from "./util.ts";

const ResponseAcknowlegeDeadline = 5_000;

const InngestBranchEnvironmentSigningKeyPrefix = "signkey-branch-";

interface connectionEstablishData {
  marshaledCapabilities: string;
  manualReadinessAck: boolean;
  apps: {
    appName: string;
    appVersion?: string;
    functions: Uint8Array;
  }[];
}

const ConnectWebSocketProtocol = "v0.connect.inngest.com";

type ConnectCommHandler = InngestCommHandler<
  [GatewayExecutorRequestData],
  SDKResponse,
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  any
>;

interface connection {
  id: string;
  ws: WebSocket;
  cleanup: () => void | Promise<void>;
  pendingHeartbeats: number;
}

class WebSocketWorkerConnection implements WorkerConnection {
  private inngest: Inngest.Any;
  private options: ConnectHandlerOptions;
  private debug: Debugger;

  /**
   * The current state of the connection.
   */
  public state: ConnectionState = ConnectionState.CONNECTING;

  /**
   * The current connection.
   */
  private currentConnection: connection | undefined;

  private inProgressRequests: {
    /**
     * A wait group to track in-flight requests.
     */
    wg: WaitGroup;

    requestLeases: Record<string, string>;
  } = {
    wg: new WaitGroup(),
    requestLeases: {},
  };

  /**
   * The buffer of messages to be sent to the gateway.
   */
  private messageBuffer: MessageBuffer;

  private _hashedSigningKey: string | undefined;
  private _hashedFallbackKey: string | undefined;

  private _inngestEnv: string | undefined;

  /**
   * A set of gateways to exclude from the connection.
   */
  private excludeGateways: Set<string> = new Set();

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

  constructor(options: ConnectHandlerOptions) {
    if (
      !Array.isArray(options.apps) ||
      options.apps.length === 0 ||
      !options.apps[0]
    ) {
      throw new Error("No apps provided");
    }

    this.inngest = options.apps[0].client as Inngest.Any;
    for (const app of options.apps) {
      const client = app.client as Inngest.Any;

      if (client.env !== this.inngest.env) {
        throw new Error(
          `All apps must be configured to the same environment. ${client.id} is configured to ${client.env} but ${this.inngest.id} is configured to ${this.inngest.env}`,
        );
      }
    }

    this.options = this.applyDefaults(options);

    this._inngestEnv = this.inngest.env ?? getEnvironmentName();

    this.debug = debug("inngest:connect");

    this.messageBuffer = new MessageBuffer(this.inngest);

    this.closingPromise = new Promise((resolve) => {
      this.resolveClosingPromise = resolve;
    });
  }

  private get functions(): Record<
    string,
    {
      client: Inngest.Like;
      functions: InngestFunction.Any[];
    }
  > {
    const functions: Record<
      string,
      {
        client: Inngest.Like;
        functions: InngestFunction.Any[];
      }
    > = {};
    for (const app of this.options.apps) {
      const client = app.client as Inngest.Any;

      if (functions[client.id]) {
        throw new Error(`Duplicate app id: ${client.id}`);
      }

      functions[client.id] = {
        client: app.client,
        functions: (app.functions as InngestFunction.Any[]) ?? client.funcs,
      };
    }
    return functions;
  }

  private applyDefaults(opts: ConnectHandlerOptions): ConnectHandlerOptions {
    const options = { ...opts };
    if (!Array.isArray(options.handleShutdownSignals)) {
      options.handleShutdownSignals = DEFAULT_SHUTDOWN_SIGNALS;
    }

    const env = allProcessEnv();
    options.signingKey = options.signingKey || env[envKeys.InngestSigningKey];
    options.signingKeyFallback =
      options.signingKeyFallback || env[envKeys.InngestSigningKeyFallback];

    if (options.maxWorkerConcurrency === undefined) {
      const envValue = env[envKeys.InngestConnectMaxWorkerConcurrency];
      if (envValue) {
        const parsed = Number.parseInt(envValue, 10);
        if (!Number.isNaN(parsed) && parsed > 0) {
          options.maxWorkerConcurrency = parsed;
        }
      }
    }

    return options;
  }

  async close(): Promise<void> {
    // Remove the shutdown signal handler
    if (this.cleanupShutdownSignal) {
      this.cleanupShutdownSignal();
      this.cleanupShutdownSignal = undefined;
    }

    this.state = ConnectionState.CLOSING;

    this.debug("Cleaning up connection resources");

    if (this.currentConnection) {
      await this.currentConnection.cleanup();
      this.currentConnection = undefined;
    }

    this.debug("Connection closed");

    this.debug("Waiting for in-flight requests to complete");

    await this.inProgressRequests.wg.wait();

    this.debug("Flushing messages before closing");

    try {
      await this.messageBuffer.flush(this._hashedSigningKey);
    } catch (err) {
      this.debug("Failed to flush messages, using fallback key", err);
      await this.messageBuffer.flush(this._hashedFallbackKey);
    }

    this.state = ConnectionState.CLOSED;
    this.resolveClosingPromise?.();

    this.debug("Fully closed");

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
    if (!this.currentConnection) {
      throw new Error("Connection not prepared");
    }
    return this.currentConnection.id;
  }

  /**
   * Establish a persistent connection to the gateway.
   */
  public async connect(attempt = 0, path: string[] = []) {
    if (typeof WebSocket === "undefined") {
      throw new Error("WebSockets not supported in current environment");
    }

    if (
      this.state === ConnectionState.CLOSING ||
      this.state === ConnectionState.CLOSED
    ) {
      throw new Error("Connection already closed");
    }

    this.debug("Establishing connection", { attempt });

    if (this.inngest["mode"].isCloud && !this.options.signingKey) {
      throw new Error("Signing key is required");
    }

    this._hashedSigningKey = this.options.signingKey
      ? hashSigningKey(this.options.signingKey)
      : undefined;

    if (
      this.options.signingKey &&
      this.options.signingKey.startsWith(
        InngestBranchEnvironmentSigningKeyPrefix,
      ) &&
      !this._inngestEnv
    ) {
      throw new Error(
        "Environment is required when using branch environment signing keys",
      );
    }

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

    const functionConfigs: Record<
      string,
      {
        client: Inngest.Like;
        functions: FunctionConfig[];
      }
    > = {};
    for (const [appId, { client, functions }] of Object.entries(
      this.functions,
    )) {
      functionConfigs[appId] = {
        client: client,
        functions: functions.flatMap((f) =>
          f["getConfig"]({
            baseUrl: new URL("wss://connect"),
            appPrefix: (client as Inngest.Any).id,
            isConnect: true,
          }),
        ),
      };
    }

    this.debug("Prepared sync data", {
      functionSlugs: Object.entries(functionConfigs).map(
        ([appId, { functions }]) => {
          return JSON.stringify({
            appId,
            functions: functions.map((f) => ({
              id: f.id,
              stepUrls: Object.values(f.steps).map((s) => s.runtime["url"]),
            })),
          });
        },
      ),
    });

    const data: connectionEstablishData = {
      manualReadinessAck: false,

      marshaledCapabilities: JSON.stringify(capabilities),
      apps: Object.entries(functionConfigs).map(
        ([appId, { client, functions }]) => ({
          appName: appId,
          appVersion: (client as Inngest.Any).appVersion,
          functions: new TextEncoder().encode(JSON.stringify(functions)),
        }),
      ),
    };

    const requestHandlers: Record<
      string,
      (msg: GatewayExecutorRequestData) => Promise<SDKResponse>
    > = {};
    for (const [appId, { client, functions }] of Object.entries(
      this.functions,
    )) {
      const inngestCommHandler: ConnectCommHandler = new InngestCommHandler({
        client: client,
        functions: functions,
        frameworkName: "connect",
        signingKey: this.options.signingKey,
        signingKeyFallback: this.options.signingKeyFallback,
        skipSignatureValidation: true,
        handler: (msg: GatewayExecutorRequestData) => {
          const asString = new TextDecoder().decode(msg.requestPayload);
          const parsed = parseFnData(JSON.parse(asString));

          const userTraceCtx = parseTraceCtx(msg.userTraceCtx);

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
                  return userTraceCtx?.traceParent ?? null;
                case headerKeys.TraceState.toString():
                  return userTraceCtx?.traceState ?? null;
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
                accountId: msg.accountId,
                envId: msg.envId,
                appId: msg.appId,
                status: sdkResponseStatus,
                body: new TextEncoder().encode(body),
                noRetry: headers[headerKeys.NoRetry] === "true",
                retryAfter: headers[headerKeys.RetryAfter],
                sdkVersion: `inngest-js:v${version}`,
                requestVersion: parseInt(
                  headers[headerKeys.RequestVersion] ??
                    PREFERRED_EXECUTION_VERSION.toString(),
                  10,
                ),
                systemTraceCtx: msg.systemTraceCtx,
                userTraceCtx: msg.userTraceCtx,
                runId: msg.runId,
              });
            },
            url() {
              const baseUrl = new URL("http://connect.inngest.com");

              baseUrl.searchParams.set(queryKeys.FnId, msg.functionSlug);

              if (msg.stepId) {
                baseUrl.searchParams.set(queryKeys.StepId, msg.stepId);
              }

              return baseUrl;
            },
          };
        },
      });
      const requestHandler = inngestCommHandler.createHandler();
      requestHandlers[appId] = requestHandler;
    }

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
      // Clean up any previous connection state
      // Note: Never reset the message buffer, as there may be pending/unsent messages
      {
        // Flush any pending messages
        await this.messageBuffer.flush(useSigningKey);
      }

      try {
        await this.prepareConnection(
          requestHandlers,
          useSigningKey,
          data,
          attempt,
          [...path],
        );
        return;
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
            "You have reached the maximum number of concurrent connections. Please disconnect other active workers to continue.",
          );
          // Continue reconnecting, do not throw.
        }

        const delay = expBackoff(attempt);
        this.debug("Reconnecting in", delay, "ms");

        const cancelled = await waitWithCancel(
          delay,
          () =>
            this.state === ConnectionState.CLOSING ||
            this.state === ConnectionState.CLOSED,
        );
        if (cancelled) {
          this.debug("Reconnect backoff cancelled");
          break;
        }

        attempt++;
      }
    }

    this.debug("Exiting connect loop");
  }

  private async sendStartRequest(
    hashedSigningKey: string | undefined,
    attempt: number,
  ) {
    const msg = createStartRequest(Array.from(this.excludeGateways));

    const headers: Record<string, string> = {
      "Content-Type": "application/protobuf",
      ...(hashedSigningKey
        ? { Authorization: `Bearer ${hashedSigningKey}` }
        : {}),
    };

    if (this._inngestEnv) {
      headers[headerKeys.Environment] = this._inngestEnv;
    }

    // refactor this to a more universal spot
    const targetUrl =
      await this.inngest["inngestApi"]["getTargetUrl"]("/v0/connect/start");

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
            this._inngestEnv ? ` (env: ${this._inngestEnv})` : ""
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

    const startResp = await parseStartResponse(resp);

    return startResp;
  }

  private async prepareConnection(
    requestHandlers: Record<
      string,
      (msg: GatewayExecutorRequestData) => Promise<SDKResponse>
    >,
    hashedSigningKey: string | undefined,
    data: connectionEstablishData,
    attempt: number,
    path: string[] = [],
  ): Promise<{ cleanup: () => void }> {
    let closed = false;

    this.debug("Preparing connection", {
      attempt,
      path,
    });

    const startedAt = new Date();

    const startResp = await this.sendStartRequest(hashedSigningKey, attempt);

    const connectionId = startResp.connectionId;
    path.push(connectionId);

    let resolveWebsocketConnected:
      | ((value: void | PromiseLike<void>) => void)
      | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    let rejectWebsocketConnected: ((reason?: any) => void) | undefined;
    const websocketConnectedPromise = new Promise((resolve, reject) => {
      resolveWebsocketConnected = resolve;
      rejectWebsocketConnected = reject;
    });

    const connectTimeout = setTimeout(() => {
      this.excludeGateways.add(startResp.gatewayGroup);
      rejectWebsocketConnected?.(
        new ReconnectError(`Connection ${connectionId} timed out`, attempt),
      );
    }, 10_000);

    let finalEndpoint = startResp.gatewayEndpoint;
    if (this.options.rewriteGatewayEndpoint) {
      const rewritten = this.options.rewriteGatewayEndpoint(
        startResp.gatewayEndpoint,
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

    let onConnectionError: (error: unknown) => void | Promise<void>;
    {
      onConnectionError = (error: unknown) => {
        // Only process the first error per connection
        if (closed) {
          this.debug(
            `Connection error while initializing but already in closed state, skipping`,
            {
              connectionId,
            },
          );
          return;
        }
        closed = true;

        this.debug(`Connection error in connecting state, rejecting promise`, {
          connectionId,
        });

        this.excludeGateways.add(startResp.gatewayGroup);

        clearTimeout(connectTimeout);

        // Make sure to close the WebSocket if it's still open
        ws.onerror = () => {};
        ws.onclose = () => {};
        ws.close(
          4001, // incomplete setup
          workerDisconnectReasonToJSON(WorkerDisconnectReason.UNEXPECTED),
        );

        rejectWebsocketConnected?.(
          new ReconnectError(
            `Error while connecting (${connectionId}): ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
            attempt,
          ),
        );
      };

      ws.onerror = (err) => onConnectionError(err);
      ws.onclose = (ev) => {
        void onConnectionError(
          new ReconnectError(
            `Connection ${connectionId} closed: ${ev.reason}`,
            attempt,
          ),
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

    let heartbeatIntervalMs: number | undefined;
    let extendLeaseIntervalMs: number | undefined;

    ws.onmessage = async (event) => {
      const messageBytes = new Uint8Array(event.data as ArrayBuffer);

      const connectMessage = parseConnectMessage(messageBytes);

      this.debug(
        `Received message: ${gatewayMessageTypeToJSON(connectMessage.kind)}`,
        {
          connectionId,
        },
      );

      if (!setupState.receivedGatewayHello) {
        if (connectMessage.kind !== GatewayMessageType.GATEWAY_HELLO) {
          void onConnectionError(
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
          environment: this._inngestEnv,
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
          apps: data.apps,
          capabilities: new TextEncoder().encode(data.marshaledCapabilities),
          startedAt: startedAt,
          instanceId: this.options.instanceId || (await getHostname()),
          maxWorkerConcurrency: this.options.maxWorkerConcurrency,
        });

        const workerConnectRequestMsgBytes = WorkerConnectRequestData.encode(
          workerConnectRequestMsg,
        ).finish();

        ws.send(
          ConnectMessage.encode(
            ConnectMessage.create({
              kind: GatewayMessageType.WORKER_CONNECT,
              payload: workerConnectRequestMsgBytes,
            }),
          ).finish(),
        );

        setupState.sentWorkerConnect = true;
        return;
      }

      if (!setupState.receivedConnectionReady) {
        if (
          connectMessage.kind !== GatewayMessageType.GATEWAY_CONNECTION_READY
        ) {
          void onConnectionError(
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

        // The intervals should be supplied by the gateway, but we should fall back just in case
        heartbeatIntervalMs =
          readyPayload.heartbeatInterval.length > 0
            ? ms(readyPayload.heartbeatInterval as ms.StringValue) // TODO Grim cast
            : 10_000;
        extendLeaseIntervalMs =
          readyPayload.extendLeaseInterval.length > 0
            ? ms(readyPayload.extendLeaseInterval as ms.StringValue) // TODO Grim cast
            : 5_000;

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

    clearTimeout(connectTimeout);

    this.state = ConnectionState.ACTIVE;
    this.excludeGateways.delete(startResp.gatewayGroup);

    attempt = 0;

    const conn: connection = {
      id: connectionId,
      ws,
      cleanup: () => {
        if (closed) {
          return;
        }
        closed = true;
        ws.onerror = () => {};
        ws.onclose = () => {};
        ws.close();
      },
      pendingHeartbeats: 0,
    };
    this.currentConnection = conn;

    this.debug(`Connection ready (${connectionId})`);

    // Flag to prevent connecting twice in draining scenario:
    // 1. We're already draining and repeatedly trying to connect while keeping the old connection open
    // 2. The gateway closes the old connection after a timeout, causing a connection error (which would also trigger a new connection)
    let isDraining = false;
    {
      onConnectionError = async (error: unknown) => {
        // Only process the first error per connection
        if (closed) {
          this.debug(`Connection error but already in closed state, skipping`, {
            connectionId,
          });
          return;
        }
        closed = true;

        await conn.cleanup();

        // Don't attempt to reconnect if we're already closing or closed
        if (
          this.state === ConnectionState.CLOSING ||
          this.state === ConnectionState.CLOSED
        ) {
          this.debug(
            `Connection error (${connectionId}) but already closing or closed, skipping`,
          );
          return;
        }

        this.state = ConnectionState.RECONNECTING;
        this.excludeGateways.add(startResp.gatewayGroup);

        // If this connection is draining and got closed unexpectedly, there's already a new connection being established
        if (isDraining) {
          this.debug(
            `Connection error (${connectionId}) but already draining, skipping`,
          );
          return;
        }

        this.debug(`Connection error (${connectionId})`, error);
        this.connect(attempt + 1, [...path, "onConnectionError"]);
      };

      ws.onerror = (err) => onConnectionError(err);
      ws.onclose = (ev) => {
        void onConnectionError(
          new ReconnectError(`Connection closed: ${ev.reason}`, attempt),
        );
      };
    }

    ws.onmessage = async (event) => {
      const messageBytes = new Uint8Array(event.data as ArrayBuffer);

      const connectMessage = parseConnectMessage(messageBytes);

      if (connectMessage.kind === GatewayMessageType.GATEWAY_CLOSING) {
        isDraining = true;
        this.debug("Received draining message", { connectionId });
        try {
          this.debug(
            "Setting up new connection while keeping previous connection open",
            { connectionId },
          );

          // Wait for new conn to be successfully established
          await this.connect(0, [...path]);

          // Clean up the old connection
          await conn.cleanup();
        } catch (err) {
          this.debug("Failed to reconnect after receiving draining message", {
            connectionId,
            err,
          });

          // Clean up the old connection
          await conn.cleanup();

          void onConnectionError(
            new ReconnectError(
              `Failed to reconnect after receiving draining message (${connectionId})`,
              attempt,
            ),
          );
        }
        return;
      }

      if (connectMessage.kind === GatewayMessageType.GATEWAY_HEARTBEAT) {
        conn.pendingHeartbeats = 0;
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
          connectMessage.payload,
        );

        this.debug("Received gateway executor request", {
          requestId: gatewayExecutorRequest.requestId,
          appId: gatewayExecutorRequest.appId,
          appName: gatewayExecutorRequest.appName,
          functionSlug: gatewayExecutorRequest.functionSlug,
          stepId: gatewayExecutorRequest.stepId,
          connectionId,
        });

        if (
          typeof gatewayExecutorRequest.appName !== "string" ||
          gatewayExecutorRequest.appName.length === 0
        ) {
          this.debug("No app name in request, skipping", {
            requestId: gatewayExecutorRequest.requestId,
            appId: gatewayExecutorRequest.appId,
            functionSlug: gatewayExecutorRequest.functionSlug,
            stepId: gatewayExecutorRequest.stepId,
            connectionId,
          });
          return;
        }
        const requestHandler = requestHandlers[gatewayExecutorRequest.appName];

        if (!requestHandler) {
          this.debug("No request handler found for app, skipping", {
            requestId: gatewayExecutorRequest.requestId,
            appId: gatewayExecutorRequest.appId,
            appName: gatewayExecutorRequest.appName,
            functionSlug: gatewayExecutorRequest.functionSlug,
            stepId: gatewayExecutorRequest.stepId,
            connectionId,
          });
          return;
        }

        // Ack received request
        ws.send(
          ConnectMessage.encode(
            ConnectMessage.create({
              kind: GatewayMessageType.WORKER_REQUEST_ACK,
              payload: WorkerRequestAckData.encode(
                WorkerRequestAckData.create({
                  accountId: gatewayExecutorRequest.accountId,
                  envId: gatewayExecutorRequest.envId,
                  appId: gatewayExecutorRequest.appId,
                  functionSlug: gatewayExecutorRequest.functionSlug,
                  requestId: gatewayExecutorRequest.requestId,
                  stepId: gatewayExecutorRequest.stepId,
                  userTraceCtx: gatewayExecutorRequest.userTraceCtx,
                  systemTraceCtx: gatewayExecutorRequest.systemTraceCtx,
                  runId: gatewayExecutorRequest.runId,
                }),
              ).finish(),
            }),
          ).finish(),
        );

        this.inProgressRequests.wg.add(1);
        this.inProgressRequests.requestLeases[
          gatewayExecutorRequest.requestId
        ] = gatewayExecutorRequest.leaseId;

        let extendLeaseInterval: NodeJS.Timeout | undefined;
        try {
          extendLeaseInterval = setInterval(() => {
            if (extendLeaseIntervalMs === undefined) {
              return;
            }

            // Only extend lease if it's still set on the request
            const currentLeaseId =
              this.inProgressRequests.requestLeases[
                gatewayExecutorRequest.requestId
              ];
            if (!currentLeaseId) {
              clearInterval(extendLeaseInterval);
              return;
            }

            this.debug("extending lease", {
              connectionId,
              leaseId: currentLeaseId,
            });

            // Send extend lease request
            ws.send(
              ConnectMessage.encode(
                ConnectMessage.create({
                  kind: GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
                  payload: WorkerRequestExtendLeaseData.encode(
                    WorkerRequestExtendLeaseData.create({
                      accountId: gatewayExecutorRequest.accountId,
                      envId: gatewayExecutorRequest.envId,
                      appId: gatewayExecutorRequest.appId,
                      functionSlug: gatewayExecutorRequest.functionSlug,
                      requestId: gatewayExecutorRequest.requestId,
                      stepId: gatewayExecutorRequest.stepId,
                      runId: gatewayExecutorRequest.runId,
                      userTraceCtx: gatewayExecutorRequest.userTraceCtx,
                      systemTraceCtx: gatewayExecutorRequest.systemTraceCtx,

                      leaseId: currentLeaseId,
                    }),
                  ).finish(),
                }),
              ).finish(),
            );
          }, extendLeaseIntervalMs);

          const res = await requestHandler(gatewayExecutorRequest);

          this.debug("Sending worker reply", {
            connectionId,
            requestId: gatewayExecutorRequest.requestId,
          });

          this.messageBuffer.addPending(res, ResponseAcknowlegeDeadline);

          if (!this.currentConnection) {
            this.debug("No current WebSocket, buffering response", {
              connectionId,
              requestId: gatewayExecutorRequest.requestId,
            });
            this.messageBuffer.append(res);
            return;
          }

          // Send reply back to gateway
          this.currentConnection.ws.send(
            ConnectMessage.encode(
              ConnectMessage.create({
                kind: GatewayMessageType.WORKER_REPLY,
                payload: SDKResponse.encode(res).finish(),
              }),
            ).finish(),
          );
        } finally {
          this.inProgressRequests.wg.done();
          delete this.inProgressRequests.requestLeases[
            gatewayExecutorRequest.requestId
          ];
          clearInterval(extendLeaseInterval);
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

      if (
        connectMessage.kind ===
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE_ACK
      ) {
        const extendLeaseAck = WorkerRequestExtendLeaseAckData.decode(
          connectMessage.payload,
        );

        this.debug("received extend lease ack", {
          connectionId,
          newLeaseId: extendLeaseAck.newLeaseId,
        });

        if (extendLeaseAck.newLeaseId) {
          this.inProgressRequests.requestLeases[extendLeaseAck.requestId] =
            extendLeaseAck.newLeaseId;
        } else {
          this.debug("unable to extend lease", {
            connectionId,
            requestId: extendLeaseAck.requestId,
          });
          delete this.inProgressRequests.requestLeases[
            extendLeaseAck.requestId
          ];
        }

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

    let heartbeatInterval = undefined;
    if (heartbeatIntervalMs !== undefined) {
      heartbeatInterval = setInterval(() => {
        if (heartbeatIntervalMs === undefined) {
          return;
        }

        // Check if we've missed 2 consecutive heartbeats
        if (conn.pendingHeartbeats >= 2) {
          this.debug("Gateway heartbeat missed");
          void onConnectionError(
            new ReconnectError(
              `Consecutive gateway heartbeats missed (${connectionId})`,
              attempt,
            ),
          );
          return;
        }

        this.debug("Sending worker heartbeat", {
          connectionId,
        });

        // Send worker heartbeat
        conn.pendingHeartbeats++;
        ws.send(
          ConnectMessage.encode(
            ConnectMessage.create({
              kind: GatewayMessageType.WORKER_HEARTBEAT,
            }),
          ).finish(),
        );
      }, heartbeatIntervalMs);
    }

    conn.cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;

      this.debug("Cleaning up connection", { connectionId });
      if (ws.readyState === WebSocket.OPEN) {
        this.debug("Sending pause message", { connectionId });
        ws.send(
          ConnectMessage.encode(
            ConnectMessage.create({
              kind: GatewayMessageType.WORKER_PAUSE,
            }),
          ).finish(),
        );
      }

      this.debug("Closing connection", { connectionId });
      ws.onerror = () => {};
      ws.onclose = () => {};

      this.inProgressRequests.wg.wait().then(() => {
        // We must wait for all in-flight requests to complete before closing
        // the connection and stopping the heartbeater. If we don't, then
        // Inngest Server will mark the step as failed since it lost contact
        // with the worker

        ws.close(
          1000,
          workerDisconnectReasonToJSON(WorkerDisconnectReason.WORKER_SHUTDOWN),
        );

        if (this.currentConnection?.id === connectionId) {
          this.currentConnection = undefined;
        }

        this.debug("Cleaning up worker heartbeat", {
          connectionId,
        });

        clearInterval(heartbeatInterval);
      });
    };

    return conn;
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

// Export types for convenience
export {
  DEFAULT_SHUTDOWN_SIGNALS,
  type ConnectApp,
  type ConnectHandlerOptions,
  ConnectionState,
  type WorkerConnection,
};

export const connect = async (
  options: ConnectHandlerOptions,
): Promise<WorkerConnection> => {
  if (options.apps.length === 0) {
    throw new Error("No apps provided");
  }

  const conn = new WebSocketWorkerConnection(options);

  await conn.connect();

  return conn;
};
