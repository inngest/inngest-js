import { runSteps, testClientId } from "../../test/helpers.ts";
import type { OutgoingOp } from "../../types.ts";
import { version } from "../../version.ts";
import { Inngest } from "../Inngest.ts";
import { sandboxMiddleware } from "./middleware.ts";
import { parseSandboxOperation } from "./protocol.ts";
import { sandboxTraceMetadata } from "./trace.ts";

const sandboxId = "22222222-2222-4222-8222-222222222222";
const snapshotId = "44444444-4444-4444-8444-444444444444";
const now = "2026-07-28T00:00:00Z";

const sandboxRef = {
  kind: "inngest/sandbox" as const,
  version: 1 as const,
  id: sandboxId,
  name: "ci-box",
  status: "RUNNING" as const,
  vpcId: "11111111-1111-4111-8111-111111111111",
  imageRef: "default",
  resources: { vcpu: 2, memoryMb: 2048 },
  createdAt: now,
  startedAt: now,
};

const snapshotResource = {
  id: snapshotId,
  sourceImageId:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  status: "READY",
  compatibilityId: "simcity-linux-amd64-v1",
  resources: { vcpu: 2, memoryMb: 2048 },
  memoryPackCount: 8,
  diskPackCount: 2,
  storedBytes: 512,
  createdAt: now,
  updatedAt: now,
  expiresAt: "2026-08-04T00:00:00Z",
};

/**
 * A client whose sandbox API returns `sandboxRef` for a `get`, answers other
 * paths with `route`, and 404s the rest.
 */
const createClient = (route: (path: string) => Response | undefined) => {
  const { kind: _kind, version: _version, ...sandboxResource } = sandboxRef;

  return new Inngest({
    id: testClientId,
    signingKey: "signkey-test",
    baseUrl: "https://api.example.test",
    fetch: async (input, init) => {
      const { pathname } = new URL(
        input instanceof Request ? input.url : input,
      );

      if (
        pathname === `/v2/sandboxes/${sandboxId}` &&
        (init?.method ?? "GET") === "GET"
      ) {
        return Response.json({ data: sandboxResource });
      }

      return (
        route(pathname) ??
        Response.json(
          { errors: [{ code: "missing", message: "missing" }] },
          { status: 404 },
        )
      );
    },
    middleware: [sandboxMiddleware()],
  });
};

/**
 * The values of every `inngest.sandbox` entry on a step.
 */
const sandboxEntries = (step: OutgoingOp | undefined) => {
  return ((step?.metadata ?? []) as Array<{ kind: string; values: object }>)
    .filter(({ kind }) => {
      return kind === "inngest.sandbox";
    })
    .map(({ values }) => {
      return values;
    });
};

describe("sandboxTraceMetadata", () => {
  test("describes a shell command by what the user wrote", () => {
    const operation = parseSandboxOperation({
      protocolVersion: 1,
      action: "exec",
      target: { sandbox: sandboxRef },
      input: [
        { command: ["/bin/sh", "-c", "npm test"], cwd: "/work", timeoutMs: 1 },
      ],
    });

    expect(
      sandboxTraceMetadata(operation, {
        result: {
          protocolVersion: 1,
          action: "exec",
          result: {
            stdout: "",
            stderr: "",
            encoding: "base64",
            exitCode: 0,
            output: { truncated: false },
          },
        },
      }),
    ).toEqual({
      version: 1,
      action: "exec",
      method: "commands.run",
      sandbox_id: sandboxId,
      sandbox_name: "ci-box",
      command: ["/bin/sh", "-c", "npm test"],
      command_display: "npm test",
      cwd: "/work",
      exit_code: 0,
    });
  });

  test("keeps only the start of a long command", () => {
    const operation = parseSandboxOperation({
      protocolVersion: 1,
      action: "process.start",
      target: { sandbox: sandboxRef },
      input: [{ command: ["node", "-e", "x".repeat(10_000)] }],
    });

    const metadata = sandboxTraceMetadata(operation, {
      error: { code: "sandbox_unavailable" },
    });

    expect(metadata.command_truncated).toBe(true);
    expect(metadata.command?.join("").length).toBe(1_024);
    expect(metadata.command_display).toBeUndefined();
    expect(metadata.error_code).toBe("sandbox_unavailable");
    expect(metadata.process_id).toBeUndefined();
  });

  test("records the signal that killed a process it looks up", () => {
    const processId = "33333333-3333-4333-8333-333333333333";

    const metadata = sandboxTraceMetadata(
      parseSandboxOperation({
        protocolVersion: 1,
        action: "process.get",
        target: { sandbox: sandboxRef, processId },
        input: [],
      }),
      {
        result: {
          protocolVersion: 1,
          action: "process.get",
          process: {
            kind: "inngest/sandbox.process",
            version: 1,
            sandboxId,
            id: processId,
            command: ["node", "server.js"],
            state: "KILLED",
            terminationSignal: 9,
          },
        },
      },
    );

    expect(metadata).toMatchObject({
      method: "processes.get",
      process_state: "KILLED",
      termination_signal: 9,
    });
  });

  test("identifies the machine from the operation, even when it fails", () => {
    // The machine may have been created outside this run, so its identity
    // must come from the reference the operation targets, not a result.
    const failed = sandboxTraceMetadata(
      parseSandboxOperation({
        protocolVersion: 1,
        action: "resume",
        target: { sandbox: sandboxRef },
        input: [{ timeoutMs: 1_000 }],
      }),
      { error: undefined },
    );

    expect(failed).toMatchObject({
      sandbox_id: sandboxId,
      sandbox_name: "ci-box",
    });

    const missing = sandboxTraceMetadata(
      parseSandboxOperation({
        protocolVersion: 1,
        action: "get",
        input: [{ sandboxId }],
      }),
      { result: { protocolVersion: 1, action: "get", sandbox: null } },
    );

    expect(missing.sandbox_id).toBe(sandboxId);
  });
});

describe("step.sandbox trace metadata", () => {
  test("describes each step, and groups a snapshot's steps in one span", async () => {
    const client = createClient((path) => {
      if (path.endsWith("/exec")) {
        return Response.json({
          data: { stdout: "", stderr: "", encoding: "base64", exitCode: 1 },
        });
      }

      if (path === `/v2/sandboxes/${sandboxId}/snapshots`) {
        return Response.json(
          { data: { ...snapshotResource, status: "CREATING" } },
          { status: 202 },
        );
      }

      if (path === `/v2/snapshots/${snapshotId}`) {
        return Response.json({ data: snapshotResource });
      }

      return undefined;
    });

    const fn = client.createFunction(
      { id: "sandbox-trace", triggers: [{ event: "sandbox/trace" }] },
      async ({ step }) => {
        const sandbox = await step.sandbox.get("get-box", sandboxId);

        if (!sandbox) {
          throw new Error("Expected sandbox");
        }

        await sandbox.commands.run("test", "npm test");

        return (await sandbox.snapshot({ id: "snap", name: "Snapshot" })).id;
      },
    );

    const [get, exec, snapshot, wait] = await runSteps(fn, 4);

    expect(get?.metadata).toEqual([
      {
        kind: "inngest.sandbox",
        scope: "step",
        op: "merge",
        values: {
          version: 1,
          action: "get",
          method: "get",
          sandbox_id: sandboxId,
          sandbox_name: "ci-box",
        },
      },
    ]);
    expect(sandboxEntries(exec)).toEqual([
      expect.objectContaining({
        action: "exec",
        method: "commands.run",
        sandbox_id: sandboxId,
        command_display: "npm test",
        exit_code: 1,
      }),
    ]);
    expect(sandboxEntries(snapshot)).toEqual([
      expect.objectContaining({
        action: "snapshot.create",
        method: "snapshot.create",
        sandbox_id: sandboxId,
        snapshot_id: snapshotId,
        snapshot_status: "CREATING",
      }),
    ]);
    expect(sandboxEntries(wait)).toEqual([
      expect.objectContaining({
        action: "snapshot.waitUntilReady",
        snapshot_id: snapshotId,
        snapshot_status: "READY",
      }),
    ]);

    // Only the SDK's own steps inside `snapshot()` are marked, not the
    // user's calls or the snapshot span itself
    for (const step of [get, exec]) {
      expect(step?.opts ?? {}).not.toHaveProperty("span");
      expect(step?.opts ?? {}).not.toHaveProperty("origin");
    }

    for (const step of [snapshot, wait]) {
      expect(step?.opts?.span).toStrictEqual([
        { id: "snap", name: "Snapshot" },
      ]);
      expect(step?.opts?.origin).toBe(`inngest@${version}`);
    }

    expect(snapshot?.displayName).toBe("Create snapshot");
    expect(wait?.displayName).toBe("Wait for snapshot");
  });

  test("emits one full entry per step attempt", async () => {
    let execCalls = 0;

    const client = createClient((path) => {
      if (!path.endsWith("/exec")) {
        return undefined;
      }

      execCalls++;

      if (execCalls === 1) {
        return Response.json(
          { errors: [{ code: "sandbox_unavailable", message: "busy" }] },
          { status: 503 },
        );
      }

      return Response.json({
        data: { stdout: "", stderr: "", encoding: "base64", exitCode: 0 },
      });
    });

    const fn = client.createFunction(
      { id: "sandbox-trace-retry", triggers: [{ event: "sandbox/trace" }] },
      async ({ step }) => {
        const sandbox = await step.sandbox.get("get-box", sandboxId);

        if (!sandbox) {
          throw new Error("Expected sandbox");
        }

        await sandbox.commands.run("test", "npm test");
      },
    );

    const [get] = await runSteps(fn, 1);

    if (!get) {
      throw new Error("Expected a step");
    }

    const state = { [get.id]: { id: get.id, data: get.data } };
    const [failed] = await runSteps(fn, 1, state);
    const [succeeded] = await runSteps(fn, 1, state);

    expect(failed?.error).toBeDefined();
    expect(sandboxEntries(failed)).toEqual([
      expect.objectContaining({
        action: "exec",
        error_code: "sandbox_unavailable",
      }),
    ]);

    // Entries are folded as merge patches, so a later entry can't clear a key.
    // Each attempt's entry must stand alone: no error_code once it succeeds.
    expect(succeeded?.id).toBe(failed?.id);
    expect(sandboxEntries(succeeded)).toEqual([
      expect.not.objectContaining({ error_code: expect.anything() }),
    ]);
    expect(sandboxEntries(succeeded)[0]).toMatchObject({
      action: "exec",
      exit_code: 0,
    });
  });
});
