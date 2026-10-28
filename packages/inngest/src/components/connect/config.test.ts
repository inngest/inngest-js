import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { context, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ExecutionVersion } from "../../helpers/consts.ts";
import type { Logger } from "../../middleware/logger.ts";
import { GatewayExecutorRequestData } from "../../proto/src/components/connect/protobuf/connect.ts";
import {
  ExtendedTracesBehavior,
  ExtendedTracesReadinessReason,
  OTelProviderSource,
  OTelSetupFailure,
  OTelSetupPath,
  SendEventsReadinessReason,
} from "../../proto/src/components/sdkFeatureObservations/protobuf/feature_observations.ts";
import { createClient } from "../../test/helpers.ts";
import type { FunctionConfig } from "../../types.ts";
import { extendedTracesMiddleware } from "../execution/otel/middleware.ts";
import { Middleware } from "../middleware/middleware.ts";
import { sdkFeatureObservations } from "../sdkFeatureObservations.ts";
import { prepareConnectionConfig } from "./config.ts";

describe("prepareConnectionConfig", () => {
  afterEach(() => {
    trace.disable();
    context.disable();
  });

  test.each(["explicit", "automatic"])(
    "produces identical configs regardless of %s function registration order",
    (mode) => {
      const payloads = [
        ["zebra", "alpha", "alpha-0"],
        ["alpha-0", "alpha", "zebra"],
        ["alpha", "zebra", "alpha-0"],
      ].map((ids) => {
        const client = createClient({ id: "test", isDev: true });
        const functions = ids.map((id) =>
          client.createFunction(
            {
              id,
              triggers: [{ event: `demo/${id}` }],
              onFailure: () => "failed",
            },
            () => "ok",
          ),
        );
        const originalRegistry = [...client.funcs];
        const originalFunctions = [...functions];
        const { connectionData } = prepareConnectionConfig(
          [mode === "explicit" ? { client, functions } : { client }],
          client,
        );
        expect(client.funcs).toEqual(originalRegistry);
        expect(functions).toEqual(originalFunctions);
        return new TextDecoder().decode(connectionData.apps[0]?.functions);
      });

      expect(new Set(payloads).size).toBe(1);
      const configs: FunctionConfig[] = JSON.parse(payloads[0]!);
      expect(configs.map(({ id }) => id)).toEqual([
        "test-alpha",
        "test-alpha-0",
        "test-alpha-0-failure",
        "test-alpha-failure",
        "test-zebra",
        "test-zebra-failure",
      ]);
    },
  );

  test("produces identical automatic configs across fresh processes with concurrent discovery", () => {
    const require = createRequire(import.meta.url);
    const fixture = fileURLToPath(
      new URL("../../test/fixtures/connect-config.ts", import.meta.url),
    );
    const payloads = Array.from({ length: 4 }, () =>
      execFileSync(
        process.execPath,
        [
          require.resolve("tsx/cli"),
          "--eval",
          `require(${JSON.stringify(fixture)})`,
        ],
        {
          cwd: fileURLToPath(new URL("../../../", import.meta.url)),
          encoding: "utf8",
          timeout: 15_000,
          env: { ...process.env, NODE_NO_WARNINGS: "1" },
        },
      ),
    );
    expect(new Set(payloads).size).toBe(1);
    const configs: FunctionConfig[] = JSON.parse(payloads[0]!);
    expect(configs.map(({ id }) => id)).toEqual(
      Array.from({ length: 16 }, (_, i) => `test-function-${i}`).sort(),
    );
  }, 30_000);

  test("sorts middleware-provided configs together with explicit configs", () => {
    class ExtraFunctions extends Middleware.BaseMiddleware {
      readonly id = "extra-functions";

      static override functions({ client }: Middleware.FunctionsArgs) {
        return [
          client.createFunction(
            { id: "alpha", triggers: [{ event: "demo/alpha" }] },
            () => "ok",
          ),
        ];
      }
    }
    const client = createClient({
      id: "test",
      isDev: true,
      middleware: [ExtraFunctions],
    });
    const fn = client.createFunction(
      { id: "zebra", triggers: [{ event: "demo/zebra" }] },
      () => "ok",
    );
    const { connectionData } = prepareConnectionConfig(
      [{ client, functions: [fn] }],
      client,
    );
    const configs: FunctionConfig[] = JSON.parse(
      new TextDecoder().decode(connectionData.apps[0]?.functions),
    );
    expect(configs.map(({ id }) => id)).toEqual(["test-alpha", "test-zebra"]);
  });

  test("includes SDK feature observations in Connect app configuration", () => {
    const client = createClient({ id: "test", isDev: true });
    const fn = client.createFunction(
      { id: "test", triggers: [{ event: "demo/event.sent" }] },
      () => "ok",
    );

    const { connectionData } = prepareConnectionConfig(
      [{ client, functions: [fn] }],
      client,
    );

    expect(connectionData.apps[0]?.featureObservations).toEqual(
      sdkFeatureObservations.get(client),
    );
    expect(
      connectionData.apps[0]?.featureObservations.sendEvents?.readinessReason,
    ).toBe(SendEventsReadinessReason.SEND_EVENTS_READINESS_REASON_READY);
  });

  test("uses the current Extended Traces observation in Connect app configuration", () => {
    const client = createClient({
      id: "test",
      isDev: true,
      middleware: [extendedTracesMiddleware({ behaviour: "extendProvider" })],
    });
    const fn = client.createFunction(
      { id: "test", triggers: [{ event: "demo/event.sent" }] },
      () => "ok",
    );

    const { connectionData } = prepareConnectionConfig(
      [{ client, functions: [fn] }],
      client,
    );

    expect(connectionData.apps[0]?.featureObservations.extendedTraces).toEqual({
      readinessReason:
        ExtendedTracesReadinessReason.EXTENDED_TRACES_READINESS_REASON_OTEL_PROVIDER_MISSING,
      config: {
        behavior:
          ExtendedTracesBehavior.EXTENDED_TRACES_BEHAVIOR_EXTEND_PROVIDER,
      },
      otelSetup: {
        path: OTelSetupPath.OTEL_SETUP_PATH_EXTEND_EXISTING_PROVIDER,
        providerFound: false,
        providerSource: OTelProviderSource.OTEL_PROVIDER_SOURCE_UNSPECIFIED,
        addSpanProcessorAttempted: false,
        spanProcessorAdded: false,
        failure: OTelSetupFailure.OTEL_SETUP_FAILURE_NO_PROVIDER,
      },
    });
  });

  test("binds Connect proto request and job IDs to function logger context", async () => {
    const childLogger: Logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const child = vi.fn(() => childLogger);
    const logger: Logger & {
      child: (meta: Record<string, unknown>) => Logger;
    } = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      child,
    };
    const client = createClient({ id: "test", isDev: true, logger });
    let seenIds:
      | {
          requestId?: string;
          jobId?: string;
        }
      | undefined;

    const fn = client.createFunction(
      { id: "test", triggers: [{ event: "demo/event.sent" }] },
      ({ logger, requestId, jobId }) => {
        seenIds = { requestId, jobId };
        logger.info("hello from connect");
        return "ok";
      },
    );

    const { requestHandlers } = prepareConnectionConfig(
      [{ client, functions: [fn] }],
      client,
    );

    const response = await requestHandlers.test?.(
      GatewayExecutorRequestData.create({
        requestId: "connect-req-123",
        jobId: "connect-job-123",
        accountId: "account-id",
        envId: "env-id",
        appId: "app-id",
        appName: "test",
        functionId: "fn-id",
        functionSlug: "test-test",
        stepId: "step",
        requestPayload: new TextEncoder().encode(
          JSON.stringify({
            version: ExecutionVersion.V2,
            ctx: {
              fn_id: "test-test",
              run_id: "run-123",
              step_id: "step",
              attempt: 0,
              disable_immediate_execution: false,
              use_api: false,
              stack: { stack: [], current: 0 },
            },
            event: { name: "demo/event.sent", data: {} },
            events: [{ name: "demo/event.sent", data: {} }],
            steps: {},
          }),
        ),
        runId: "run-123",
        leaseId: "lease-123",
      }),
    );

    expect(response?.requestId).toBe("connect-req-123");
    expect(child).toHaveBeenCalledWith({
      runID: "run-123",
      eventName: "demo/event.sent",
      requestId: "connect-req-123",
      jobId: "connect-job-123",
    });
    expect(seenIds).toEqual({
      requestId: "connect-req-123",
      jobId: "connect-job-123",
    });
    expect(childLogger.info).toHaveBeenCalledWith("hello from connect");
  });

  test("warns and uses the client's latest function when an id was re-created", () => {
    const warn = vi.fn();
    const client = createClient({
      id: "test",
      isDev: true,
      internalLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn },
    });
    client.createFunction(
      { id: "job", triggers: [{ event: "demo/first" }] },
      () => "first",
    );
    client.createFunction(
      { id: "job", triggers: [{ event: "demo/second" }] },
      () => "second",
    );

    const { connectionData } = prepareConnectionConfig([{ client }], client);

    const fns: unknown = JSON.parse(
      new TextDecoder().decode(connectionData.apps[0]?.functions),
    );
    expect(fns).toEqual([
      expect.objectContaining({
        id: "test-job",
        triggers: [{ event: "demo/second" }],
      }),
    ]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { functionIds: ["test-job"] },
      expect.stringContaining("defined more than once"),
    );
  });

  test("does not warn about re-created ids when functions are explicit", () => {
    const warn = vi.fn();
    const client = createClient({
      id: "test",
      isDev: true,
      internalLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn },
    });
    client.createFunction(
      { id: "job", triggers: [{ event: "demo/first" }] },
      () => "first",
    );
    const second = client.createFunction(
      { id: "job", triggers: [{ event: "demo/second" }] },
      () => "second",
    );

    prepareConnectionConfig([{ client, functions: [second] }], client);

    expect(warn).not.toHaveBeenCalled();
  });

  test("does not warn about re-created ids that were spliced out of funcs", () => {
    const warn = vi.fn();
    const client = createClient({
      id: "test",
      isDev: true,
      internalLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn },
    });
    client.createFunction(
      { id: "job", triggers: [{ event: "demo/first" }] },
      () => "first",
    );
    const second = client.createFunction(
      { id: "job", triggers: [{ event: "demo/second" }] },
      () => "second",
    );
    client.funcs.splice(client.funcs.indexOf(second), 1);

    prepareConnectionConfig([{ client }], client);

    expect(warn).not.toHaveBeenCalled();
  });

  test("throws on duplicate ids in an explicit functions list", () => {
    const client = createClient({ id: "test" });
    const first = client.createFunction(
      { id: "job", triggers: [{ event: "demo/first" }] },
      () => "first",
    );
    const second = client.createFunction(
      { id: "job", triggers: [{ event: "demo/second" }] },
      () => "second",
    );

    expect(() =>
      prepareConnectionConfig([{ client, functions: [first, second] }], client),
    ).toThrow('Duplicate function ID "test-job"');
  });
});
