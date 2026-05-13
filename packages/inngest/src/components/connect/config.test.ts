import { describe, expect, test, vi } from "vitest";
import { ExecutionVersion } from "../../helpers/consts.ts";
import type { Logger } from "../../middleware/logger.ts";
import { GatewayExecutorRequestData } from "../../proto/src/components/connect/protobuf/connect.ts";
import { createClient } from "../../test/helpers.ts";
import { prepareConnectionConfig } from "./config.ts";

describe("prepareConnectionConfig", () => {
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
