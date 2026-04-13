/**
 * Connection configuration preparation.
 *
 * Encapsulates signing key hashing, function config building,
 * InngestCommHandler creation, and connection data assembly — everything
 * needed before handing off to a connection strategy.
 */

import { envKeys, headerKeys, queryKeys } from "../../helpers/consts.ts";
import { allProcessEnv, getEnvironmentName } from "../../helpers/env.ts";
import { parseFnData } from "../../helpers/functions.ts";
import { hashSigningKey } from "../../helpers/strings.ts";
import {
  type GatewayExecutorRequestData,
  SDKResponse,
  SDKResponseStatus,
} from "../../proto/src/components/connect/protobuf/connect.ts";
import {
  type Capabilities,
  DefaultMaxRuntime,
  type FunctionConfig,
} from "../../types.ts";
import { version } from "../../version.ts";
import { PREFERRED_ASYNC_EXECUTION_VERSION } from "../execution/InngestExecution.ts";
import { type Inngest, internalLoggerSymbol } from "../Inngest.ts";
import { InngestCommHandler } from "../InngestCommHandler.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import type {
  ConnectionEstablishData,
  RequestHandler,
} from "./strategies/index.ts";
import type { ConnectApp } from "./types.ts";
import { parseTraceCtx } from "./util.ts";

const InngestBranchEnvironmentSigningKeyPrefix = "signkey-branch-";

type ConnectCommHandler = InngestCommHandler<
  [GatewayExecutorRequestData],
  SDKResponse,
  // biome-ignore lint/suspicious/noExplicitAny: intentional
  any
>;

export interface PreparedConnectionConfig {
  hashedSigningKey: string | undefined;
  hashedFallbackKey: string | undefined;
  envName: string | undefined;
  connectionData: ConnectionEstablishData;
  requestHandlers: Record<string, RequestHandler>;
}

/**
 * Collect per-app client + functions from ConnectApp definitions.
 */
function collectFunctions(
  apps: ConnectApp[],
): Record<string, { client: Inngest.Like; functions: InngestFunction.Any[] }> {
  const result: Record<
    string,
    { client: Inngest.Like; functions: InngestFunction.Any[] }
  > = {};

  for (const app of apps) {
    const client = app.client as Inngest.Any;
    if (result[client.id]) {
      throw new Error(`Duplicate app id: ${client.id}`);
    }
    result[client.id] = {
      client: app.client,
      functions: (app.functions as InngestFunction.Any[]) ?? client.funcs,
    };
  }

  return result;
}

/**
 * Prepare all connection configuration: signing keys, function configs,
 * connection data, and request handlers.
 */
export function prepareConnectionConfig(
  apps: ConnectApp[],
  inngest: Inngest.Any,
): PreparedConnectionConfig {
  const envName = inngest.env ?? getEnvironmentName();

  const hashedSigningKey = inngest.signingKey
    ? hashSigningKey(inngest.signingKey)
    : undefined;

  if (
    inngest.signingKey &&
    inngest.signingKey.startsWith(InngestBranchEnvironmentSigningKeyPrefix) &&
    !envName
  ) {
    throw new Error(
      "Environment is required when using branch environment signing keys",
    );
  }

  const hashedFallbackKey = inngest.signingKeyFallback
    ? hashSigningKey(inngest.signingKeyFallback)
    : undefined;

  // Build capabilities
  const capabilities: Capabilities = {
    trust_probe: "v1",
    connect: "v1",
  };

  const functions = collectFunctions(apps);

  // Build function configs
  const functionConfigs: Record<
    string,
    { client: Inngest.Like; functions: FunctionConfig[] }
  > = {};
  for (const [appId, { client, functions: fns }] of Object.entries(functions)) {
    functionConfigs[appId] = {
      client: client,
      functions: fns.flatMap((f) =>
        f["getConfig"]({
          baseUrl: new URL("wss://connect"),
          appPrefix: (client as Inngest.Any).id,
          isConnect: true,
        }),
      ),
    };
  }

  inngest[internalLoggerSymbol].debug(
    {
      functionSlugs: Object.entries(functionConfigs).map(
        ([appId, { functions: fns }]) => {
          return JSON.stringify({
            appId,
            functions: fns.map((f) => ({
              id: f.id,
              stepUrls: Object.values(f.steps).map((s) => s.runtime["url"]),
            })),
          });
        },
      ),
    },
    "Prepared sync data",
  );

  // Build connection establish data
  const connectionData: ConnectionEstablishData = {
    manualReadinessAck: true,
    marshaledCapabilities: JSON.stringify(capabilities),
    apps: Object.entries(functionConfigs).map(
      ([appId, { client, functions: fns }]) => ({
        appName: appId,
        appVersion: (client as Inngest.Any).appVersion,
        functions: new TextEncoder().encode(JSON.stringify(fns)),
      }),
    ),
  };

  // Build request handlers
  const requestHandlers: Record<string, RequestHandler> = {};
  for (const [appId, { client, functions: fns }] of Object.entries(functions)) {
    const inngestCommHandler: ConnectCommHandler = new InngestCommHandler({
      client: client,
      functions: fns,
      frameworkName: "connect",
      defaultMaxRuntime: DefaultMaxRuntime.connect,
      skipSignatureValidation: true,
      handler: (msg: GatewayExecutorRequestData) => {
        const asString = new TextDecoder().decode(msg.requestPayload);
        const parsed = parseFnData(
          JSON.parse(asString),
          undefined,
          inngest[internalLoggerSymbol],
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

    if (!inngestCommHandler.checkModeConfiguration()) {
      throw new Error("Signing key is required");
    }

    const requestHandler = inngestCommHandler.createHandler();
    requestHandlers[appId] = requestHandler;
  }

  return {
    hashedSigningKey,
    hashedFallbackKey,
    envName,
    connectionData,
    requestHandlers,
  };
}
