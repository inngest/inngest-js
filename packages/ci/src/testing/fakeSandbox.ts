/**
 * A fake Inngest Sandboxes REST API for tests, at the `fetch` boundary so the
 * SDK's real client and durable protocol run for real.
 *
 * @module
 */

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
  /**
   * How many starts of this command answer `409 operation_ambiguous` even
   * though the process started, as Cloud sometimes does. Defaults to 0.
   */
  ambiguousStarts?: number;
  /** A captured exec of this command runs past its timeout. */
  execTimesOut?: boolean;
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
  /** Make snapshot creation fail the way Cloud does when none are left. */
  exhaustSnapshots(): void;
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
  let snapshotsExhausted = false;
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
    input: string | URL | Request,
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

        // Cloud answers an exec that runs past its timeout with a 504.
        if (script.execTimesOut) {
          return new Response(
            JSON.stringify({
              errors: [
                {
                  code: "sandbox_exec_timed_out",
                  message: "Sandbox exec timed out",
                },
              ],
            }),
            { status: 504, headers: { "Content-Type": "application/json" } },
          );
        }

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

        if (snapshotsExhausted) {
          return new Response(
            JSON.stringify({
              errors: [
                {
                  code: "sandbox_snapshot_limit_exceeded",
                  message: "Sandbox snapshot limit reached",
                },
              ],
            }),
            { status: 403, headers: { "Content-Type": "application/json" } },
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

        // Cloud sometimes answers a start that succeeded with a 409.
        if (script.ambiguousStarts && script.ambiguousStarts > 0) {
          script.ambiguousStarts--;
          return new Response(
            JSON.stringify({
              errors: [
                {
                  code: "operation_ambiguous",
                  message:
                    "Sandbox process may have started; list processes and reconcile before starting another",
                },
              ],
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        }

        return json(201, processResource(process));
      }

      if (rest === "/processes" && method === "GET") {
        const items = [...processes.values()]
          .filter((process) => process.sandboxId === sandbox.id)
          .map(processResource);
        return json(200, items, { page: { limit: 50 } });
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
          // Like Cloud, protobuf JSON omits `chunks` when there's no output.
          if (!process.stdout && !process.stderr) {
            return json(200, {});
          }

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
    exhaustSnapshots: () => {
      snapshotsExhausted = true;
    },
  };
};
