import { InngestCommHandler } from "inngest";
import { ulid } from "ulid";
import { headerKeys, queryKeys } from "../../helpers/consts.js";
import { allProcessEnv, getPlatformName } from "../../helpers/env.js";
import { parseFnData } from "../../helpers/functions.js";
import { hashSigningKey } from "../../helpers/strings.js";
import {
  ConnectMessage,
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
} from "./messages.js";
import { type ConnectHandlerOptions, type WorkerConnection } from "./types.js";

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

class WebSocketWorkerConnection implements WorkerConnection {
  public _connectionId: string | undefined;

  private inngest: Inngest.Any;

  private ctx: AbortController;
  private _cleanup: (() => void)[] = [];
  private inProgress: Promise<unknown>[] = [];

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
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async close(): Promise<void> {
    this.ctx.abort();
    for (const cleanup of this._cleanup) {
      cleanup();
    }
    return this.closed;
  }

  get closed(): Promise<void> {
    return Promise.allSettled(this.inProgress).then(() => {});
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

  public async connect() {
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
              body: new TextEncoder().encode(body),
              status: sdkResponseStatus,
              noRetry: headers[headerKeys.NoRetry] === "true",
              retryAfter: headers[headerKeys.RetryAfter],
              requestId: msg.requestId,
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

    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this.prepareConnection(requestHandler, hashedSigningKey, data);
        return this;
      } catch (err) {
        if (!(err instanceof ReconnectError)) {
          throw err;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, this.expBackoff(attempt))
        );
        continue;
      }
    }

    throw new Error(`Failed to connect after ${maxAttempts} attempts`);
  }

  private expBackoff(attempt: number) {
    const backoffTimes = [
      1000, 2000, 5000, 10000, 20000, 30000, 60000, 120000, 300000,
    ];
    // If attempt exceeds array length, use the last (maximum) value
    return backoffTimes[Math.min(attempt, backoffTimes.length - 1)];
  }

  private onConnectionError(error: unknown) {
    console.error("Connection error", error);
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.connect();
  }

  private setupHeartbeat(ws: WebSocket) {
    const cancel = setInterval(() => {
      const pingMsg = ConnectMessage.create({
        kind: GatewayMessageType.WORKER_HEARTBEAT,
      });
      ws.send(ConnectMessage.encode(pingMsg).finish());
    }, 10_000);
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
    ws.onclose = (ev) =>
      this.onConnectionError(new Error(`Connection closed: ${ev.reason}`));

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

          clearTimeout(connectTimeout);
          resolveWebsocketConnected?.();

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
        // TODO Handle draining
        return;
      }

      if (connectMessage.kind === GatewayMessageType.GATEWAY_HEARTBEAT) {
        // TODO Handle heartbeat
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

        const res = await requestHandler(gatewayExecutorRequest);

        console.log("Sending worker reply");

        // Send reply back to gateway
        ws.send(
          ConnectMessage.encode(
            ConnectMessage.create({
              kind: GatewayMessageType.WORKER_REPLY,
              payload: SDKResponse.encode(res).finish(),
            })
          ).finish()
        );

        return;
      }

      if (connectMessage.kind === GatewayMessageType.WORKER_REPLY_ACK) {
        // TODO Handle reply ack
        console.log("Received reply ack");
        return;
      }

      console.error("Unknown message type", connectMessage.kind);
    };

    await websocketConnectedPromise;

    this.setupHeartbeat(ws);

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
