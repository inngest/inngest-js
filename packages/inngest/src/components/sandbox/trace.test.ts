import hashjs from "hash.js";
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { sandboxMiddleware } from "./middleware.ts";
import { parseSandboxOperation } from "./protocol.ts";
import { withSandboxStatement } from "./statement.ts";
import { sandboxTraceMetadata } from "./trace.ts";

const { sha1 } = hashjs;

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
  });
});

describe("withSandboxStatement", () => {
  const processId = "55555555-5555-4555-8555-555555555555";
  const statementId = sha1().update("test").digest("hex");

  test("names the statement on every step in its scope", () => {
    const operation = parseSandboxOperation({
      protocolVersion: 1,
      action: "process.get",
      target: { sandbox: sandboxRef, processId },
      input: [],
    });
    const statementScope = {
      statementId,
      statementName: "test",
      statement: "commands.run",
      sandbox: { id: sandboxId, name: "ci-box" },
    };

    expect(
      sandboxTraceMetadata({
        operation,
        trace: { statement: "processes.get" },
        stepId: "step-check",
        statementScope,
        outcome: {
          result: { protocolVersion: 1, action: "process.get", process: null },
        },
      }),
    ).toEqual({
      version: 1,
      action: "process.get",
      statement: "commands.run",
      statement_id: statementId,
      role: "internal",
      statement_name: "test",
      sandbox_id: sandboxId,
      sandbox_name: "ci-box",
      process_id: processId,
    });

    // A step whose ID is the statement's is the statement's own row.
    expect(
      sandboxTraceMetadata({
        operation,
        trace: { statement: "processes.get" },
        stepId: statementId,
        statementScope,
        outcome: { error: undefined },
      }).role,
    ).toBe("statement");
  });

  test("groups a command's start, sleeps and polls under one statement", async () => {
    const { kind: _kind, version: _version, ...sandboxResource } = sandboxRef;
    const processResource = {
      id: processId,
      command: ["npm", "test"],
      pid: 7,
      state: "RUNNING",
      startedAt: now,
    };
    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const method = init?.method ?? "GET";
      if (url.pathname === `/v2/sandboxes/${sandboxId}` && method === "GET") {
        return Response.json({ data: sandboxResource });
      }
      if (url.pathname === `/v2/sandboxes/${sandboxId}/processes`) {
        return Response.json({ data: processResource }, { status: 201 });
      }
      if (
        url.pathname === `/v2/sandboxes/${sandboxId}/processes/${processId}`
      ) {
        return Response.json({ data: processResource });
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
      { id: "sandbox-statement", triggers: [{ event: "sandbox/statement" }] },
      async ({ step }) => {
        const sandbox = await step.sandbox.get("get-box", sandboxId);
        if (!sandbox) {
          throw new Error("Expected sandbox");
        }
        await withSandboxStatement(
          { id: "test", statement: "commands.run", sandbox },
          async () => {
            const process = await sandbox.processes.start("test › start", {
              command: ["npm", "test"],
            });
            await step.sleep("test › wait #1", "1s");
            await sandbox.processes.get("test › check #1", process.id);
          },
        );
        await step.sleep("after", "1s");
      },
    );

    const ran: Array<{ id: string; metadata?: unknown; opts?: unknown }> = [];
    let state: Record<string, { id: string; data: unknown }> = {};
    for (let i = 0; i < 5; i++) {
      const result = await runFnWithStack(fn, state, {
        stackOrder: ran.map(({ id }) => id),
      });
      const step =
        result.type === "step-ran"
          ? result.step
          : result.type === "steps-found"
            ? result.steps[0]
            : undefined;
      if (!step) {
        throw new Error(`Expected a step, got ${result.type}`);
      }
      ran.push({ id: step.id, metadata: step.metadata, opts: step.opts });
      state = { ...state, [step.id]: { id: step.id, data: step.data ?? null } };
    }

    const [get, start, wait, check, after] = ran;
    expect(get?.metadata).toMatchObject([
      { values: { action: "get", role: "statement", statement_id: get?.id } },
    ]);
    expect(start?.metadata).toEqual([
      {
        kind: "inngest.sandbox",
        scope: "step",
        op: "merge",
        values: {
          version: 1,
          action: "process.start",
          statement: "commands.run",
          statement_id: statementId,
          role: "internal",
          statement_name: "test",
          sandbox_id: sandboxId,
          sandbox_name: "ci-box",
          command: ["npm", "test"],
          process_id: processId,
          process_state: "RUNNING",
        },
      },
    ]);
    expect(wait?.opts).toMatchObject({
      sandboxStatement: {
        statement: "commands.run",
        statement_id: statementId,
        statement_name: "test",
        sandbox_id: sandboxId,
        sandbox_name: "ci-box",
      },
    });
    expect(check?.metadata).toMatchObject([
      {
        values: {
          action: "process.get",
          statement: "commands.run",
          statement_id: statementId,
          role: "internal",
          statement_name: "test",
          process_id: processId,
        },
      },
    ]);
    expect(after?.opts).not.toHaveProperty("sandboxStatement");
  });
});
