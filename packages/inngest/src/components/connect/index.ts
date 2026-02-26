import debug from "debug";
import { envKeys, headerKeys, queryKeys } from "../../helpers/consts.ts";
import { allProcessEnv, getEnvironmentName } from "../../helpers/env.ts";
import { parseFnData } from "../../helpers/functions.ts";
import { hashSigningKey } from "../../helpers/strings.ts";
import {
  type GatewayExecutorRequestData,
  SDKResponse,
  SDKResponseStatus,
} from "../../proto/src/components/connect/protobuf/connect.ts";
import type { Capabilities, FunctionConfig } from "../../types.ts";
import { version } from "../../version.ts";
import { PREFERRED_ASYNC_EXECUTION_VERSION } from "../execution/InngestExecution.ts";
import { type Inngest, internalLoggerSymbol } from "../Inngest.ts";
import { InngestCommHandler } from "../InngestCommHandler.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import {
  type ConnectionEstablishData,
  type ConnectionStrategy,
  createStrategy,
  type RequestHandler,
} from "./strategies/index.ts";
import {
  type ConnectApp,
  type ConnectHandlerOptions,
  ConnectionState,
  DEFAULT_SHUTDOWN_SIGNALS,
  type WorkerConnection,
} from "./types.ts";
import { parseTraceCtx } from "./util.ts";

const InngestBranchEnvironmentSigningKeyPrefix = "signkey-branch-";

type ConnectCommHandler = InngestCommHandler<
  [GatewayExecutorRequestData],
  SDKResponse,
  // biome-ignore lint/suspicious/noExplicitAny: intentional
  any
>;

/**
 * WebSocket worker connection that implements the WorkerConnection interface.
 *
 * This class acts as a facade that delegates to a connection strategy.
 * The strategy determines how the WebSocket connection, heartbeater, and
 * lease extender are managed (same thread vs worker thread).
 */
class WebSocketWorkerConnection implements WorkerConnection {
  private inngest: Inngest.Any;
  private options: ConnectHandlerOptions;
  private strategy: ConnectionStrategy | undefined;
  private debugLog = debug("inngest:connect");

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

  get state(): ConnectionState {
    return this.strategy?.state ?? ConnectionState.CONNECTING;
  }

  get connectionId(): string {
    if (!this.strategy?.connectionId) {
      throw new Error("Connection not prepared");
    }
    return this.strategy.connectionId;
  }

  get closed(): Promise<void> {
    if (!this.strategy) {
      throw new Error("No connection established");
    }
    return this.strategy.closed;
  }

  async close(): Promise<void> {
    if (!this.strategy) {
      return;
    }
    return this.strategy.close();
  }

  /**
   * Establish a persistent connection to the gateway.
   */
  async connect(attempt = 0): Promise<void> {
    this.debugLog("Establishing connection", { attempt });

    const envName = this.inngest.env ?? getEnvironmentName();

    if (this.inngest.mode === "cloud" && !this.inngest.signingKey) {
      throw new Error("Signing key is required");
    }

    const hashedSigningKey = this.inngest.signingKey
      ? hashSigningKey(this.inngest.signingKey)
      : undefined;

    if (
      this.inngest.signingKey &&
      this.inngest.signingKey.startsWith(
        InngestBranchEnvironmentSigningKeyPrefix,
      ) &&
      !envName
    ) {
      throw new Error(
        "Environment is required when using branch environment signing keys",
      );
    }

    const hashedFallbackKey = this.inngest.signingKeyFallback
      ? hashSigningKey(this.inngest.signingKeyFallback)
      : undefined;

    // Build capabilities
    const capabilities: Capabilities = {
      trust_probe: "v1",
      connect: "v1",
    };

    // Build function configs
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

    this.debugLog("Prepared sync data", {
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

    // Build connection establish data
    const connectionData: ConnectionEstablishData = {
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

    // Build request handlers
    const requestHandlers: Record<string, RequestHandler> = {};
    for (const [appId, { client, functions }] of Object.entries(
      this.functions,
    )) {
      const inngestCommHandler: ConnectCommHandler = new InngestCommHandler({
        client: client,
        functions: functions,
        frameworkName: "connect",
        skipSignatureValidation: true,
        handler: (msg: GatewayExecutorRequestData) => {
          const asString = new TextDecoder().decode(msg.requestPayload);
          const parsed = parseFnData(
            JSON.parse(asString),
            undefined,
            this.inngest[internalLoggerSymbol],
          );

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
                    PREFERRED_ASYNC_EXECUTION_VERSION.toString(),
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

    // Create and initialize the strategy
    this.strategy = await createStrategy(
      {
        hashedSigningKey,
        hashedFallbackKey,
        envName,
        connectionData,
        requestHandlers,
        options: this.options,
        apiBaseUrl: this.inngest.apiBaseUrl,
        mode: { isDev: this.inngest.mode === "dev", isInferred: false },
      },
      this.options,
    );

    // Delegate to the strategy
    await this.strategy.connect(attempt);
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
