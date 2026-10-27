/**
 * @module
 * FakeSandbox: the Sandboxes REST API served from memory, as a `fetch` you
 * give the Inngest client. Sandboxes are created, run canned commands, hold
 * uploaded files and are destroyed without leaving the process. Every
 * operation is reported to the fakes server so a scenario can assert on it.
 * Requests for anything but `/v2/sandboxes` go to the real `fetch`.
 */
import { randomUUID } from "node:crypto";

export interface FakeSandboxOptions {
  /**
   * The fakes server URL (`AGENTS_E2E_FAKES`) the operations are reported to.
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
}

const encode = (text: string) => {
  return Buffer.from(text).toString("base64");
};

const now = () => {
  return new Date().toISOString();
};

export const fakeSandbox = (options: FakeSandboxOptions) => {
  const realFetch = globalThis.fetch;
  const files = new Map<string, Uint8Array>();
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
      record("snapshot.create", { id: created.id, name: request.name });

      return Response.json({ data: created }, { status: 201 });
    }

    if (!id && method === "POST") {
      const request = JSON.parse(String(init?.body ?? "{}")) as {
        name?: string;
      };
      const created = resource(randomUUID(), request.name);

      record("sandbox.create", { id: created.id });

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

      return Response.json({
        data: {
          stdout: encode(canned?.stdout ?? ""),
          stderr: encode(canned?.stderr ?? ""),
          encoding: "base64",
          exitCode: canned?.exitCode ?? 0,
        },
      });
    }

    if (id && rest === "/files") {
      const path = url.searchParams.get("path") ?? "";

      if (method === "PUT") {
        const body = init?.body as Uint8Array;
        files.set(path, body);
        record("sandbox.upload", {
          id,
          path,
          text: new TextDecoder().decode(body),
        });

        return Response.json({ data: { path, bytesWritten: body.length } });
      }

      const found = files.get(path);

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
