/**
 * Test helpers for `inngest/ci`.
 *
 * Sandboxes don't run locally yet, so CI is tested against a fake sandbox REST
 * API and a fake GitHub HTTP layer. Both sit at the `fetch` boundary, so the
 * SDK's real client, validation, and durable protocol all run for real.
 */

import { ServerTiming } from "../../helpers/ServerTiming.ts";
import type { EventPayload } from "../../types.ts";
import { StepMode, StepOpCode } from "../../types.ts";
import type { InngestExecutionOptions } from "../execution/InngestExecution.ts";
import { Inngest, internalLoggerSymbol } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";

const uuid = (seed: number): string => {
  const hex = seed.toString(16).padStart(12, "0");
  return `11111111-1111-4111-8111-${hex}`;
};

const now = () => new Date().toISOString();

export interface FakeProcess {
  id: string;
  sandboxId: string;
  command: string[];
  pid: number;
  state: "RUNNING" | "EXITED" | "KILLED" | "FAILED" | "LOST";
  exitCode?: number;
  terminationSignal?: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  endedAt?: string;
  /** How many `wait`/`get` calls happen before this process exits. */
  ticksUntilExit: number;
}

export interface FakeSandbox {
  id: string;
  name: string;
  status: "RUNNING" | "PAUSED" | "TERMINATED";
  snapshotId?: string;
  vcpu: number;
  memoryMb: number;
}

export interface CommandScript {
  /** Matches when the argv joined with spaces contains this. */
  match: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** How many polls before a managed process exits. Defaults to 0. */
  ticks?: number;
}

export interface FakeSandboxApi {
  fetch: typeof fetch;
  sandboxes: Map<string, FakeSandbox>;
  processes: Map<string, FakeProcess>;
  snapshots: Map<string, { id: string; status: string; sandboxId: string }>;
  /** Every command or process argv the API was asked to run, in order. */
  commands: string[][];
  /** Every request path, in order. */
  requests: string[];
  script(scripts: CommandScript[]): void;
  /** Make snapshot creation fail the way an environment without it would. */
  disableSnapshots(): void;
}

/**
 * A fake of the sandbox REST API, served through `fetch`.
 */
export const createFakeSandboxApi = (): FakeSandboxApi => {
  const sandboxes = new Map<string, FakeSandbox>();
  const processes = new Map<string, FakeProcess>();
  const snapshots = new Map<
    string,
    { id: string; status: string; sandboxId: string }
  >();
  const commands: string[][] = [];
  const requests: string[] = [];

  let scripts: CommandScript[] = [];
  let snapshotsEnabled = true;
  let counter = 1;

  const nextId = () => uuid(counter++);

  const scriptFor = (argv: string[]): CommandScript => {
    const joined = argv.join(" ");
    return (
      scripts.find((script) => joined.includes(script.match)) ?? {
        match: "",
        exitCode: 0,
        stdout: "",
        stderr: "",
      }
    );
  };

  const json = (status: number, data: unknown, extra?: object) =>
    new Response(
      JSON.stringify({
        data,
        metadata: { fetchedAt: now() },
        ...extra,
      }),
      { status, headers: { "Content-Type": "application/json" } },
    );

  const sandboxResource = (sandbox: FakeSandbox) => ({
    id: sandbox.id,
    name: sandbox.name,
    status: sandbox.status,
    vpcId: uuid(999),
    imageRef: "default",
    resources: { vcpu: sandbox.vcpu, memoryMb: sandbox.memoryMb },
    createdAt: now(),
    startedAt: now(),
  });

  const processResource = (process: FakeProcess) => ({
    id: process.id,
    command: process.command,
    pid: process.pid,
    state: process.state,
    ...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
    ...(process.terminationSignal === undefined
      ? {}
      : { terminationSignal: process.terminationSignal }),
    startedAt: process.startedAt,
    ...(process.endedAt ? { endedAt: process.endedAt } : {}),
  });

  const snapshotResource = (snapshot: { id: string; status: string }) => ({
    id: snapshot.id,
    sourceImageId: "a".repeat(64),
    status: snapshot.status,
    compatibilityId: "fake-linux-amd64-v1",
    resources: { vcpu: 2, memoryMb: 2048 },
    memoryPackCount: 1,
    diskPackCount: 1,
    storedBytes: 1024,
    createdAt: now(),
    updatedAt: now(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });

  const tick = (process: FakeProcess) => {
    if (process.state !== "RUNNING") {
      return;
    }

    if (process.ticksUntilExit <= 0) {
      const script = scriptFor(process.command);
      process.state = "EXITED";
      process.exitCode = script.exitCode ?? 0;
      process.endedAt = now();
      return;
    }

    process.ticksUntilExit -= 1;
  };

  const fakeFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input.toString(),
      "http://sandbox.test",
    );
    const path = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push(`${method} ${path}`);

    // File uploads send bytes, so only JSON bodies are parsed.
    const isJson = String(
      (init?.headers as Record<string, string> | undefined)?.["Content-Type"] ??
        "",
    ).includes("application/json");

    const body =
      init?.body && isJson ? JSON.parse(String(init.body)) : undefined;

    // Create
    if (path === "/v2/sandboxes" && method === "POST") {
      // A name identifies an *active* sandbox; once one is terminated the
      // same name creates a new one.
      const existing = [...sandboxes.values()].find(
        (sandbox) =>
          sandbox.name === body.name && sandbox.status !== "TERMINATED",
      );

      if (existing) {
        return json(201, sandboxResource(existing));
      }

      const sandbox: FakeSandbox = {
        id: nextId(),
        name: body.name,
        status: "RUNNING",
        vcpu: body.vcpu ?? 2,
        memoryMb: body.memoryMb ?? 2048,
        ...(body.snapshotId ? { snapshotId: body.snapshotId } : {}),
      };

      sandboxes.set(sandbox.id, sandbox);
      return json(201, sandboxResource(sandbox));
    }

    // List
    if (path === "/v2/sandboxes" && method === "GET") {
      return json(200, [...sandboxes.values()].map(sandboxResource), {
        page: { hasMore: false, limit: 100 },
      });
    }

    const sandboxMatch = path.match(/^\/v2\/sandboxes\/([^/]+)(.*)$/);

    if (sandboxMatch) {
      const [, id = "", rest = ""] = sandboxMatch;
      const sandbox = sandboxes.get(id);

      if (!sandbox) {
        return json(404, null);
      }

      if (rest === "" && method === "GET") {
        return json(200, sandboxResource(sandbox));
      }

      if (rest === "" && method === "DELETE") {
        sandbox.status = "TERMINATED";
        return new Response(null, { status: 204 });
      }

      if (rest === "/exec" && method === "POST") {
        const argv = Array.isArray(body.command)
          ? body.command
          : ["/bin/sh", "-c", String(body.command)];
        commands.push(argv);

        const script = scriptFor(argv);
        return json(200, {
          encoding: "base64",
          stdout: btoa(script.stdout ?? ""),
          stderr: btoa(script.stderr ?? ""),
          exitCode: script.exitCode ?? 0,
        });
      }

      if (rest === "/pause" && method === "POST") {
        sandbox.status = "PAUSED";
        return json(200, sandboxResource(sandbox));
      }

      if (rest === "/resume" && method === "POST") {
        sandbox.status = "RUNNING";
        return json(200, sandboxResource(sandbox));
      }

      if (rest === "/snapshots" && method === "POST") {
        if (!snapshotsEnabled) {
          return new Response(
            JSON.stringify({
              errors: [
                { code: "not_implemented", message: "snapshots unsupported" },
              ],
            }),
            { status: 501, headers: { "Content-Type": "application/json" } },
          );
        }

        const snapshot = {
          id: nextId(),
          status: "READY",
          sandboxId: sandbox.id,
        };
        snapshots.set(snapshot.id, snapshot);
        return json(201, snapshotResource(snapshot));
      }

      if (rest.startsWith("/files")) {
        return json(200, {
          path: url.searchParams.get("path"),
          bytesWritten: 1,
        });
      }

      if (rest === "/processes" && method === "POST") {
        const argv = Array.isArray(body.command)
          ? body.command
          : ["/bin/sh", "-c", String(body.command)];
        commands.push(argv);

        const script = scriptFor(argv);
        const process: FakeProcess = {
          id: nextId(),
          sandboxId: sandbox.id,
          command: argv,
          pid: 42,
          state: "RUNNING",
          stdout: script.stdout ?? "",
          stderr: script.stderr ?? "",
          startedAt: now(),
          ticksUntilExit: script.ticks ?? 0,
        };

        processes.set(process.id, process);
        return json(201, processResource(process));
      }

      const processMatch = rest.match(/^\/processes\/([^/]+)(.*)$/);

      if (processMatch) {
        const [, processId = "", processRest = ""] = processMatch;
        const process = processes.get(processId);

        if (!process) {
          return json(404, null);
        }

        if (processRest === "" && method === "GET") {
          tick(process);
          return json(200, processResource(process));
        }

        if (processRest.startsWith("/wait") && method === "POST") {
          tick(process);

          if (process.state === "RUNNING") {
            return new Response(
              JSON.stringify({
                errors: [
                  {
                    code: "sandbox_process_wait_timed_out",
                    message: "wait timed out",
                  },
                ],
              }),
              { status: 408, headers: { "Content-Type": "application/json" } },
            );
          }

          return json(200, {
            id: process.id,
            state: process.state,
            ...(process.exitCode === undefined
              ? {}
              : { exitCode: process.exitCode }),
            ...(process.terminationSignal === undefined
              ? {}
              : { terminationSignal: process.terminationSignal }),
          });
        }

        if (processRest.startsWith("/output") && method === "GET") {
          return json(200, {
            chunks: [
              ...(process.stdout
                ? [
                    {
                      stream: "STDOUT",
                      data: btoa(process.stdout),
                      encoding: "base64",
                      at: now(),
                    },
                  ]
                : []),
              ...(process.stderr
                ? [
                    {
                      stream: "STDERR",
                      data: btoa(process.stderr),
                      encoding: "base64",
                      at: now(),
                    },
                  ]
                : []),
            ],
          });
        }

        if (processRest === "/signals" && method === "POST") {
          process.state = "KILLED";
          process.terminationSignal = body?.signal ?? 15;
          process.endedAt = now();
          return new Response(null, { status: 204 });
        }
      }
    }

    const snapshotMatch = path.match(/^\/v2\/snapshots\/([^/]+)$/);

    if (snapshotMatch) {
      const snapshot = snapshots.get(snapshotMatch[1] ?? "");

      if (!snapshot) {
        return new Response(
          JSON.stringify({
            errors: [
              {
                code: "sandbox_snapshot_not_found",
                message: "snapshot not found",
              },
            ],
          }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      if (method === "DELETE") {
        snapshots.delete(snapshot.id);
        return new Response(null, { status: 204 });
      }

      return json(200, snapshotResource(snapshot));
    }

    return json(404, null);
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    sandboxes,
    processes,
    snapshots,
    commands,
    requests,
    script: (next) => {
      scripts = next;
    },
    disableSnapshots: () => {
      snapshotsEnabled = false;
    },
  };
};

export interface FakeGitHubRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface FakeGitHub {
  fetch: typeof fetch;
  requests: FakeGitHubRequest[];
  /** Reply to `METHOD /path` with this body. Paths may end in `*`. */
  route(pattern: string, body: unknown, status?: number): void;
}

/**
 * A fake GitHub HTTP layer that records every request.
 */
export const createFakeGitHub = (): FakeGitHub => {
  const requests: FakeGitHubRequest[] = [];
  const routes: Array<{ pattern: string; body: unknown; status: number }> = [];

  const fakeFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}`;

    requests.push({
      method,
      path: url.pathname,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });

    const route = routes.find(({ pattern }) =>
      pattern.endsWith("*")
        ? key.startsWith(pattern.slice(0, -1))
        : pattern === key,
    );

    return new Response(JSON.stringify(route?.body ?? {}), {
      status: route?.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    requests,
    route: (pattern, body, status = 200) => {
      routes.unshift({ pattern, body, status });
    },
  };
};

/**
 * An Inngest client whose sandbox calls hit the fake sandbox API.
 */
export const createCiTestClient = (
  sandboxApi: FakeSandboxApi,
  id = "ci-test",
): Inngest.Any =>
  new Inngest({
    id,
    isDev: true,
    eventKey: "test-key",
    // The sandbox client signs its requests, so it needs a key even in dev.
    signingKey: "signkey-test-12345",
    fetch: sandboxApi.fetch,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
  });

export interface RunResult {
  type: string;
  data?: unknown;
  error?: unknown;
  /**
   * Step names in the order they completed. The executor hashes IDs, so these
   * are the display names CI gave each step.
   */
  stepIds: string[];
  /** Step data keyed by display name. */
  steps: Record<string, unknown>;
}

/**
 * Drive a function to completion the way the executor would: run whatever
 * step it plans, feed the result back, and go again.
 */
export const runFunction = async (
  fn: InngestFunction.Any,
  opts: {
    event?: EventPayload;
    maxRequests?: number;
    /**
     * What a sleep or wait resolves to. Defaults to `null`, which is what a
     * `waitForEvent` timeout looks like.
     */
    resolveWait?: (step: { id: string; displayName?: string }) => unknown;
    /** How many times a retriable step failure is retried. Defaults to 4. */
    stepAttempts?: number;
  } = {},
): Promise<RunResult> => {
  const stepState: InngestExecutionOptions["stepState"] = {};
  const stepOrder: string[] = [];
  const names: string[] = [];
  const steps: Record<string, unknown> = {};
  const maxRequests = opts.maxRequests ?? 200;

  type RanStep = {
    id: string;
    op?: string;
    displayName?: string;
    name?: string;
    data?: unknown;
    error?: unknown;
  };

  const attempts = new Map<string, number>();
  const maxAttempts = opts.stepAttempts ?? 4;

  /**
   * The executor retries a step that failed retriably, and only writes the
   * error into state once the attempts run out. Without this, a step that
   * fails once — a flaky command, an SDK call with a bad first response —
   * would look permanently broken.
   */
  const shouldRetry = (step: RanStep, retriable: unknown): boolean => {
    const failed =
      step.op === StepOpCode.StepError || step.op === StepOpCode.StepFailed;

    if (!failed || retriable === false) {
      return false;
    }

    const seen = (attempts.get(step.id) ?? 0) + 1;
    attempts.set(step.id, seen);

    return seen < maxAttempts;
  };

  const record = (step: RanStep) => {
    // A failed step reports its error in both `data` and `error`; the executor
    // only keeps the error, and replaying with both would resolve the step
    // with the serialized error instead of throwing it.
    const failed =
      step.op === StepOpCode.StepError || step.op === StepOpCode.StepFailed;

    stepState[step.id] = {
      id: step.id,
      ...(failed || step.data === undefined ? {} : { data: step.data }),
      ...(step.error === undefined ? {} : { error: step.error }),
    };
    stepOrder.push(step.id);

    const label = step.displayName ?? step.name ?? step.id;
    names.push(label);
    steps[label] = step.data;
  };

  for (let request = 0; request < maxRequests; request++) {
    const result = await runOnce(fn, stepState, stepOrder, opts.event);

    if (result.type === "function-resolved") {
      return {
        type: result.type,
        data: (result as { data: unknown }).data,
        stepIds: [...names],
        steps,
      };
    }

    if (result.type === "function-rejected") {
      return {
        type: result.type,
        error: (result as { error: unknown }).error,
        stepIds: [...names],
        steps,
      };
    }

    if (result.type === "step-ran") {
      const ranStep = (result as { step: RanStep; retriable?: unknown }).step;

      if (shouldRetry(ranStep, (result as { retriable?: unknown }).retriable)) {
        continue;
      }

      record(ranStep);
      continue;
    }

    if (result.type === "steps-found") {
      const planned = (result as { steps: (RanStep & { op?: string })[] })
        .steps;

      for (const plannedStep of planned) {
        // Only `step.run` steps are asked to run. Everything else — sleeps,
        // waits — is fulfilled by the executor writing state, so the harness
        // does the same.
        if (plannedStep.op && plannedStep.op !== StepOpCode.StepPlanned) {
          record({
            id: plannedStep.id,
            ...(plannedStep.displayName === undefined
              ? {}
              : { displayName: plannedStep.displayName }),
            data: opts.resolveWait
              ? opts.resolveWait(plannedStep)
              : (null as unknown),
          });
          continue;
        }

        const ran = await runOnce(
          fn,
          stepState,
          stepOrder,
          opts.event,
          plannedStep.id,
        );

        if (ran.type !== "step-ran") {
          continue;
        }

        const ranStep = (ran as { step: RanStep }).step;

        if (shouldRetry(ranStep, (ran as { retriable?: unknown }).retriable)) {
          continue;
        }

        record(ranStep);
      }

      continue;
    }

    throw new Error(`Unexpected execution result: ${result.type}`);
  }

  throw new Error(`Function did not settle within ${maxRequests} requests`);
};

const runOnce = async (
  fn: InngestFunction.Any,
  stepState: InngestExecutionOptions["stepState"],
  stepOrder: string[],
  event?: EventPayload,
  runStep?: string,
) => {
  // biome-ignore lint/suspicious/noExplicitAny: reaching into the SDK's internals like the other tests do
  const anyFn = fn as any;
  const client = anyFn["client"];

  // `serve()` appends function-level middleware to the client's once it knows
  // which function is running. Executions created directly don't, so this does
  // the same thing to keep `step.sandbox` available.
  const middlewareInstances = [
    ...client.middleware,
    ...(anyFn.opts?.middleware ?? []),
    // biome-ignore lint/suspicious/noExplicitAny: middleware constructors
  ].map((Cls: any) => new Cls({ client }));

  const execution = anyFn["createExecution"]({
    partialOptions: {
      client,
      data: {
        event: event ?? { name: "test/event", data: {} },
        events: [event ?? { name: "test/event", data: {} }],
        runId: "01TESTRUN",
        attempt: 0,
      },
      runId: "01TESTRUN",
      stepState,
      stepCompletionOrder: stepOrder,
      handlerKind: "main",
      requestedRunStep: runStep,
      timer: new ServerTiming(anyFn["client"][internalLoggerSymbol]),
      disableImmediateExecution: true,
      reqArgs: [],
      headers: {},
      stepMode: StepMode.Async,
      queueItemId: "fake-queue-item-id",
      middlewareInstances,
    },
  });

  const { ctx: _ctx, ops: _ops, ...rest } = await execution.start();
  return rest;
};
