import { envKeys, headerKeys, queryKeys } from "../../helpers/consts.ts";
import { allProcessEnv, getEnvironmentName } from "../../helpers/env.ts";
import { parseFnData } from "../../helpers/functions.ts";
import { hashSigningKey } from "../../helpers/strings.ts";
import {
  type GatewayExecutorRequestData,
  SDKResponse,
  SDKResponseStatus,
} from "../../proto/src/components/connect/protobuf/connect.ts";
import type { Capabilities } from "../../types.ts";
import { version } from "../../version.ts";
import { PREFERRED_EXECUTION_VERSION } from "../execution/InngestExecution.ts";
import type { Inngest } from "../Inngest.ts";
import { InngestCommHandler } from "../InngestCommHandler.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import {
  type ConnectHandlerOptions,
  DEFAULT_SHUTDOWN_SIGNALS,
} from "./types.ts";
import { parseTraceCtx } from "./util.ts";
import { DefaultLogger, type Logger } from "../../middleware/logger.ts";

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

type ConnectCommHandler = InngestCommHandler<
  [GatewayExecutorRequestData],
  SDKResponse,
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  any
>;

export class Base {
  protected inngest: Inngest.Any;
  protected options: ConnectHandlerOptions;
  protected logger: Logger;

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
          `All apps must be configured to the same environment. ${client.id} is configured to ${client.env} but ${this.inngest.id} is configured to ${this.inngest.env}`
        );
      }
    }

    this.options = this.applyDefaults(options);

    this._inngestEnv = this.inngest.env ?? getEnvironmentName();

    this.logger = options.logger || new DefaultLogger();
  }

  private get functions() {
    const knownApps = new Set<string>();
    return this.options.apps.map((app) => {
      const client = app.client as Inngest.Any;
      const appId = client.id;

      if (knownApps.has(appId)) {
        throw new Error(`Duplicate app id: ${appId}`);
      }

      knownApps.add(client.id);

      return {
        appId: appId,
        client: app.client,
        functions: (app.functions as InngestFunction.Any[]) ?? client.funcs,
      };
    });
  }

  private get functionConfigs() {
    return this.functions.map(({ appId, functions, client }) => {
      return {
        appId: appId,
        client: client,
        functions: functions.flatMap((f) =>
          f["getConfig"]({
            baseUrl: new URL("wss://connect"),
            appPrefix: (client as Inngest.Any).id,
            isConnect: true,
          })
        ),
      };
    });
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

  private _hashedSigningKey: string | undefined;
  private _hashedFallbackKey: string | undefined;
  protected useFallbackKey: boolean = false;

  protected get hashedSigningKey() {
    return this.useFallbackKey
      ? this._hashedFallbackKey
      : this._hashedSigningKey;
  }

  protected _inngestEnv: string | undefined;
  protected _initData: connectionEstablishData | undefined;
  protected _requestHandlers:
    | Record<string, (msg: GatewayExecutorRequestData) => Promise<SDKResponse>>
    | undefined;

  public async setup() {
    if (typeof WebSocket === "undefined") {
      throw new Error("WebSockets not supported in current environment");
    }

    if (this.inngest["mode"].isCloud && !this.options.signingKey) {
      throw new Error("Signing key is required");
    }

    this._hashedSigningKey = this.options.signingKey
      ? hashSigningKey(this.options.signingKey)
      : undefined;

    if (
      this.options.signingKey &&
      this.options.signingKey.startsWith(
        InngestBranchEnvironmentSigningKeyPrefix
      ) &&
      !this._inngestEnv
    ) {
      throw new Error(
        "Environment is required when using branch environment signing keys"
      );
    }

    if (this.options.signingKeyFallback) {
      this._hashedFallbackKey = hashSigningKey(this.options.signingKeyFallback);
    }

    this._initData = this.createInitData();

    this._requestHandlers = {};
    for (const { appId, client, functions } of this.functions) {
      this._requestHandlers[appId] = this.createRequestHandler(
        client,
        functions
      );
    }
  }

  private createInitData() {
    const capabilities: Capabilities = {
      trust_probe: "v1",
      connect: "v1",
    };

    const data: connectionEstablishData = {
      manualReadinessAck: false,

      marshaledCapabilities: JSON.stringify(capabilities),
      apps: this.functionConfigs.map(({ appId, client, functions }) => ({
        appName: appId,
        appVersion: (client as Inngest.Any).appVersion,
        functions: new TextEncoder().encode(JSON.stringify(functions)),
      })),
    };

    return data;
  }

  private createRequestHandler(
    client: Inngest.Like,
    functions: InngestFunction.Any[]
  ) {
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
                10
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
    return requestHandler;
  }
}
