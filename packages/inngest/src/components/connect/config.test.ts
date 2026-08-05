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
import { extendedTracesMiddleware } from "../execution/otel/middleware.ts";
import { sdkFeatureObservations } from "../sdkFeatureObservations.ts";
import { prepareConnectionConfig } from "./config.ts";

describe("prepareConnectionConfig", () => {
  afterEach(() => {
    trace.disable();
    context.disable();
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
});
