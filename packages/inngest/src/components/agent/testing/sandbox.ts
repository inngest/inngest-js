/**
 * @module
 * EXPERIMENTAL: FakeSandbox, the Sandboxes REST API served from memory, as a
 * `fetch` you give the Inngest client. Sandboxes are created, run canned
 * commands, hold uploaded files and are destroyed without leaving the
 * process. Every operation is reported to the fakes server (`startFakes()`)
 * so a test can assert on it.
 * Requests for anything but `/v2/sandboxes` go to the real `fetch`.
 *
 * Processes and the commands that talk to them (the call-home wrapper and
 * waiter of tools on `commands.run`) run for real on this machine, with
 * `/inngest/tools` moved into a temp directory. So do the files the runners
 * put under `/tmp/inngest-`. The sandbox's own state is that directory.
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { asyncDispose } from "../../../helpers/asyncDispose.ts";
import type { Call, CallFilter, Fakes } from "./fakes.ts";

/**
 * Options of `fakeSandbox()`.
 */
export interface FakeSandboxOptions {
  /**
   * The fakes server (`startFakes()`) of this process that the operations are
   * recorded on, next to its Slack and GitHub calls. Every operation is also
   * on the `calls` of the sandbox itself.
   */
  fakes?: Fakes;

  /**
   * The URL of a fakes server in another process (`startFakes().url`), for an
   * app that runs apart from the test. Each operation is posted there and
   * awaited before the sandbox answers, so a test that sees the agent's result
   * also sees the call.
   */
  recordUrl?: string;

  /**
   * Commands by the text they contain; the first match answers. A command that
   * matches none fails with exit code 127 and says so on stderr, so a typo in
   * a test never passes by silence. The key `""` matches any command: put it
   * last to let the rest succeed with no output.
   */
  commands?: Record<
    string,
    { stdout?: string; stderr?: string; exitCode?: number }
  >;

  /**
   * Directories on this machine. A command that matches no canned entry and
   * runs in one of them runs for real, and files under /tmp/inngest-git- are
   * served from disk, so a scenario can use real git.
   */
  localDirs?: string[];

  /**
   * More sandbox paths (a file, or a directory with everything under it; not
   * under `/work`, which is on the host already) whose files live on
   * this machine, next to `/inngest/tools`, `/work/` and
   * `/tmp/inngest-run-code-`: an upload is written to a directory of the
   * sandbox's own and a read comes from there, and a command that mentions
   * the path runs for real with it moved there.
   */
  diskPaths?: string[];
}

const killTree = (child: ReturnType<typeof spawn> | undefined) => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
};

const encode = (text: string) => {
  return Buffer.from(text).toString("base64");
};

const now = () => {
  return new Date().toISOString();
};

const runLocal = (
  command: string[],
  cwd?: string,
  environment: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  return new Promise((resolve) => {
    execFile(
      command[0] as string,
      command.slice(1),
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          ...environment,
          GIT_AUTHOR_NAME: "fake-sandbox",
          GIT_AUTHOR_EMAIL: "fake-sandbox@example.com",
          GIT_COMMITTER_NAME: "fake-sandbox",
          GIT_COMMITTER_EMAIL: "fake-sandbox@example.com",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode:
            error === null
              ? 0
              : typeof error.code === "number"
                ? error.code
                : 1,
        });
      },
    );
  });
};

/**
 * A process the agent started: what it printed, and how it ended.
 */
interface FakeProcess {
  id: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  done: Promise<void>;
  child?: ReturnType<typeof spawn>;
}

/**
 * A fake Sandboxes API and what it recorded.
 */
export interface FakeSandbox {
  /**
   * The Sandboxes API. Pass it as the `fetch` option of the Inngest client;
   * every request that is not for the Sandboxes API goes to the real one.
   */
  fetch: typeof fetch;

  /**
   * Every operation so far, oldest first.
   */
  calls: Call[];

  /**
   * The operations that match every field of `filter`, oldest first.
   */
  posts: (filter?: Pick<CallFilter, "method" | "thread">) => Call[];

  /**
   * Kills the processes the agent started and removes the directory the tools
   * were written to. Later requests answer 503.
   */
  close: () => Promise<void>;

  /**
   * Same as `close()`, for `await using sandbox = fakeSandbox()`.
   */
  [Symbol.asyncDispose]: () => Promise<void>;
}

/**
 * Builds the fake Sandboxes API. Close it when the test ends: that kills the
 * processes the agent started and removes the directory the tools were
 * written to.
 * @returns `fetch`, to pass as the `fetch` option of the Inngest client;
 * `calls` and `posts()`, the operations so far; `close()`.
 */
export const fakeSandbox = (options: FakeSandboxOptions = {}): FakeSandbox => {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  const children = new Set<ReturnType<typeof spawn>>();
  const processes = new Map<string, FakeProcess>();
  // Files by sandbox, and the copy a snapshot keeps, so a sandbox created from
  // a snapshot starts with the files its source had.
  const files = new Map<string, Map<string, Uint8Array>>();
  const snapshotFiles = new Map<string, Map<string, Uint8Array>>();
  const filesOf = (sandboxId: string) => {
    let found = files.get(sandboxId);

    if (!found) {
      found = new Map();
      files.set(sandboxId, found);
    }

    return found;
  };
  const toolsDir = mkdtempSync(join(tmpdir(), "fake-sandbox-tools-"));
  // Every sandbox has a /work of its own on this machine, so a new sandbox
  // starts empty; a snapshot keeps a copy, and a sandbox made from it starts
  // with that copy.
  const workDirs = new Map<string, string>();
  const snapshotDirs = new Map<string, string>();
  const workOf = (sandboxId: string) => {
    let dir = workDirs.get(sandboxId);

    if (!dir) {
      dir = mkdtempSync(join(tmpdir(), "fake-sandbox-work-"));
      workDirs.set(sandboxId, dir);
    }

    return dir;
  };
  // Where a path or command of the sandbox lives on this machine. The paths
  // of `diskPaths` move into a directory of the sandbox's own, so two
  // sandboxes never share a file.
  // One pass over the text, at path boundaries, so a path is never rewritten
  // twice and `/workspace` or `/my/data` are left alone.
  // Directories or files, without a trailing slash; none under /work, which
  // is a host directory already.
  const disks = (options.diskPaths ?? [])
    .map((disk) => {
      return disk.replace(/\/+$/, "");
    })
    .filter((disk) => {
      return disk !== "";
    });

  for (const disk of disks) {
    if (disk === "/work" || disk.startsWith("/work/")) {
      throw new Error(
        `FakeSandbox: diskPaths cannot be under /work (${disk}); /work is on the host already.`,
      );
    }
  }

  const escapeForRegExp = (text: string) => {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  };
  const sandboxPaths = new RegExp(
    `(?<![\\w./-])(${["/inngest/tools", "/work", ...disks]
      .map(escapeForRegExp)
      .sort((a, b) => {
        return b.length - a.length;
      })
      .join("|")})(?![\\w-])`,
    "g",
  );
  const localFor = (sandboxId: string) => {
    return (text: string) => {
      return text.replace(sandboxPaths, (path) => {
        if (path === "/inngest/tools") {
          return toolsDir;
        }

        if (path === "/work") {
          return workOf(sandboxId);
        }

        return join(workOf(sandboxId), ".fake-disk", path);
      });
    };
  };
  // Whether a command, a cwd or an environment value names a path that lives
  // on this machine.
  const mentionsHostPath = (text: string) => {
    return new RegExp(sandboxPaths.source).test(text);
  };
  const onDisk = (path: string) => {
    return (
      path.startsWith("/inngest/tools") ||
      path === "/work" ||
      path.startsWith("/work/") ||
      path.startsWith("/tmp/inngest-run-code-") ||
      disks.some((disk) => {
        return path === disk || path.startsWith(`${disk}/`);
      })
    );
  };
  const snapshots = new Map<
    string,
    Record<string, unknown> & { name?: string }
  >();

  // In this process first, so `calls` is complete the moment the sandbox
  // answers; a fakes server in another process is posted to and awaited.
  const record = async (method: string, body: Record<string, unknown>) => {
    calls.push({ channel: "sandbox", method, body: { method, ...body } });
    options.fakes?.record(method, body);

    if (options.recordUrl) {
      await realFetch(`${options.recordUrl}/record`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, ...body }),
      }).catch(() => {});
    }
  };

  const resource = (id: string, name = "fake") => {
    return {
      id,
      name,
      status: "RUNNING",
      vpcId: "11111111-1111-4111-8111-111111111111",
      imageRef: "default",
      resources: { vcpu: 2, memoryMb: 2048 },
      createdAt: now(),
      startedAt: now(),
    };
  };

  // What to do with a command: run it on this machine, or answer it from
  // `commands`. The tools and their log always run for real; a command that
  // touches this sandbox's /work or runs in one of `localDirs` runs for real
  // unless an entry describes it.
  const planOf = (request: {
    command: string[];
    cwd?: string;
    environment?: Record<string, string>;
  }) => {
    const text = request.command.join(" ");
    const entries = Object.entries(options.commands ?? {});
    const canned = entries.find(([key]) => {
      return text.includes(key);
    })?.[1];
    // The key "" matches everything, so it must not stop a command meant to
    // run for real.
    const described = entries.some(([key]) => {
      return key !== "" && text.includes(key);
    });
    const touchesWork =
      mentionsHostPath(text) ||
      mentionsHostPath(request.cwd ?? "") ||
      Object.values(request.environment ?? {}).some(mentionsHostPath);
    const inLocalDir =
      request.cwd !== undefined &&
      (options.localDirs ?? []).some((dir) => {
        const base = dir.replace(/\/+$/, "");

        return (
          base !== "" &&
          (request.cwd === base || request.cwd?.startsWith(`${base}/`))
        );
      });
    const tools = text.includes("/inngest/tools") || text.includes("ops.log");

    return {
      text,
      canned,
      here: tools || (!described && (touchesWork || inLocalDir)),
    };
  };
  const unmatched = (text: string) => {
    return {
      stderr: `FakeSandbox: no entry of \`commands\` matches "${text}". Add one, or the key "" to match any command.\n`,
      exitCode: 127,
    } as { stdout?: string; stderr?: string; exitCode?: number };
  };

  let closed = false;

  const fakeFetch: typeof fetch = async (input, init) => {
    if (closed) {
      return Response.json(
        { errors: [{ code: "closed", message: "FakeSandbox is closed" }] },
        { status: 503 },
      );
    }

    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
      "http://fake.invalid",
    );
    const method = init?.method ?? "GET";
    const snapshotMatch = url.pathname.match(/^\/v2\/snapshots(?:\/([^/]+))?$/);

    if (snapshotMatch) {
      const [, snapshotId] = snapshotMatch;

      if (!snapshotId && method === "GET") {
        const name = url.searchParams.get("name");
        const items = [...snapshots.values()]
          .filter((snapshot) => {
            return name === null || snapshot.name === name;
          })
          .reverse();

        return Response.json({
          data: items,
          page: { hasMore: false, limit: 100 },
          metadata: { fetchedAt: now() },
        });
      }

      const found = snapshotId ? snapshots.get(snapshotId) : undefined;

      if (snapshotId && method === "GET" && found) {
        return Response.json({ data: found });
      }

      if (snapshotId && method === "DELETE" && found) {
        snapshots.delete(snapshotId);
        await record("snapshot.delete", { id: snapshotId, name: found.name });

        return new Response(null, { status: 204 });
      }

      return Response.json(
        {
          errors: [
            {
              code: "sandbox_snapshot_not_found",
              message: "no such snapshot",
            },
          ],
        },
        { status: 404 },
      );
    }

    const match = url.pathname.match(/^\/v2\/sandboxes(?:\/([^/]+)(\/.*)?)?$/);

    if (!match) {
      // The same fetch carries the client's other traffic (events, sync), which
      // goes where it was going. Anything else under /v2 is the Sandboxes API,
      // and the fake does not serve it: that is an error, never the network.
      if (!url.pathname.startsWith("/v2/")) {
        return realFetch(input, init);
      }

      return Response.json(
        {
          errors: [
            {
              code: "unsupported",
              message: `FakeSandbox serves no ${method} ${url.pathname}`,
            },
          ],
        },
        { status: 404 },
      );
    }

    const [, id, rest = ""] = match;
    const local = localFor(id ?? "");
    // A working directory of the sandbox exists on the host before a command
    // runs in it, as it would in a real sandbox.
    const ensureCwd = (cwd: string | undefined) => {
      if (cwd !== undefined && mentionsHostPath(cwd)) {
        mkdirSync(local(cwd), { recursive: true });
      }
    };
    // What a command run here sees: the sandbox's own /work as SANDBOX_WORK,
    // and its environment with the sandbox paths moved to this machine.
    const environmentOf = (environment: Record<string, string> = {}) => {
      return {
        SANDBOX_WORK: workOf(id ?? ""),
        ...Object.fromEntries(
          Object.entries(environment).map(([key, value]) => {
            return [key, local(value)];
          }),
        ),
      };
    };

    if (id && rest === "/snapshots" && method === "POST") {
      const request = JSON.parse(String(init?.body || "{}")) as {
        name?: string;
      };

      if (
        request.name &&
        [...snapshots.values()].some((snapshot) => {
          return snapshot.name === request.name;
        })
      ) {
        return Response.json(
          {
            errors: [
              {
                code: "sandbox_snapshot_name_taken",
                message: "the snapshot name is taken",
              },
            ],
          },
          { status: 409 },
        );
      }

      const created = {
        id: randomUUID(),
        ...(request.name ? { name: request.name } : {}),
        sourceImageId: "a".repeat(64),
        status: "READY",
        compatibilityId: "fake",
        resources: { vcpu: 2, memoryMb: 2048 },
        memoryPackCount: 0,
        diskPackCount: 0,
        storedBytes: 0,
        createdAt: now(),
        updatedAt: now(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };

      snapshots.set(created.id, created);
      snapshotFiles.set(created.id, new Map(filesOf(id)));

      const kept = mkdtempSync(join(tmpdir(), "fake-snapshot-"));

      cpSync(workOf(id), kept, { recursive: true });
      snapshotDirs.set(created.id, kept);
      await record("snapshot.create", {
        id: created.id,
        name: request.name,
        sandboxId: id,
      });

      return Response.json({ data: created }, { status: 201 });
    }

    if (!id && method === "POST") {
      const request = JSON.parse(String(init?.body ?? "{}")) as {
        name?: string;
        snapshotId?: string;
      };
      const created = resource(randomUUID(), request.name);

      if (request.snapshotId) {
        files.set(
          created.id,
          new Map(snapshotFiles.get(request.snapshotId) ?? []),
        );

        const kept = snapshotDirs.get(request.snapshotId);

        if (kept) {
          cpSync(kept, workOf(created.id), { recursive: true });
        }
      }

      await record("sandbox.create", {
        id: created.id,
        ...(request.snapshotId && { snapshotId: request.snapshotId }),
      });

      return Response.json({ data: created }, { status: 201 });
    }

    if (id && !rest && method === "GET") {
      return Response.json({ data: resource(id) });
    }

    if (id && !rest && method === "DELETE") {
      await record("sandbox.destroy", { id });

      return new Response(null, { status: 204 });
    }

    if (id && rest === "/exec" && method === "POST") {
      const request = JSON.parse(String(init?.body)) as {
        command: string[];
        cwd?: string;
        environment?: Record<string, string>;
      };
      const plan = planOf(request);

      await record("sandbox.exec", {
        id,
        command: request.command,
        cwd: request.cwd,
      });

      if (plan.here) {
        ensureCwd(request.cwd);

        const ran = await runLocal(
          request.command.map(local),
          request.cwd === undefined ? undefined : local(request.cwd),
          environmentOf(request.environment),
        );

        return Response.json({
          data: {
            stdout: encode(ran.stdout),
            stderr: encode(ran.stderr),
            encoding: "base64",
            exitCode: ran.exitCode,
          },
        });
      }

      const answer = plan.canned ?? unmatched(plan.text);

      return Response.json({
        data: {
          stdout: encode(answer.stdout ?? ""),
          stderr: encode(answer.stderr ?? ""),
          encoding: "base64",
          exitCode: answer.exitCode ?? 0,
        },
      });
    }

    const processMatch = /^\/processes\/([^/]+)\/(wait|output|signals)$/.exec(
      rest,
    );
    const known = processMatch
      ? processes.get(processMatch[1] ?? "")
      : undefined;

    if (processMatch && known) {
      if (processMatch[2] === "wait") {
        await known.done;

        return Response.json({
          data: { id: known.id, state: "EXITED", exitCode: known.exitCode },
        });
      }

      if (processMatch[2] === "signals") {
        killTree(known.child);

        return new Response(null, { status: 204 });
      }

      return Response.json({
        data: {
          chunks: [
            {
              stream: "STDOUT",
              data: encode(known.stdout),
              encoding: "base64",
            },
            {
              stream: "STDERR",
              data: encode(known.stderr),
              encoding: "base64",
            },
          ],
        },
      });
    }

    if (id && rest === "/processes" && method === "POST") {
      const request = JSON.parse(String(init?.body)) as {
        command: string[];
        environment?: Record<string, string>;
        cwd?: string;
      };
      const plan = planOf(request);
      const process: FakeProcess = {
        id: randomUUID(),
        stdout: "",
        stderr: "",
        exitCode: 0,
        done: Promise.resolve(),
      };

      processes.set(process.id, process);

      if (plan.here) {
        ensureCwd(request.cwd);

        const child = spawn(
          local(request.command[0] as string),
          request.command.slice(1).map(local),
          {
            cwd: request.cwd === undefined ? undefined : local(request.cwd),
            env: {
              ...globalThis.process.env,
              ...environmentOf(request.environment),
            },
            stdio: ["ignore", "pipe", "pipe"],
            // Its own process group, so closing kills what a shell started too.
            detached: true,
          },
        );

        process.child = child;
        children.add(child);
        child.stdout.on("data", (chunk: Buffer) => {
          process.stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          process.stderr += chunk.toString();
        });
        process.done = new Promise<void>((resolve) => {
          child.on("error", (error) => {
            process.stderr += String(error);
            process.exitCode = 127;
            children.delete(child);
            resolve();
          });
          child.on("close", (code) => {
            process.exitCode = code ?? 1;
            children.delete(child);
            resolve();
          });
        });
      } else {
        const answer = plan.canned ?? unmatched(plan.text);

        process.stdout = answer.stdout ?? "";
        process.stderr = answer.stderr ?? "";
        process.exitCode = answer.exitCode ?? 0;
      }

      await record("sandbox.process", { id, command: request.command });

      return Response.json(
        {
          data: {
            id: process.id,
            command: request.command,
            pid: process.child?.pid ?? 1,
            state: "RUNNING",
            startedAt: now(),
          },
        },
        { status: 201 },
      );
    }

    if (id && rest === "/files") {
      const path = url.searchParams.get("path") ?? "";

      if (method === "PUT") {
        const body =
          typeof init?.body === "string"
            ? new TextEncoder().encode(init.body)
            : (init?.body as Uint8Array);
        if (onDisk(path)) {
          mkdirSync(dirname(local(path)), { recursive: true });
          writeFileSync(local(path), body);
        }
        filesOf(id).set(path, body);
        await record("sandbox.upload", {
          id,
          path,
          text: new TextDecoder().decode(body),
        });

        return Response.json({ data: { path, bytesWritten: body.length } });
      }

      let found: Uint8Array | undefined;

      // A file on the host may have been changed by a command since it was
      // uploaded: the host copy is the truth.
      if (path.startsWith("/tmp/inngest-git-") || onDisk(path)) {
        try {
          found = new Uint8Array(readFileSync(local(path)));
        } catch {}
      }

      found ??= filesOf(id).get(path);

      return found
        ? new Response(found as BodyInit)
        : Response.json(
            { errors: [{ code: "file_not_found", message: "no such file" }] },
            { status: 404 },
          );
    }

    return Response.json(
      {
        errors: [
          {
            code: "unsupported",
            message: `FakeSandbox serves no ${method} ${url.pathname}`,
          },
        ],
      },
      { status: 404 },
    );
  };

  const close = async () => {
    closed = true;

    for (const child of children) {
      killTree(child);
    }

    children.clear();
    rmSync(toolsDir, { recursive: true, force: true });

    for (const dir of [...workDirs.values(), ...snapshotDirs.values()]) {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  return {
    fetch: fakeFetch,
    calls,
    posts: (filter: CallFilter = {}) => {
      return calls.filter((call) => {
        return (
          (!filter.method || call.method === filter.method) &&
          (!filter.thread || call.thread === filter.thread)
        );
      });
    },
    close,
    [asyncDispose]: close,
  };
};
