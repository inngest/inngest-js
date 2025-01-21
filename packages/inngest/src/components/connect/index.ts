import { ulid } from "ulid";
import { WorkerConnection, ConnectHandlerOptions } from "./types";
import {
  createStartRequest,
  parseConnectMessage,
  parseStartResponse,
} from "./messages";
import {
  ConnectMessage,
  GatewayMessageType,
  StartResponse,
  WorkerConnectRequestData,
} from "./protobuf/src/protobuf/connect";
import { hashSigningKey } from "inngest/helpers/strings";
import { Capabilities, FunctionConfig } from "inngest/types";
import { allProcessEnv, getPlatformName } from "inngest/helpers/env";
import { version } from "inngest/version";
import { Inngest } from "inngest";

interface connectionEstablishData {
  numCpuCores: number;
  totalMem: number;
  os: string;
  marshaledFunctions: string;
  marshaledCapabilities: string;
  manualReadinessAck: boolean;
}

class WebSocketWorkerConnection implements WorkerConnection {
  public _connectionId: string | undefined;

  private inngest: Inngest.Any;
  private _closed: Promise<void>;
  private resolveClosed!: (value: void | PromiseLike<void>) => void;
  private rejectClosed!: (reason?: unknown) => void;

  private options: ConnectHandlerOptions;

  constructor(inngest: Inngest.Any, options: ConnectHandlerOptions) {
    this.inngest = inngest;
    this.options = options;

    this._closed = new Promise((resolve, reject) => {
      this.resolveClosed = resolve;
      this.rejectClosed = reject;
    });
  }

  async close(): Promise<void> {
    this.resolveClosed();
    return;
  }

  get closed(): Promise<void> {
    return this._closed;
  }

  get connectionId(): string {
    if (!this._connectionId) {
      throw new Error("Connection not prepared");
    }
    return this._connectionId;
  }

  public async connect() {
    if (!this.options.baseUrl) {
      throw new Error("Base URL is required");
    }

    if (!this.inngest.apiBaseUrl) {
      throw new Error("Inngest API base URL is required");
    }

    if (!this.options.signingKey) {
      throw new Error("Signing key is required");
    }

    const hashedSigningKey = hashSigningKey(this.options.signingKey);

    let hashedFallbackKey = undefined;
    if (this.options.signingKeyFallback) {
      hashedFallbackKey = hashSigningKey(this.options.signingKeyFallback);
    }

    const capabilities: Capabilities = {
      trust_probe: "v1",
      connect: "v1",
    };

    const functions: Array<FunctionConfig> = this.options.functions.map(
      (f) => f.opts
    );

    const data: connectionEstablishData = {
      manualReadinessAck: false,
      numCpuCores: 0,
      totalMem: 0,
      os: "linux", // TODO Retrieve this
      marshaledCapabilities: JSON.stringify(capabilities),
      marshaledFunctions: JSON.stringify(functions),
    };

    const { ws, iterator } = await this.prepareConnection(
      hashedSigningKey,
      data
    );

    const cleanup: (() => void)[] = [];

    const cancel = setInterval(() => {
      const pingMsg = ConnectMessage.create({
        kind: GatewayMessageType.WORKER_HEARTBEAT,
      });
      ws.send(ConnectMessage.encode(pingMsg).finish());
    }, 10_000);

    cleanup.push(() => clearInterval(cancel));

    while (true) {
      if (this.options.abortSignal && this.options.abortSignal.aborted) {
        // TODO Handle abort closure
        break;
      }

      const next = await iterator.next();
      if (next.done || !next.value) {
        break;
      }

      const message = await parseConnectMessage(next.value);

      console.log(`Received message: ${message.kind}`);

      if (message.kind === GatewayMessageType.GATEWAY_CLOSING) {
        // TODO Handle draining
        break;
      }

      if (message.kind === GatewayMessageType.GATEWAY_EXECUTOR_REQUEST) {
        // TODO Handle executor request
        continue;
      }
    }

    return { cleanup };
  }

  private async prepareConnection(
    hashedSigningKey: string,
    data: connectionEstablishData
  ): Promise<{
    ws: WebSocket;
    iterator: AsyncIterator<Uint8Array | undefined>;
  }> {
    const startedAt = new Date();
    const msg = createStartRequest();

    const headers: Record<string, string> = {
      "Content-Type": "application/protobuf",
      Authorization: `Bearer ${hashedSigningKey}`,
    };

    if (this.inngest.env) {
      headers["X-Inngest-Env"] = this.inngest.env;
    }

    const resp = await fetch(this.inngest.apiBaseUrl!, {
      method: "POST",
      body: msg,
      headers: headers,
    });

    if (!resp.ok) {
      throw new Error("Failed to prepare connection");
    }

    const startResp = await parseStartResponse(resp);

    const connectionId = ulid();

    this._connectionId = connectionId;

    const ws = new WebSocket(startResp.gatewayEndpoint, [
      "v0.connect.inngest.com",
    ]);

    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        const stream = createMessageStream(ws);
        this.performConnectHandshake(
          connectionId,
          ws,
          startResp,
          data,
          stream,
          startedAt
        )
          .then(resolve)
          .catch(reject);
      };
    });
  }

  private async performConnectHandshake(
    connectionId: string,
    ws: WebSocket,
    startRes: StartResponse,
    data: connectionEstablishData,
    stream: AsyncIterable<Uint8Array | undefined>,
    startedAt: Date
  ) {
    const iterator = stream[Symbol.asyncIterator]();

    {
      const next = await iterator.next();
      if (next.done || !next.value) {
        throw new Error("Stream closed");
      }
      const helloMessage = await parseConnectMessage(next.value);
      if (helloMessage.kind !== GatewayMessageType.GATEWAY_HELLO) {
        throw new Error("Expected hello message");
      }
    }

    {
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
          sessionToken: startRes.sessionToken,
          syncToken: startRes.syncToken,
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
    }

    {
      const next = await iterator.next();
      if (next.done || !next.value) {
        throw new Error("Stream closed");
      }
      const readyMessage = await parseConnectMessage(next.value);
      if (readyMessage.kind !== GatewayMessageType.GATEWAY_CONNECTION_READY) {
        throw new Error("Expected ready message");
      }
    }

    return {
      ws,
      iterator,
    };
  }
}

function createMessageStream(
  socket: WebSocket
): AsyncIterable<Uint8Array | undefined> {
  return {
    [Symbol.asyncIterator]() {
      const messageQueue: Uint8Array[] = [];
      let waitingResolve:
        | ((value: IteratorResult<Uint8Array, unknown>) => void)
        | null = null;
      let done = false;

      socket.addEventListener("message", (event) => {
        const message = event.data;
        if (waitingResolve) {
          waitingResolve({ value: message, done: false });
          waitingResolve = null;
        } else {
          messageQueue.push(message);
        }
      });

      socket.addEventListener("close", () => {
        done = true;
        if (waitingResolve) {
          waitingResolve({ value: undefined, done: true });
        }
      });

      return {
        async next() {
          if (messageQueue.length > 0) {
            const message = messageQueue.shift();
            return { value: message, done: false };
          }

          if (done) {
            return { value: undefined, done: true };
          }

          return new Promise((resolve) => {
            waitingResolve = resolve;
          });
        },
      };
    },
  };
}

export const connect = async (
  inngest: Inngest.Any,
  options: ConnectHandlerOptions
): Promise<WorkerConnection> => {
  const conn = new WebSocketWorkerConnection(inngest, options);
  return conn;
};
