/**
 * A fake Inngest Sandboxes REST API for tests, at the `fetch` boundary so the
 * SDK's real client and durable protocol run for real. Requests are matched
 * against a route table; each route is a small handler over the fake's state.
 *
 * @module
 */

const uuid = (seed: number): string => {
  const hex = seed.toString(16).padStart(12, "0");

  return `11111111-1111-4111-8111-${hex}`;
};

const now = (): string => {
  return new Date().toISOString();
};

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
  /** What it wrote, in order, when a script said so. */
  chunks?: Array<{ stream: "STDOUT" | "STDERR"; text: string }>;
  startedAt: string;
  endedAt?: string;
  /** How many `wait` calls time out before this process exits. */
  ticksUntilExit: number;
  /** The exit code the command was answered with, when answered by `respond`. */
  plannedExit?: number;
}

export interface FakeSandbox {
  id: string;
  name: string;
  status: "STARTING" | "RUNNING" | "PAUSED" | "TERMINATED";
  snapshotId?: string;
  /** Set on a sandbox whose start failed, which the create call reported. */
  stuck?: boolean;
  vcpu: number;
  memoryMb: number;
  /** The environment it was created with. */
  environment?: Record<string, string>;
}

export interface FakeSnapshot {
  id: string;
  /** The name it was created with, if any. */
  name?: string;
  status: string;
  sandboxId: string;
  createdAt: string;
  expiresAt: string;
  /** How many reads a `CREATING` snapshot answers before it is `READY`. */
  readyAfterGets?: number;
}

export interface CommandScript {
  /** Matches when the argv joined with spaces contains this. */
  match: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** What a managed process writes, in order, in place of `stdout` and `stderr`. */
  chunks?: Array<{ stream: "STDOUT" | "STDERR"; text: string }>;
  /** Files the command leaves on the machine, by path. */
  writes?: Record<string, string>;
  /** How many waits time out before a managed process exits. Defaults to 0. */
  ticks?: number;
  /**
   * How many starts of this command answer `409 operation_ambiguous` even
   * though the process started, as Cloud sometimes does. Defaults to 0.
   */
  ambiguousStarts?: number;
  /** A captured exec of this command runs past its timeout. */
  execTimesOut?: boolean;
  /**
   * Answers the command itself, given the command exactly as the API got it
   * (a job's shell session wraps it in a script) and where it was asked to
   * run. A test can run it for real.
   */
  respond?: (request: {
    command: string[];
    cwd?: string;
    environment?: Record<string, string>;
  }) => { stdout?: string; stderr?: string; exitCode?: number };
}

export interface FakeSandboxApi {
  fetch: typeof fetch;
  sandboxes: Map<string, FakeSandbox>;
  processes: Map<string, FakeProcess>;
  snapshots: Map<string, FakeSnapshot>;
  /** Every command or process argv the API was asked to run, in order. */
  commands: string[][];
  /**
   * Commands asked of machines and snapshots taken of them, in order, as
   * `command <argv>` and `snapshot <machine name>`.
   */
  timeline: string[];
  /** Every request path, in order. */
  requests: string[];
  /** The query of every listing of snapshots that is not by name. */
  fullSnapshotListings: string[];
  script(scripts: CommandScript[]): void;
  /** Make snapshot creation fail the way an environment without it would. */
  disableSnapshots(): void;
  /** Make snapshot creation fail the way Cloud does when none are left. */
  exhaustSnapshots(): void;
  /**
   * Make a sandbox created from any snapshot that exists now fail to start
   * for good, as a broken one does: the machine goes `FAILED`, which the
   * create reports as `sandbox_start_failed`. Snapshots taken afterwards
   * start normally.
   */
  failSnapshotStarts(): void;
  /**
   * Like `failSnapshotStarts`, but the machine never reaches `RUNNING` in
   * time and stays stuck `STARTING`, which the create reports as
   * `sandbox_start_timed_out`.
   */
  timeoutSnapshotStarts(): void;
  /** Make a sandbox created from any snapshot, even one taken later, never start. */
  failAllSnapshotStarts(): void;
  /**
   * Make the next starts from a snapshot fail one way, then start normally:
   * `timeout` is `sandbox_start_timed_out`, `failed` is
   * `sandbox_start_failed`, `launch` is a `sandbox_start_failed` the platform
   * blames on its own launch, and `capacity` is a retryable
   * `compute_unavailable` (503) that leaves no machine behind.
   */
  failNextSnapshotStarts(
    mode: StartFault,
    options?: {
      /** How many starts fail. Defaults to 1. */
      count?: number;
      /**
       * What becomes of the snapshot when the first of them fails, as when it
       * is deleted, or is being taken again, by the time anything looks.
       */
      then?: "gone" | "CREATING" | "DELETING";
    },
  ): void;
  /** Make deleting any snapshot that exists now fail the way Cloud refuses some: `409`. */
  refuseSnapshotDeletes(): void;
  /** The snapshot of every sandbox create that asked for one, in order. */
  snapshotStarts: string[];
  /**
   * Behave like a server without snapshot names, as Cloud is today: a create
   * with a name is refused as a bad request, and a list ignores `name` and
   * gives snapshots without one.
   */
  withoutSnapshotNames(): void;
  /**
   * Have another builder win every named snapshot create: just before it, a
   * snapshot with the same name and the same files appears, still `CREATING`,
   * and the create is refused because the name is taken.
   */
  loseSnapshotNameRaces(): void;
}

/** How a start from a snapshot can fail. */
export type StartFault = "timeout" | "failed" | "launch" | "capacity";

// biome-ignore lint/suspicious/noExplicitAny: request bodies are untyped JSON
type Body = any;

/** What a route handler sees: the parsed request and its path captures. */
interface Req {
  url: URL;
  body: Body;
  /** The body of a file upload. */
  upload?: string;
  /** Named captures from the route's path pattern. */
  params: Record<string, string>;
}

type Handler = (req: Req) => Response;

interface Route {
  method: string;
  path: RegExp;
  handler: Handler;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

const json = (status: number, data: unknown, extra?: object): Response => {
  return new Response(
    JSON.stringify({ data, metadata: { fetchedAt: now() }, ...extra }),
    { status, headers: JSON_HEADERS },
  );
};

const apiError = (status: number, code: string, message: string): Response => {
  return new Response(JSON.stringify({ errors: [{ code, message }] }), {
    status,
    headers: JSON_HEADERS,
  });
};

const noContent = (): Response => {
  return new Response(null, { status: 204 });
};

/**
 * A command a job's shell session wrapped in its report script, as it was
 * written: the script after the trap line, which is an argv when every word is
 * single-quoted (what `$` makes) and a shell script otherwise (`$.sh`).
 */
const unwrapSession = (argv: string[]): string[] => {
  const [shell, flag, script] = argv;

  if (argv.length !== 3 || shell !== "/bin/sh" || flag !== "-c") {
    return argv;
  }

  const lines = (script ?? "").split("\n");
  const trap = lines.findIndex((line) => {
    return (
      line.startsWith("trap '__rc=$?; ") && line.includes("__INGEST_SHELL_")
    );
  });

  if (trap === -1) {
    return argv;
  }

  const text = lines.slice(trap + 1).join("\n");
  const quoted = /^'(?:[^']|'\\'')*'(?: '(?:[^']|'\\'')*')*$/;

  if (!quoted.test(text)) {
    return ["/bin/sh", "-c", text];
  }

  return [...text.matchAll(/'((?:[^']|'\\'')*)'/g)].map((word) => {
    return (word[1] ?? "").split("'\\''").join("'");
  });
};

const toArgv = (command: unknown): string[] => {
  return unwrapSession(
    Array.isArray(command) ? command : ["/bin/sh", "-c", String(command)],
  );
};

const sandboxResource = (sandbox: FakeSandbox) => {
  return {
    id: sandbox.id,
    name: sandbox.name,
    status: sandbox.status,
    vpcId: uuid(999),
    imageRef: "default",
    resources: { vcpu: sandbox.vcpu, memoryMb: sandbox.memoryMb },
    createdAt: now(),
    startedAt: now(),
  };
};

/** The exit fields, which Cloud omits until the process has ended. */
const exitFields = (process: FakeProcess) => {
  return {
    ...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
    ...(process.terminationSignal === undefined
      ? {}
      : { terminationSignal: process.terminationSignal }),
  };
};

const processResource = (process: FakeProcess) => {
  return {
    id: process.id,
    command: process.command,
    pid: process.pid,
    state: process.state,
    ...exitFields(process),
    startedAt: process.startedAt,
    ...(process.endedAt ? { endedAt: process.endedAt } : {}),
  };
};

const snapshotResource = (snapshot: FakeSnapshot) => {
  return {
    id: snapshot.id,
    ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
    sourceImageId: "a".repeat(64),
    status: snapshot.status,
    compatibilityId: "fake-linux-amd64-v1",
    resources: { vcpu: 2, memoryMb: 2048 },
    memoryPackCount: 1,
    diskPackCount: 1,
    storedBytes: 1024,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.createdAt,
    expiresAt: snapshot.expiresAt,
  };
};

/**
 * Whether a snapshot holds its name: while it is being created, or while it is
 * ready and not yet expired.
 */
const holdsName = (snapshot: FakeSnapshot): boolean => {
  return (
    snapshot.status === "CREATING" ||
    (snapshot.status === "READY" && Date.parse(snapshot.expiresAt) > Date.now())
  );
};

/**
 * A fake of the sandbox REST API, served through `fetch`.
 */
export const createFakeSandboxApi = (): FakeSandboxApi => {
  const sandboxes = new Map<string, FakeSandbox>();
  const processes = new Map<string, FakeProcess>();
  const snapshots = new Map<string, FakeSnapshot>();
  const commands: string[][] = [];
  const timeline: string[] = [];
  const requests: string[] = [];
  /** The listings of every snapshot, which have no name to look for. */
  const fullSnapshotListings: string[] = [];

  let scripts: CommandScript[] = [];
  let snapshotsEnabled = true;
  let snapshotsExhausted = false;
  let snapshotNames = true;
  let loseNameRaces = false;
  let counter = 1;

  const nextId = (): string => {
    return uuid(counter++);
  };

  const scriptFor = (argv: string[]): CommandScript => {
    const joined = unwrapSession(argv).join(" ");

    return (
      scripts.find((script) => {
        return joined.includes(script.match);
      }) ?? { match: "" }
    );
  };

  const answered = (
    script: CommandScript,
    body: Record<string, unknown>,
  ): CommandScript => {
    if (!script.respond) {
      return script;
    }

    return {
      ...script,
      ...script.respond({
        command: Array.isArray(body.command)
          ? (body.command as string[])
          : ["/bin/sh", "-c", String(body.command)],
        cwd: body.cwd as string | undefined,
        environment: body.environment as Record<string, string> | undefined,
      }),
    };
  };

  /** Advance a running process one wait, exiting it once its ticks run out. */
  const tick = (process: FakeProcess): void => {
    if (process.state !== "RUNNING") {
      return;
    }

    if (process.ticksUntilExit <= 0) {
      process.state = "EXITED";

      process.exitCode =
        process.plannedExit ?? scriptFor(process.command).exitCode ?? 0;

      process.endedAt = now();

      return;
    }

    process.ticksUntilExit -= 1;
  };

  /** The files on each sandbox, and in each snapshot of one, by path. */
  const files = new Map<string, Map<string, string>>();

  /** Wrap a handler that needs the sandbox named in the path. */
  const onSandbox = (
    handler: (req: Req, sandbox: FakeSandbox) => Response,
  ): Handler => {
    return (req) => {
      const sandbox = sandboxes.get(req.params.id ?? "");

      return sandbox ? handler(req, sandbox) : json(404, null);
    };
  };

  /** Wrap a handler that needs the sandbox and the process named in the path. */
  const onProcess = (
    handler: (req: Req, process: FakeProcess) => Response,
  ): Handler => {
    return onSandbox((req) => {
      const process = processes.get(req.params.processId ?? "");

      return process ? handler(req, process) : json(404, null);
    });
  };

  interface Fault {
    mode: StartFault;
    then?: "gone" | "CREATING" | "DELETING";
  }

  /** Snapshots whose starts fail for good, and how. */
  const failingSnapshots = new Map<string, StartFault>();
  let failingAllSnapshots: StartFault | undefined;
  const queuedFaults: Fault[] = [];
  const undeletable = new Set<string>();
  const snapshotStarts: string[] = [];

  /** The fault the next start from this snapshot meets, if any. */
  const startFaultFor = (snapshotId: string): Fault | undefined => {
    const queued = queuedFaults.shift();

    if (queued) {
      return queued;
    }

    const mode = failingAllSnapshots ?? failingSnapshots.get(snapshotId);

    return mode ? { mode } : undefined;
  };

  const createSandbox: Handler = ({ body }) => {
    if (body.snapshotId) {
      snapshotStarts.push(body.snapshotId);
    }

    // A name identifies an *active* sandbox; once one is terminated the same
    // name creates a new one. Creating it again with the same configuration
    // gives the existing sandbox back, which is what makes a retried create
    // safe, and a different configuration is refused.
    const active = [...sandboxes.values()].find((sandbox) => {
      return sandbox.name === body.name && sandbox.status !== "TERMINATED";
    });

    if (active) {
      const same =
        active.vcpu === (body.vcpu ?? 2) &&
        active.memoryMb === (body.memoryMb ?? 2048) &&
        active.snapshotId === body.snapshotId &&
        JSON.stringify(active.environment ?? {}) ===
          JSON.stringify(body.environment ?? {});

      return same
        ? json(200, sandboxResource(active))
        : apiError(409, "sandbox_name_taken", "Sandbox name is already in use");
    }

    const fault = body.snapshotId ? startFaultFor(body.snapshotId) : undefined;

    if (fault) {
      const snapshot = snapshots.get(body.snapshotId);

      if (snapshot && fault.then === "gone") {
        snapshots.delete(snapshot.id);
      } else if (snapshot && fault.then) {
        snapshot.status = fault.then;
      }

      if (fault.mode === "capacity") {
        return apiError(
          503,
          "compute_unavailable",
          "Sandbox did not reach RUNNING: no capacity to start it right now",
        );
      }

      // As on the real API, the sandbox exists and keeps its name though the
      // create call fails: stuck in STARTING if it timed out, and ended if it
      // failed.
      const failed: FakeSandbox = {
        id: nextId(),
        name: body.name,
        status: fault.mode === "timeout" ? "STARTING" : "TERMINATED",
        vcpu: body.vcpu ?? 2,
        memoryMb: body.memoryMb ?? 2048,
        snapshotId: body.snapshotId,
        stuck: true,
      };

      sandboxes.set(failed.id, failed);

      return fault.mode === "timeout"
        ? apiError(
            504,
            "sandbox_start_timed_out",
            "Sandbox did not reach RUNNING within 120000 milliseconds",
          )
        : apiError(
            422,
            "sandbox_start_failed",
            fault.mode === "launch"
              ? "Sandbox entered FAILED before reaching RUNNING: sandbox launch failed"
              : "Sandbox entered FAILED before reaching RUNNING",
          );
    }

    const sandbox: FakeSandbox = {
      id: nextId(),
      name: body.name,
      status: "RUNNING",
      vcpu: body.vcpu ?? 2,
      memoryMb: body.memoryMb ?? 2048,
      ...(body.snapshotId ? { snapshotId: body.snapshotId } : {}),
      ...(body.environment ? { environment: body.environment } : {}),
    };

    sandboxes.set(sandbox.id, sandbox);

    files.set(sandbox.id, new Map(files.get(body.snapshotId)));

    return json(201, sandboxResource(sandbox));
  };

  /** Put the files a scripted command writes on the machine. */
  const leaveFiles = (sandbox: FakeSandbox, script: CommandScript) => {
    for (const [path, content] of Object.entries(script.writes ?? {})) {
      files.get(sandbox.id)?.set(path, content);
    }
  };

  const execInSandbox: Handler = onSandbox(({ body }, sandbox) => {
    const argv = toArgv(body.command);

    commands.push(argv);
    timeline.push(`command ${argv.join(" ")}`);

    const script = answered(scriptFor(argv), body);

    leaveFiles(sandbox, script);

    // Cloud answers an exec that runs past its timeout with a 504.
    if (script.execTimesOut) {
      return apiError(504, "sandbox_exec_timed_out", "Sandbox exec timed out");
    }

    // A shell isn't run, but a `cat` of a file the sandbox has prints it.
    const cats = [...(files.get(sandbox.id) ?? [])]
      .filter(([path]) => {
        return argv.join(" ").includes(`cat ${path}`);
      })
      .map(([, content]) => {
        return content;
      });

    return json(200, {
      encoding: "base64",
      stdout: btoa((script.stdout ?? "") + cats.join("")),
      stderr: btoa(script.stderr ?? ""),
      exitCode: script.exitCode ?? 0,
    });
  });

  const newSnapshot = (
    sandbox: FakeSandbox,
    fields: { name?: string; status?: string } = {},
  ): FakeSnapshot => {
    const snapshot: FakeSnapshot = {
      id: nextId(),
      ...(fields.name === undefined ? {} : { name: fields.name }),
      status: fields.status ?? "READY",
      sandboxId: sandbox.id,
      createdAt: now(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };

    snapshots.set(snapshot.id, snapshot);
    files.set(snapshot.id, new Map(files.get(sandbox.id)));
    timeline.push(`snapshot ${sandbox.name}`);

    return snapshot;
  };

  const nameIsHeld = (name: string): boolean => {
    return [...snapshots.values()].some((snapshot) => {
      return snapshot.name === name && holdsName(snapshot);
    });
  };

  const createSnapshot: Handler = onSandbox(({ body }, sandbox) => {
    if (!snapshotsEnabled) {
      return apiError(501, "not_implemented", "snapshots unsupported");
    }

    if (snapshotsExhausted) {
      return apiError(
        403,
        "sandbox_snapshot_limit_exceeded",
        "Sandbox snapshot limit reached",
      );
    }

    const name: string | undefined = body?.name;

    if (name === undefined) {
      return json(201, snapshotResource(newSnapshot(sandbox)));
    }

    if (!snapshotNames) {
      return apiError(400, "invalid_request", "request body not allowed");
    }

    if (loseNameRaces && !nameIsHeld(name)) {
      newSnapshot(sandbox, { name, status: "CREATING" }).readyAfterGets = 1;
    }

    if (nameIsHeld(name)) {
      return apiError(
        409,
        "sandbox_snapshot_name_taken",
        "Sandbox snapshot name is already in use",
      );
    }

    return json(201, snapshotResource(newSnapshot(sandbox, { name })));
  });

  /** Read a snapshot, moving a `CREATING` one along towards `READY`. */
  const readSnapshot = (snapshot: FakeSnapshot): FakeSnapshot => {
    if (
      snapshot.status === "CREATING" &&
      snapshot.readyAfterGets !== undefined
    ) {
      snapshot.readyAfterGets -= 1;

      if (snapshot.readyAfterGets < 0) {
        snapshot.status = "READY";
      }
    }

    return snapshot;
  };

  const listSnapshots: Handler = ({ url }) => {
    const name = snapshotNames ? url.searchParams.get("name") : null;

    // Newest first, as the API lists them.
    const items = [...snapshots.values()]
      .reverse()
      .filter((snapshot) => {
        return name === null || snapshot.name === name;
      })
      .map((snapshot) => {
        const resource = snapshotResource(readSnapshot(snapshot));

        if (snapshotNames) {
          return resource;
        }

        // A server without names never gives one.
        const { name: _name, ...withoutName } = resource;

        return withoutName;
      });

    return json(200, items, { page: { hasMore: false, limit: 100 } });
  };

  const startProcess: Handler = onSandbox(({ body }, sandbox) => {
    const argv = toArgv(body.command);

    commands.push(argv);
    timeline.push(`command ${argv.join(" ")}`);

    const script = answered(scriptFor(argv), body);

    leaveFiles(sandbox, script);

    const process: FakeProcess = {
      id: nextId(),
      sandboxId: sandbox.id,
      // As the API was given it, which a lookup after an ambiguous start
      // compares with
      command: Array.isArray(body.command) ? body.command : argv,
      pid: 42,
      state: "RUNNING",
      stdout: script.stdout ?? "",
      stderr: script.stderr ?? "",
      ...(script.chunks ? { chunks: script.chunks } : {}),
      startedAt: now(),
      ticksUntilExit: script.ticks ?? 0,
      ...(script.exitCode !== undefined && { plannedExit: script.exitCode }),
    };

    processes.set(process.id, process);

    // Cloud sometimes answers a start that succeeded with a 409.
    if (script.ambiguousStarts && script.ambiguousStarts > 0) {
      script.ambiguousStarts--;

      return apiError(
        409,
        "operation_ambiguous",
        "Sandbox process may have started; list processes and reconcile before starting another",
      );
    }

    return json(201, processResource(process));
  });

  const waitForProcess: Handler = onProcess((_req, process) => {
    tick(process);

    if (process.state === "RUNNING") {
      return apiError(408, "sandbox_process_wait_timed_out", "wait timed out");
    }

    return json(200, {
      id: process.id,
      state: process.state,
      ...exitFields(process),
    });
  });

  const processOutput: Handler = onProcess((_req, process) => {
    // Like Cloud, protobuf JSON omits `chunks` when there's no output.
    if (!process.chunks && !process.stdout && !process.stderr) {
      return json(200, {});
    }

    const chunk = (stream: string, text: string) => {
      return { stream, data: btoa(text), encoding: "base64", at: now() };
    };

    if (process.chunks) {
      return json(200, {
        chunks: process.chunks.map(({ stream, text }) => {
          return chunk(stream, text);
        }),
      });
    }

    return json(200, {
      chunks: [
        ...(process.stdout ? [chunk("STDOUT", process.stdout)] : []),
        ...(process.stderr ? [chunk("STDERR", process.stderr)] : []),
      ],
    });
  });

  const signalProcess: Handler = onProcess(({ body }, process) => {
    process.state = "KILLED";

    process.terminationSignal = body?.signal ?? 15;

    process.endedAt = now();

    return noContent();
  });

  const SANDBOX = "^/v2/sandboxes/(?<id>[^/]+)";
  const PROCESS = `${SANDBOX}/processes/(?<processId>[^/]+)`;

  const routes: Route[] = [
    { method: "POST", path: /^\/v2\/sandboxes$/, handler: createSandbox },
    {
      method: "GET",
      path: /^\/v2\/sandboxes$/,
      handler: () => {
        return json(200, [...sandboxes.values()].map(sandboxResource), {
          page: { hasMore: false, limit: 100 },
        });
      },
    },
    {
      method: "GET",
      path: new RegExp(`${SANDBOX}$`),
      handler: onSandbox((_req, sandbox) => {
        return json(200, sandboxResource(sandbox));
      }),
    },
    {
      method: "DELETE",
      path: new RegExp(`${SANDBOX}$`),
      handler: onSandbox((_req, sandbox) => {
        sandbox.status = "TERMINATED";

        return noContent();
      }),
    },
    {
      method: "POST",
      path: new RegExp(`${SANDBOX}/exec$`),
      handler: execInSandbox,
    },
    {
      method: "POST",
      path: new RegExp(`${SANDBOX}/pause$`),
      handler: onSandbox((_req, sandbox) => {
        sandbox.status = "PAUSED";

        return json(200, sandboxResource(sandbox));
      }),
    },
    {
      method: "POST",
      path: new RegExp(`${SANDBOX}/resume$`),
      handler: onSandbox((_req, sandbox) => {
        sandbox.status = "RUNNING";

        return json(200, sandboxResource(sandbox));
      }),
    },
    {
      method: "POST",
      path: new RegExp(`${SANDBOX}/snapshots$`),
      handler: createSnapshot,
    },
    {
      method: "*",
      path: new RegExp(`${SANDBOX}/files`),
      handler: onSandbox(({ url, upload }, sandbox) => {
        const path = url.searchParams.get("path") ?? "";

        if (upload !== undefined) {
          files.get(sandbox.id)?.set(path, upload);
        }

        // A download is the file's bytes, not an envelope.
        const content = files.get(sandbox.id)?.get(path);

        if (upload === undefined && content !== undefined) {
          return new Response(content);
        }

        return json(200, {
          path,
          bytesWritten: 1,
        });
      }),
    },
    {
      method: "POST",
      path: new RegExp(`${SANDBOX}/processes$`),
      handler: startProcess,
    },
    {
      method: "GET",
      path: new RegExp(`${SANDBOX}/processes$`),
      handler: onSandbox((_req, sandbox) => {
        const items = [...processes.values()]
          .filter((process) => {
            return process.sandboxId === sandbox.id;
          })
          .map(processResource);

        return json(200, items, { page: { limit: 50 } });
      }),
    },
    {
      method: "GET",
      path: new RegExp(`${PROCESS}$`),
      handler: onProcess((_req, process) => {
        return json(200, processResource(process));
      }),
    },
    {
      method: "POST",
      path: new RegExp(`${PROCESS}/wait`),
      handler: waitForProcess,
    },
    {
      method: "GET",
      path: new RegExp(`${PROCESS}/output`),
      handler: processOutput,
    },
    {
      method: "POST",
      path: new RegExp(`${PROCESS}/signals$`),
      handler: signalProcess,
    },
    {
      method: "GET",
      path: /^\/v2\/snapshots$/,
      handler: listSnapshots,
    },
    {
      method: "GET",
      path: /^\/v2\/snapshots\/(?<id>[^/]+)$/,
      handler: ({ params }) => {
        const snapshot = snapshots.get(params.id ?? "");

        return snapshot
          ? json(200, snapshotResource(readSnapshot(snapshot)))
          : apiError(404, "sandbox_snapshot_not_found", "snapshot not found");
      },
    },
    {
      method: "DELETE",
      path: /^\/v2\/snapshots\/(?<id>[^/]+)$/,
      handler: ({ params }) => {
        const snapshot = snapshots.get(params.id ?? "");

        if (!snapshot) {
          return apiError(
            404,
            "sandbox_snapshot_not_found",
            "snapshot not found",
          );
        }

        if (undeletable.has(snapshot.id)) {
          return apiError(
            409,
            "sandbox_snapshot_in_use",
            "Sandbox snapshot can't be deleted right now",
          );
        }

        snapshots.delete(snapshot.id);

        return noContent();
      },
    },
  ];

  const fakeFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input.toString(),
      "http://sandbox.test",
    );

    const method = (init?.method ?? "GET").toUpperCase();

    requests.push(`${method} ${url.pathname}`);

    if (
      method === "GET" &&
      url.pathname === "/v2/snapshots" &&
      !url.searchParams.get("name")
    ) {
      fullSnapshotListings.push(url.search);
    }

    // File uploads send bytes, so only JSON bodies are parsed.
    const contentType = String(
      (init?.headers as Record<string, string> | undefined)?.["Content-Type"] ??
        "",
    );

    const body =
      init?.body && contentType.includes("application/json")
        ? JSON.parse(String(init.body))
        : undefined;

    for (const route of routes) {
      const match = route.path.exec(url.pathname);

      if (match && (route.method === "*" || route.method === method)) {
        return route.handler({
          url,
          body,
          ...(init?.body instanceof Uint8Array
            ? { upload: new TextDecoder().decode(init.body) }
            : {}),
          params: { ...match.groups },
        });
      }
    }

    return json(404, null);
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    sandboxes,
    processes,
    snapshots,
    commands,
    timeline,
    requests,
    fullSnapshotListings,
    script: (next) => {
      scripts = next;
    },
    disableSnapshots: () => {
      snapshotsEnabled = false;
    },
    exhaustSnapshots: () => {
      snapshotsExhausted = true;
    },
    failSnapshotStarts: () => {
      for (const id of snapshots.keys()) {
        failingSnapshots.set(id, "failed");
      }
    },
    timeoutSnapshotStarts: () => {
      for (const id of snapshots.keys()) {
        failingSnapshots.set(id, "timeout");
      }
    },
    failAllSnapshotStarts: () => {
      failingAllSnapshots = "failed";
    },
    failNextSnapshotStarts: (mode, options) => {
      for (let i = 0; i < (options?.count ?? 1); i++) {
        queuedFaults.push({
          mode,
          ...(i === 0 && options?.then ? { then: options.then } : {}),
        });
      }
    },
    refuseSnapshotDeletes: () => {
      for (const id of snapshots.keys()) {
        undeletable.add(id);
      }
    },
    snapshotStarts,
    withoutSnapshotNames: () => {
      snapshotNames = false;
    },
    loseSnapshotNameRaces: () => {
      loseNameRaces = true;
    },
  };
};
