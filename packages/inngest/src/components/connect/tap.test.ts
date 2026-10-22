/**
 * @module
 *
 * Tests for Live Tap: settings, the handshake, and the NACK, shadow, once,
 * sticky and drain behaviour, driven through ConnectionCore against the mock
 * gateway.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GatewayMessageType,
  SDKResponse,
  SDKResponseStatus,
  WorkerConnectRequestData,
  WorkerRequestAckData,
} from "../../proto/src/components/connect/protobuf/connect.ts";
import type { FunctionConfig } from "../../types.ts";
import { prepareConnectionConfig } from "./config.ts";
import { parseGatewayExecutorRequest } from "./messages.ts";
import { processNonce } from "./os.ts";
import { ConnectionCore } from "./strategies/core/connection.ts";
import { MockGateway } from "./strategies/core/mock-gateway.ts";
import type { RequestHandler } from "./strategies/index.ts";
import { SameThreadStrategy } from "./strategies/sameThread/index.ts";
import { readTapSettings, Tap, type TapSettings } from "./tap.ts";
import type { TapOutput } from "./tapOutput.ts";
import { ConnectionState } from "./types.ts";

const baseSettings: TapSettings = {
  functions: ["test-fn"],
  once: false,
  shadow: false,
  sticky: false,
  label: "me@box",
  output: "human",
};

const sleep = (ms: number) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const waitFor = async (condition: () => boolean) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 3000) {
      throw new Error("waitFor timed out");
    }

    await sleep(10);
  }
};

const response = (
  msg: { requestId: string; runId: string },
  status: SDKResponseStatus,
  body = "",
) => {
  return SDKResponse.create({
    requestId: msg.requestId,
    runId: msg.runId,
    status,
    body: new TextEncoder().encode(body),
  });
};

describe("readTapSettings", () => {
  it("is off without INNGEST_TAP_FUNCTIONS", () => {
    expect(readTapSettings({})).toBeUndefined();
  });

  it("parses the env vars", () => {
    const settings = readTapSettings({
      INNGEST_TAP_FUNCTIONS: "a, b",
      INNGEST_TAP_FILTER: "event.data.x == 1",
      INNGEST_TAP_ONCE: "1",
      INNGEST_TAP_SHADOW: "1",
      INNGEST_TAP_STICKY: "1",
      INNGEST_TAP_LABEL: "jack",
      INNGEST_TAP_OUTPUT: "agent",
    });

    expect(settings).toEqual({
      functions: ["a", "b"],
      filter: "event.data.x == 1",
      once: true,
      shadow: true,
      sticky: true,
      label: "jack",
      output: "agent",
    });
  });

  it("detects the output mode when none is given", () => {
    const base = { INNGEST_TAP_FUNCTIONS: "a" };

    expect(readTapSettings({ ...base, CLAUDECODE: "1" })?.output).toBe("agent");
    expect(readTapSettings({ ...base, INNGEST_AGENT: "1" })?.output).toBe(
      "agent",
    );
    expect(
      readTapSettings({ ...base, INNGEST_TAP_OUTPUT: "json" })?.output,
    ).toBe("json");
  });
});

describe("function selection", () => {
  const configs = [
    { id: "app-test-fn" },
    { id: "app-other" },
  ] as FunctionConfig[];

  it("keeps the wanted functions by id or slug", () => {
    const tap = new Tap({
      settings: baseSettings,
      mode: "dev",
      baseUrl: "http://localhost:8288",
    });

    expect(tap.select("app", configs)).toEqual([{ id: "app-test-fn" }]);
    expect(() => {
      return tap.assertAllFound();
    }).not.toThrow();
  });

  it("fails when a function is missing", () => {
    const tap = new Tap({
      settings: { ...baseSettings, functions: ["nope"] },
      mode: "dev",
      baseUrl: "http://localhost:8288",
    });

    tap.select("app", configs);

    expect(() => {
      return tap.assertAllFound();
    }).toThrow(/nope/);
  });
});

describe("without tap env", () => {
  it("prepares the same connection data with no tap", async () => {
    const { createClient } = await import("../../test/helpers.ts");
    const client = createClient({ id: "app", isDev: true });
    const { connectionData, tap } = prepareConnectionConfig(
      [{ client, functions: [] }],
      client,
    );

    expect(tap).toBeUndefined();
    expect(connectionData.tap).toBeUndefined();
  });
});

describe("tap over the mock gateway", () => {
  let gateway: MockGateway;
  let lines: string[];
  let core: ConnectionCore | undefined;

  const start = async (
    settings: Partial<TapSettings>,
    handler: RequestHandler,
    exit: (code: number) => void = () => {},
  ) => {
    const tap = new Tap({
      settings: { ...baseSettings, ...settings },
      mode: "dev",
      baseUrl: "http://localhost:8288",
      write: (line) => {
        lines.push(line);
      },
      exit,
    });
    tap.select("app", [{ id: "test-fn" }] as FunctionConfig[]);

    const wrapped = tap.wrap(handler);
    let state = ConnectionState.CONNECTING;
    core = new ConnectionCore(
      {
        hashedSigningKey: "key",
        hashedFallbackKey: undefined,
        envName: "env",
        connectionData: {
          marshaledCapabilities: "",
          manualReadinessAck: false,
          apps: [],
          tap: tap.config,
        },
        apiBaseUrl: gateway.httpUrl,
        mode: "cloud",
        appIds: ["test-app"],
      },
      {
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        onStateChange: (s) => {
          state = s;
        },
        getState: () => state,
        handleExecutionRequest: async (request) => {
          return SDKResponse.encode(await wrapped(request)).finish();
        },
      },
    );
    tap.bind(() => {
      return core!.close();
    });
    await core.start();

    return tap;
  };

  const replies = () => {
    return gateway
      .getMessagesOfType(GatewayMessageType.WORKER_REPLY)
      .map((m) => {
        return SDKResponse.decode(m.payload);
      });
  };

  beforeEach(async () => {
    lines = [];
    gateway = new MockGateway({ extendLeaseInterval: "50ms" });
    await gateway.start();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await core?.close();
    await gateway.stop();
  });

  it("sends the tap config at the handshake", async () => {
    await start({ filter: "event.name == 'a'", shadow: true }, async (msg) => {
      return response(msg, SDKResponseStatus.DONE);
    });

    const connect = gateway.getMessagesOfType(
      GatewayMessageType.WORKER_CONNECT,
    );
    const data = WorkerConnectRequestData.decode(connect[0]!.payload);

    expect(data.authData?.syncToken).toBe("");
    expect(data.tap).toMatchObject({
      functions: ["test-fn"],
      filter: "event.name == 'a'",
      shadow: true,
      label: "me@box",
    });
  });

  it("ACKs then NACKs a request for another function, running nothing", async () => {
    const handler = vi.fn();
    await start({}, handler);

    gateway.sendExecutorRequest({
      requestId: "r1",
      appName: "test-app",
      functionSlug: "other",
    });
    await waitFor(() => {
      return replies().length === 1;
    });

    expect(handler).not.toHaveBeenCalled();
    expect(replies()[0]?.status).toBe(SDKResponseStatus.NACKED);
    expect(
      gateway.getMessagesOfType(GatewayMessageType.WORKER_REQUEST_ACK),
    ).toHaveLength(1);
  });

  it("shadow runs locally, extends the lease, then NACKs", async () => {
    const handler = vi.fn(async (msg) => {
      await waitFor(() => {
        return (
          gateway.getMessagesOfType(
            GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
          ).length >= 2
        );
      });

      return response(msg, SDKResponseStatus.DONE, "real result");
    });
    await start({ shadow: true }, handler);

    gateway.sendExecutorRequest({ requestId: "r1", appName: "test-app" });
    await waitFor(() => {
      return replies().length === 1;
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(replies()[0]?.status).toBe(SDKResponseStatus.NACKED);
    expect(replies()[0]?.body.length).toBe(0);
    expect(
      gateway.getMessagesOfType(GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE)
        .length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("once takes one request, NACKs the rest and closes", async () => {
    const handler = vi.fn(async (msg) => {
      await sleep(100);

      return response(msg, SDKResponseStatus.DONE);
    });
    await start({ once: true }, handler);

    gateway.sendExecutorRequest({ requestId: "r1", appName: "test-app" });
    gateway.sendExecutorRequest({
      requestId: "r2",
      appName: "test-app",
      runId: "run-2",
    });
    await waitFor(() => {
      return replies().length === 2;
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(
      replies().map((r) => {
        return r.status;
      }),
    ).toEqual([SDKResponseStatus.NACKED, SDKResponseStatus.DONE]);
    await waitFor(() => {
      return (
        gateway.getMessagesOfType(GatewayMessageType.WORKER_PAUSE).length === 1
      );
    });
  });

  it("once with sticky keeps its run, NACKs others and closes when the run ends", async () => {
    let status = SDKResponseStatus.NOT_COMPLETED;
    const handler = vi.fn(async (msg) => {
      return response(msg, status, "[]");
    });
    await start({ once: true, sticky: true }, handler);

    gateway.sendExecutorRequest({ requestId: "r1", appName: "test-app" });
    await waitFor(() => {
      return replies().length === 1;
    });
    gateway.sendExecutorRequest({
      requestId: "other",
      appName: "test-app",
      runId: "run-2",
    });
    status = SDKResponseStatus.DONE;
    gateway.sendExecutorRequest({ requestId: "r2", appName: "test-app" });
    await waitFor(() => {
      return replies().length === 3;
    });

    expect(
      replies().map((r) => {
        return [r.requestId, r.status, r.sticky];
      }),
    ).toEqual([
      ["r1", SDKResponseStatus.NOT_COMPLETED, true],
      ["other", SDKResponseStatus.NACKED, undefined],
      ["r2", SDKResponseStatus.DONE, false],
    ]);
    await waitFor(() => {
      return (
        gateway.getMessagesOfType(GatewayMessageType.WORKER_PAUSE).length === 1
      );
    });
  });

  it("sets sticky while the run continues and releases it when it ends", async () => {
    let status = SDKResponseStatus.NOT_COMPLETED;
    await start({ sticky: true }, async (msg) => {
      return response(msg, status, "[]");
    });

    gateway.sendExecutorRequest({ requestId: "r1", appName: "test-app" });
    await waitFor(() => {
      return replies().length === 1;
    });
    status = SDKResponseStatus.DONE;
    gateway.sendExecutorRequest({ requestId: "r2", appName: "test-app" });
    await waitFor(() => {
      return replies().length === 2;
    });

    expect(replies()[0]?.sticky).toBe(true);
    expect(replies()[1]?.sticky).toBe(false);
  });

  it("releases sticky when the reply carries RunComplete", async () => {
    let body = "[]";
    await start({ sticky: true }, async (msg) => {
      return response(msg, SDKResponseStatus.NOT_COMPLETED, body);
    });

    gateway.sendExecutorRequest({ requestId: "r1", appName: "test-app" });
    await waitFor(() => {
      return replies().length === 1;
    });
    body = JSON.stringify([{ op: "RunComplete", id: "x", data: 1 }]);
    gateway.sendExecutorRequest({ requestId: "r2", appName: "test-app" });
    await waitFor(() => {
      return replies().length === 2;
    });

    expect(replies()[0]?.sticky).toBe(true);
    expect(replies()[1]?.status).toBe(SDKResponseStatus.NOT_COMPLETED);
    expect(replies()[1]?.sticky).toBe(false);
  });

  it("sets the run ID on every ack and reply", async () => {
    await start({ sticky: true }, async (msg) => {
      return response(msg, SDKResponseStatus.NOT_COMPLETED, "[]");
    });

    gateway.sendExecutorRequest({
      requestId: "r1",
      appName: "test-app",
      runId: "RUN1",
    });
    gateway.sendExecutorRequest({
      requestId: "other",
      appName: "test-app",
      functionSlug: "not-wanted",
      runId: "RUN2",
    });
    await waitFor(() => {
      return replies().length === 2;
    });

    expect(
      replies()
        .map((r) => {
          return r.runId;
        })
        .sort(),
    ).toEqual(["RUN1", "RUN2"]);
    expect(
      gateway
        .getMessagesOfType(GatewayMessageType.WORKER_REQUEST_ACK)
        .map((m) => {
          return WorkerRequestAckData.decode(m.payload).runId;
        })
        .sort(),
    ).toEqual(["RUN1", "RUN2"]);
  });

  it("refuses to stick when the reply reports a missing step, and NACKs", async () => {
    await start({ sticky: true }, async (msg) => {
      return response(
        msg,
        SDKResponseStatus.NOT_COMPLETED,
        JSON.stringify([{ op: "StepNotFound", id: "x" }]),
      );
    });

    gateway.sendExecutorRequest({
      requestId: "r1",
      appName: "test-app",
      stepId: "abc",
    });
    await waitFor(() => {
      return replies().length === 1;
    });

    expect(replies()[0]?.status).toBe(SDKResponseStatus.NACKED);
    expect(replies()[0]?.sticky).toBeUndefined();
    expect(lines.join("\n")).toContain("step graph differs");
  });

  it("once with sticky closes when the step graph does not match", async () => {
    await start({ once: true, sticky: true }, async (msg) => {
      return response(
        msg,
        SDKResponseStatus.NOT_COMPLETED,
        JSON.stringify([{ op: "StepNotFound", id: "x" }]),
      );
    });

    gateway.sendExecutorRequest({ requestId: "r1", appName: "test-app" });
    await waitFor(() => {
      return (
        gateway.getMessagesOfType(GatewayMessageType.WORKER_PAUSE).length === 1
      );
    });

    expect(replies()[0]?.status).toBe(SDKResponseStatus.NACKED);
  });

  it("drain waits for held runs, releases them, and a second signal drops everything", async () => {
    const exit = vi.fn();
    const listeners: Array<[string, () => void]> = [];
    vi.spyOn(process, "on").mockImplementation(((
      signal: string,
      fn: () => void,
    ) => {
      listeners.push([signal, fn]);

      return process;
    }) as never);
    const tap = await start(
      { sticky: true },
      async (msg) => {
        return response(msg, SDKResponseStatus.NOT_COMPLETED, "[]");
      },
      exit,
    );

    gateway.sendExecutorRequest({ requestId: "r1", appName: "test-app" });
    await waitFor(() => {
      return replies().length === 1;
    });
    let drained = false;
    const draining = tap.drain().then(() => {
      drained = true;
    });
    gateway.sendExecutorRequest({
      requestId: "other",
      appName: "test-app",
      runId: "run-2",
    });
    await waitFor(() => {
      return replies().length === 2;
    });

    expect(drained).toBe(false);

    gateway.sendExecutorRequest({ requestId: "r2", appName: "test-app" });
    await waitFor(() => {
      return replies().length === 3;
    });
    await draining;

    expect(drained).toBe(true);
    expect(
      replies().map((r) => {
        return [r.requestId, r.status, r.sticky];
      }),
    ).toEqual([
      ["r1", SDKResponseStatus.NOT_COMPLETED, true],
      ["other", SDKResponseStatus.NACKED, undefined],
      ["r2", SDKResponseStatus.NOT_COMPLETED, false],
    ]);
    expect(
      gateway.getMessagesOfType(GatewayMessageType.WORKER_PAUSE),
    ).toHaveLength(0);

    for (const [signal, fn] of listeners) {
      if (signal === "SIGINT" || signal === "SIGTERM") {
        fn();
      }
    }

    expect(exit).toHaveBeenCalledWith(130);
    tap.release();
  });

  it("closing through the strategy releases held runs before WORKER_PAUSE", async () => {
    const tap = new Tap({
      settings: { ...baseSettings, sticky: true },
      mode: "dev",
      baseUrl: "http://localhost:8288",
      write: () => {},
    });
    tap.select("app", [{ id: "test-fn" }] as FunctionConfig[]);
    const strategy = new SameThreadStrategy({
      hashedSigningKey: "key",
      hashedFallbackKey: undefined,
      envName: "env",
      connectionData: {
        marshaledCapabilities: "",
        manualReadinessAck: false,
        apps: [],
        tap: tap.config,
      },
      apiBaseUrl: gateway.httpUrl,
      mode: "cloud",
      internalLogger: { debug() {}, info() {}, warn() {}, error() {} },
      requestHandlers: {
        "test-app": tap.wrap(async (msg) => {
          return response(msg, SDKResponseStatus.NOT_COMPLETED, "[]");
        }),
      },
      options: { apps: [] },
      tap,
    });
    await strategy.connect();

    gateway.sendExecutorRequest({ requestId: "r1", appName: "test-app" });
    await waitFor(() => {
      return replies().length === 1;
    });
    const closing = strategy.close();
    await sleep(50);

    expect(
      gateway.getMessagesOfType(GatewayMessageType.WORKER_PAUSE),
    ).toHaveLength(0);

    gateway.sendExecutorRequest({ requestId: "r2", appName: "test-app" });
    await closing;
    await waitFor(() => {
      return replies().length === 2;
    });

    expect(replies()[1]?.sticky).toBe(false);

    expect(
      gateway.getMessagesOfType(GatewayMessageType.WORKER_PAUSE).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("sends a distinct instance ID per tap process", async () => {
    await start({}, async (msg) => {
      return response(msg, SDKResponseStatus.DONE);
    });

    const data = WorkerConnectRequestData.decode(
      gateway.getMessagesOfType(GatewayMessageType.WORKER_CONNECT)[0]!.payload,
    );

    expect(data.instanceId).toMatch(new RegExp(`^.+-${processNonce}$`));
  });

  it("writes one JSON line per request in json mode", async () => {
    await start({ output: "json" }, async (msg) => {
      return response(msg, SDKResponseStatus.DONE);
    });

    gateway.sendExecutorRequest({
      requestId: "r1",
      appName: "test-app",
      runId: "RUN1",
    });
    await waitFor(() => {
      return lines.length === 1;
    });

    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "done",
      runId: "RUN1",
      fn: "test-fn",
      traceUrl: "http://localhost:8288/run?runID=RUN1",
    });
  });

  it("writes one human line with the trace link", async () => {
    await start({}, async (msg) => {
      return response(msg, SDKResponseStatus.DONE);
    });

    gateway.sendExecutorRequest({
      requestId: "r1",
      appName: "test-app",
      runId: "RUN1",
    });
    await waitFor(() => {
      return lines.length === 1;
    });

    expect(lines[0]).toBe(
      "tap done test-fn http://localhost:8288/run?runID=RUN1",
    );
  });
});
