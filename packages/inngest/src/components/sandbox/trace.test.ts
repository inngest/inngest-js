import { runFnWithStack, testClientId } from "../../test/helpers.ts";
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
      sandboxTraceMetadata({
        operation,
        trace: { statement: "commands.run" },
        stepId: "step-exec",
        outcome: {
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
        },
      }),
    ).toEqual({
      version: 1,
      action: "exec",
      statement: "commands.run",
      statement_id: "step-exec",
      role: "statement",
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

    const metadata = sandboxTraceMetadata({
      operation,
      trace: { statement: "processes.start" },
      stepId: "step-start",
      outcome: { error: { code: "sandbox_unavailable" } },
    });

    expect(metadata.command_truncated).toBe(true);
    expect(metadata.command?.join("").length).toBe(1_024);
    expect(metadata.command_display).toBeUndefined();
    expect(metadata.error_code).toBe("sandbox_unavailable");
    expect(metadata.process_id).toBeUndefined();
  });

  test("identifies the machine from the operation, even when it fails", () => {
    // The machine may have been created outside this run, so its identity
    // must come from the reference the operation targets, not a result.
    const failed = sandboxTraceMetadata({
      operation: parseSandboxOperation({
        protocolVersion: 1,
        action: "resume",
        target: { sandbox: sandboxRef },
        input: [{ timeoutMs: 1_000 }],
      }),
      trace: { statement: "resume" },
      stepId: "step-resume",
      outcome: { error: undefined },
    });
    expect(failed).toMatchObject({
      sandbox_id: sandboxId,
      sandbox_name: "ci-box",
    });

    const missing = sandboxTraceMetadata({
      operation: parseSandboxOperation({
        protocolVersion: 1,
        action: "get",
        input: [{ sandboxId }],
      }),
      trace: { statement: "get" },
      stepId: "step-get",
      outcome: { result: { protocolVersion: 1, action: "get", sandbox: null } },
    });
    expect(missing.sandbox_id).toBe(sandboxId);
  });

  test("points an internal step at its statement and machine", () => {
    const operation = parseSandboxOperation({
      protocolVersion: 1,
      action: "snapshot.waitUntilReady",
      target: {
        snapshot: {
          kind: "inngest/sandbox.snapshot",
          version: 1,
          ...snapshotResource,
        },
      },
      input: [{ timeoutMs: 1_000 }],
    });

    expect(
      sandboxTraceMetadata({
        operation,
        trace: {
          statement: "snapshot",
          statementOperation: operation,
          sandbox: { id: sandboxId, name: "ci-box" },
        },
        stepId: "step-wait",
        statementId: "step-snapshot",
        outcome: { error: undefined },
      }),
    ).toEqual({
      version: 1,
      action: "snapshot.waitUntilReady",
      statement: "snapshot",
      statement_id: "step-snapshot",
      role: "internal",
      sandbox_id: sandboxId,
      sandbox_name: "ci-box",
      snapshot_id: snapshotId,
    });
  });
});

describe("step.sandbox trace metadata", () => {
  test("describes each step and ties a snapshot's wait to its statement", async () => {
    const { kind: _kind, version: _version, ...sandboxResource } = sandboxRef;
    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const method = init?.method ?? "GET";
      if (url.pathname === `/v2/sandboxes/${sandboxId}` && method === "GET") {
        return Response.json({ data: sandboxResource });
      }
      if (url.pathname.endsWith("/exec")) {
        return Response.json({
          data: { stdout: "", stderr: "", encoding: "base64", exitCode: 1 },
        });
      }
      if (url.pathname === `/v2/sandboxes/${sandboxId}/snapshots`) {
        return Response.json(
          { data: { ...snapshotResource, status: "CREATING" } },
          { status: 202 },
        );
      }
      if (url.pathname === `/v2/snapshots/${snapshotId}`) {
        return Response.json({ data: snapshotResource });
      }
      return Response.json(
        { errors: [{ code: "missing", message: "missing" }] },
        { status: 404 },
      );
    });
    const client = new Inngest({
      id: testClientId,
      signingKey: "signkey-test",
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
      middleware: [sandboxMiddleware()],
    });
    const fn = client.createFunction(
      { id: "sandbox-trace", triggers: [{ event: "sandbox/trace" }] },
      async ({ step }) => {
        const sandbox = await step.sandbox.get("get-box", sandboxId);
        if (!sandbox) {
          throw new Error("Expected sandbox");
        }
        await sandbox.commands.run("test", "npm test");
        return (await sandbox.snapshot("snap")).id;
      },
    );

    const ran: Array<{ id: string; metadata?: unknown }> = [];
    let state: Record<string, { id: string; data: unknown }> = {};
    for (let i = 0; i < 4; i++) {
      const result = await runFnWithStack(fn, state, {
        stackOrder: ran.map(({ id }) => id),
      });
      if (result.type !== "step-ran") {
        throw new Error(`Expected step-ran, got ${result.type}`);
      }
      ran.push({ id: result.step.id, metadata: result.step.metadata });
      state = {
        ...state,
        [result.step.id]: { id: result.step.id, data: result.step.data },
      };
    }

    const [get, exec, snapshot, wait] = ran;
    expect(get?.metadata).toEqual([
      {
        kind: "inngest.sandbox",
        scope: "step",
        op: "merge",
        values: {
          version: 1,
          action: "get",
          statement: "get",
          statement_id: get?.id,
          role: "statement",
          sandbox_id: sandboxId,
          sandbox_name: "ci-box",
        },
      },
    ]);
    expect(exec?.metadata).toMatchObject([
      {
        values: {
          action: "exec",
          statement: "commands.run",
          statement_id: exec?.id,
          role: "statement",
          sandbox_id: sandboxId,
          command_display: "npm test",
          exit_code: 1,
        },
      },
    ]);
    expect(snapshot?.metadata).toMatchObject([
      {
        values: {
          action: "snapshot.create",
          statement: "snapshot",
          statement_id: snapshot?.id,
          role: "statement",
          sandbox_id: sandboxId,
          snapshot_id: snapshotId,
          snapshot_status: "CREATING",
        },
      },
    ]);
    expect(wait?.metadata).toMatchObject([
      {
        values: {
          action: "snapshot.waitUntilReady",
          statement: "snapshot",
          statement_id: snapshot?.id,
          role: "internal",
          sandbox_id: sandboxId,
          sandbox_name: "ci-box",
          snapshot_id: snapshotId,
          snapshot_status: "READY",
        },
      },
    ]);
    expect(wait?.id).not.toBe(snapshot?.id);

    for (const step of ran) {
      expect(step.id).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(snapshot?.id).not.toBe("snap");
  });

  test("emits one full entry per step attempt", async () => {
    const { kind: _kind, version: _version, ...sandboxResource } = sandboxRef;
    let execCalls = 0;
    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const method = init?.method ?? "GET";
      if (url.pathname === `/v2/sandboxes/${sandboxId}` && method === "GET") {
        return Response.json({ data: sandboxResource });
      }
      if (url.pathname.endsWith("/exec")) {
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
      }
      return Response.json(
        { errors: [{ code: "missing", message: "missing" }] },
        { status: 404 },
      );
    });
    const client = new Inngest({
      id: testClientId,
      signingKey: "signkey-test",
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
      middleware: [sandboxMiddleware()],
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

    const first = await runFnWithStack(fn, {});
    if (first.type !== "step-ran") {
      throw new Error(`Expected step-ran, got ${first.type}`);
    }
    const state = {
      [first.step.id]: { id: first.step.id, data: first.step.data },
    };

    const attempts = [];
    for (let i = 0; i < 2; i++) {
      const result = await runFnWithStack(fn, state);
      if (result.type !== "step-ran") {
        throw new Error(`Expected step-ran, got ${result.type}`);
      }
      attempts.push(result.step);
    }

    const sandboxEntries = (metadata: unknown) => {
      return ((metadata ?? []) as Array<{ kind: string; values: object }>)
        .filter(({ kind }) => {
          return kind === "inngest.sandbox";
        })
        .map(({ values }) => {
          return values;
        });
    };

    const [failed, succeeded] = attempts;
    expect(failed?.error).toBeDefined();
    expect(sandboxEntries(failed?.metadata)).toEqual([
      expect.objectContaining({
        action: "exec",
        statement_id: failed?.id,
        error_code: "sandbox_unavailable",
      }),
    ]);

    // Entries are folded as merge patches, so a later entry can't clear a key.
    // Each attempt's entry must stand alone: no error_code once it succeeds.
    expect(succeeded?.id).toBe(failed?.id);
    const [success] = sandboxEntries(succeeded?.metadata);
    expect(sandboxEntries(succeeded?.metadata)).toHaveLength(1);
    expect(success).toMatchObject({
      action: "exec",
      statement_id: succeeded?.id,
      exit_code: 0,
    });
    expect(success).not.toHaveProperty("error_code");
  });
});
