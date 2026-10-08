/**
 * A fake Inngest Sandboxes REST API for tests, at the `fetch` boundary so the
 * SDK's real client and durable protocol run for real. Requests are matched
 * against a route table; each route is a small handler over the fake's state.
 *
 * @module
 */

import {
  snapshotMetaPath,
  writeSnapshotMetaScript,
} from "../machine/snapshotMeta.ts";

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
  startedAt: string;
  endedAt?: string;
  /** How many `wait`/`get` calls happen before this process exits. */
  ticksUntilExit: number;
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
  /**
   * Files on the machine that CI reads back, by path. Only CI's snapshot
   * metadata is kept: it is written by one command and read by another.
   */
  files: Map<string, string>;
}

export interface FakeSnapshot {
  id: string;
  /** The name it was created with, if any. */
  name?: string;
  status: string;
  sandboxId: string;
  /** The files of the machine it was taken of, which a restore gets. */
  files: Map<string, string>;
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
  script(scripts: CommandScript[]): void;
  /** Make snapshot creation fail the way an environment without it would. */
  disableSnapshots(): void;
  /** Make snapshot creation fail the way Cloud does when none are left. */
  exhaustSnapshots(): void;
  /**
   * Make a sandbox created from any snapshot that exists now never start, as
   * a stale one doesn't. Snapshots taken afterwards start normally.
   */
  failSnapshotStarts(): void;
  /** The snapshot of every sandbox create that asked for one, in order. */
  snapshotStarts: string[];
  /** Refuse every snapshot create that has a name, as a bad request. */
  refuseSnapshotNames(): void;
  /**
   * Have another builder win every named snapshot create: just before it, a
   * snapshot with the same name and the same files appears, still `CREATING`,
   * and the create is refused because the name is taken.
   */
  loseSnapshotNameRaces(): void;
}

// biome-ignore lint/suspicious/noExplicitAny: request bodies are untyped JSON
type Body = any;

/** What a route handler sees: the parsed request and its path captures. */
interface Req {
  url: URL;
  body: Body;
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

const toArgv = (command: unknown): string[] => {
  return Array.isArray(command) ? command : ["/bin/sh", "-c", String(command)];
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

  let scripts: CommandScript[] = [];
  let snapshotsEnabled = true;
  let snapshotsExhausted = false;
  let refuseNames = false;
  let loseNameRaces = false;
  let counter = 1;

  const nextId = (): string => {
    return uuid(counter++);
  };

  const scriptFor = (argv: string[]): CommandScript => {
    const joined = argv.join(" ");

    return (
      scripts.find((script) => {
        return joined.includes(script.match);
      }) ?? { match: "" }
    );
  };

  /** Advance a running process one poll, exiting it once its ticks run out. */
  const tick = (process: FakeProcess): void => {
    if (process.state !== "RUNNING") {
      return;
    }

    if (process.ticksUntilExit <= 0) {
      process.state = "EXITED";

      process.exitCode = scriptFor(process.command).exitCode ?? 0;

      process.endedAt = now();

      return;
    }

    process.ticksUntilExit -= 1;
  };

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

  const failingSnapshots = new Set<string>();
  const snapshotStarts: string[] = [];

  const createSandbox: Handler = ({ body }) => {
    if (body.snapshotId) {
      snapshotStarts.push(body.snapshotId);
    }

    // A name identifies an *active* sandbox; once one is terminated the same
    // name creates a new one.
    const taken = [...sandboxes.values()].some((sandbox) => {
      return sandbox.name === body.name && sandbox.status !== "TERMINATED";
    });

    if (taken) {
      return apiError(
        409,
        "sandbox_name_taken",
        "Sandbox name is already in use",
      );
    }

    if (body.snapshotId && failingSnapshots.has(body.snapshotId)) {
      // As on the real API, the sandbox exists and keeps its name, stuck in
      // STARTING, though the create call fails.
      const stuck: FakeSandbox = {
        id: nextId(),
        name: body.name,
        status: "STARTING",
        vcpu: body.vcpu ?? 2,
        memoryMb: body.memoryMb ?? 2048,
        snapshotId: body.snapshotId,
        stuck: true,
        files: new Map(),
      };

      sandboxes.set(stuck.id, stuck);

      return apiError(
        422,
        "sandbox_start_failed",
        "Sandbox did not reach RUNNING within 120000 milliseconds",
      );
    }

    const sandbox: FakeSandbox = {
      id: nextId(),
      name: body.name,
      status: "RUNNING",
      vcpu: body.vcpu ?? 2,
      memoryMb: body.memoryMb ?? 2048,
      ...(body.snapshotId ? { snapshotId: body.snapshotId } : {}),
      files: new Map(snapshots.get(body.snapshotId ?? "")?.files),
    };

    sandboxes.set(sandbox.id, sandbox);

    return json(201, sandboxResource(sandbox));
  };

  const execInSandbox: Handler = onSandbox(({ body }, sandbox) => {
    const argv = toArgv(body.command);

    commands.push(argv);
    timeline.push(`command ${argv.join(" ")}`);

    // CI's snapshot metadata is the one file kept: written by its own script,
    // and read with `cat` by a machine's setup.
    if (argv[2] === writeSnapshotMetaScript && argv[4] !== undefined) {
      sandbox.files.set(argv[4], argv[5] ?? "");
    }

    const read = argv[2]?.includes(`cat ${snapshotMetaPath}`)
      ? sandbox.files.get(snapshotMetaPath)
      : undefined;

    if (read !== undefined) {
      return json(200, {
        encoding: "base64",
        stdout: btoa(read),
        stderr: btoa(""),
        exitCode: 0,
      });
    }

    const script = scriptFor(argv);

    // Cloud answers an exec that runs past its timeout with a 504.
    if (script.execTimesOut) {
      return apiError(504, "sandbox_exec_timed_out", "Sandbox exec timed out");
    }

    return json(200, {
      encoding: "base64",
      stdout: btoa(script.stdout ?? ""),
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
      files: new Map(sandbox.files),
      createdAt: now(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };

    snapshots.set(snapshot.id, snapshot);
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

    if (refuseNames) {
      return apiError(
        400,
        "invalid_request",
        "request body is not allowed for this HTTP binding",
      );
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
    const name = url.searchParams.get("name");

    // Newest first, as the API lists them.
    const items = [...snapshots.values()]
      .reverse()
      .filter((snapshot) => {
        return name === null || snapshot.name === name;
      })
      .map((snapshot) => {
        return snapshotResource(readSnapshot(snapshot));
      });

    return json(200, items, { page: { hasMore: false, limit: 100 } });
  };

  const startProcess: Handler = onSandbox(({ body }, sandbox) => {
    const argv = toArgv(body.command);

    commands.push(argv);
    timeline.push(`command ${argv.join(" ")}`);

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
    if (!process.stdout && !process.stderr) {
      return json(200, {});
    }

    const chunk = (stream: string, text: string) => {
      return { stream, data: btoa(text), encoding: "base64", at: now() };
    };

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
      handler: onSandbox(({ url }) => {
        return json(200, {
          path: url.searchParams.get("path"),
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
        tick(process);

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
        return route.handler({ url, body, params: { ...match.groups } });
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
        failingSnapshots.add(id);
      }
    },
    snapshotStarts,
    refuseSnapshotNames: () => {
      refuseNames = true;
    },
    loseSnapshotNameRaces: () => {
      loseNameRaces = true;
    },
  };
};
