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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface FakeSandboxOptions {
  /**
   * The URL of the fakes server (`startFakes().url`) the operations are
   * reported to.
   */
  recordUrl: string;

  /**
   * Commands by the text they contain; the first match answers, any other
   * command prints nothing and exits 0.
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
}

const encode = (text: string) => {
  return Buffer.from(text).toString("base64");
};

const now = () => {
  return new Date().toISOString();
};

const runLocal = (
  command: string[],
  cwd?: string,
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
 * Builds the fake Sandboxes API.
 * @returns `fetch`: pass it as the `fetch` option of the Inngest client.
 */
export const fakeSandbox = (options: FakeSandboxOptions) => {
  const realFetch = globalThis.fetch;
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
  // Where a path or command of the sandbox lives on this machine
  const local = (text: string) => {
    return text.replaceAll("/inngest/tools", toolsDir);
  };
  const onDisk = (path: string) => {
    return (
      path.startsWith("/inngest/tools") ||
      path.startsWith("/tmp/inngest-run-code-")
    );
  };
  const snapshots = new Map<
    string,
    Record<string, unknown> & { name?: string }
  >();

  const record = (method: string, body: Record<string, unknown>) => {
    void realFetch(`${options.recordUrl}/record`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, ...body }),
    }).catch(() => {});
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

  const fakeFetch: typeof fetch = async (input, init) => {
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
        record("snapshot.delete", { id: snapshotId, name: found.name });

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
      return realFetch(input, init);
    }

    const [, id, rest = ""] = match;

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
      record("snapshot.create", {
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
      }

      record("sandbox.create", {
        id: created.id,
        ...(request.snapshotId && { snapshotId: request.snapshotId }),
      });

      return Response.json({ data: created }, { status: 201 });
    }

    if (id && !rest && method === "GET") {
      return Response.json({ data: resource(id) });
    }

    if (id && !rest && method === "DELETE") {
      record("sandbox.destroy", { id });

      return new Response(null, { status: 204 });
    }

    if (id && rest === "/exec" && method === "POST") {
      const request = JSON.parse(String(init?.body)) as {
        command: string[];
        cwd?: string;
      };
      const text = request.command.join(" ");
      const canned = Object.entries(options.commands ?? {}).find(([key]) => {
        return text.includes(key);
      })?.[1];

      record("sandbox.exec", {
        id,
        command: request.command,
        cwd: request.cwd,
      });

      if (text.includes("/inngest/tools") || text.includes("ops.log")) {
        const ran = await runLocal(request.command.map(local), undefined);

        return Response.json({
          data: {
            stdout: encode(ran.stdout),
            stderr: encode(ran.stderr),
            encoding: "base64",
            exitCode: ran.exitCode,
          },
        });
      }

      if (
        !canned &&
        request.cwd !== undefined &&
        options.localDirs?.some((dir) => {
          return request.cwd?.startsWith(dir);
        })
      ) {
        const ran = await runLocal(request.command, request.cwd);

        return Response.json({
          data: {
            stdout: encode(ran.stdout),
            stderr: encode(ran.stderr),
            encoding: "base64",
            exitCode: ran.exitCode,
          },
        });
      }

      return Response.json({
        data: {
          stdout: encode(canned?.stdout ?? ""),
          stderr: encode(canned?.stderr ?? ""),
          encoding: "base64",
          exitCode: canned?.exitCode ?? 0,
        },
      });
    }

    if (id && rest === "/processes" && method === "POST") {
      const request = JSON.parse(String(init?.body)) as {
        command: string[];
        environment?: Record<string, string>;
        cwd?: string;
      };
      const child = spawn(
        request.command[0] as string,
        request.command.slice(1).map(local),
        {
          cwd: request.cwd,
          env: {
            ...process.env,
            ...Object.fromEntries(
              Object.entries(request.environment ?? {}).map(([key, value]) => {
                return [key, local(value)];
              }),
            ),
          },
          stdio: "ignore",
        },
      );

      child.on("error", () => {});
      record("sandbox.process", { id, command: request.command });

      return Response.json(
        {
          data: {
            id: randomUUID(),
            command: request.command,
            pid: child.pid ?? 1,
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
        record("sandbox.upload", {
          id,
          path,
          text: new TextDecoder().decode(body),
        });

        return Response.json({ data: { path, bytesWritten: body.length } });
      }

      let found = filesOf(id).get(path);

      if (!found && (path.startsWith("/tmp/inngest-git-") || onDisk(path))) {
        try {
          found = new Uint8Array(readFileSync(local(path)));
        } catch {}
      }

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

  return { fetch: fakeFetch };
};
