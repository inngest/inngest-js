import { Temporal } from "temporal-polyfill";

import { hashSigningKey } from "../helpers/strings.ts";
import {
  createClient,
  createFnRunner,
  runFnWithStack,
  testClientId,
} from "../test/helpers.ts";
import { StepOpCode } from "../types.ts";
import { Inngest } from "./Inngest.ts";
import {
  createSandboxClient,
  createSandboxTools,
  SandboxError,
  type SandboxOperationResultV1,
  type SandboxOperationV1,
  type SandboxProcessRef,
  type SandboxRawTool,
  type SandboxRef,
  SandboxValidationError,
  sandboxMiddleware,
} from "./InngestSandbox.ts";

const vpcId = "11111111-1111-4111-8111-111111111111";
const sandboxId = "22222222-2222-4222-8222-222222222222";
const processId = "33333333-3333-4333-8333-333333333333";
const now = "2026-07-28T00:00:00Z";

const sandboxRef = {
  kind: "inngest/sandbox",
  version: 1,
  id: sandboxId,
  name: "eval-run-1",
  status: "RUNNING",
  vpcId,
  imageRef: "default",
  resources: { vcpu: 2, memoryMb: 2048 },
  createdAt: now,
  startedAt: now,
} satisfies SandboxRef;

const processRef = {
  kind: "inngest/sandbox.process",
  version: 1,
  sandboxId,
  id: processId,
  command: ["/bin/sh", "-lc", "sleep 30"],
  pid: 42,
  state: "RUNNING",
  startedAt: now,
} satisfies SandboxProcessRef;

const createOptions = {
  name: sandboxRef.name,
  vcpu: 2,
  memoryMb: 2048,
};

const resultForOperation = (
  operation: SandboxOperationV1,
): SandboxOperationResultV1 => {
  switch (operation.action) {
    case "create":
      return { protocolVersion: 1, action: "create", sandbox: sandboxRef };
    case "list":
      return {
        protocolVersion: 1,
        action: "list",
        sandboxes: [sandboxRef],
        page: { hasMore: false, limit: operation.input[0].limit },
        fetchedAt: now,
      };
    case "get":
      return { protocolVersion: 1, action: "get", sandbox: sandboxRef };
    case "exec":
      return {
        protocolVersion: 1,
        action: "exec",
        result: {
          stdout: "b2sK",
          stderr: "",
          encoding: "base64",
          exitCode: 0,
          output: { truncated: false },
        },
      };
    case "destroy":
      return {
        protocolVersion: 1,
        action: "destroy",
        result: {
          status: "TERMINATING",
          sandbox: { ...sandboxRef, status: "TERMINATING" },
        },
      };
    case "process.start":
      return {
        protocolVersion: 1,
        action: "process.start",
        process: processRef,
      };
    case "process.list":
      return {
        protocolVersion: 1,
        action: "process.list",
        processes: [processRef],
        page: { cursor: "next-process-page", hasMore: true, limit: 25 },
        fetchedAt: now,
      };
    case "process.get":
      return {
        protocolVersion: 1,
        action: "process.get",
        process: processRef,
      };
    case "process.signal":
      return {
        protocolVersion: 1,
        action: "process.signal",
        result: null,
      };
    case "process.wait":
      return {
        protocolVersion: 1,
        action: "process.wait",
        process: {
          kind: "inngest/sandbox.process",
          version: 1,
          sandboxId,
          id: processId,
          state: "KILLED",
          terminationSignal: 15,
        },
      };
    case "process.output":
      return {
        protocolVersion: 1,
        action: "process.output",
        result: {
          chunks: [
            {
              stream: "STDOUT",
              data: "AP8=",
              encoding: "base64",
              at: now,
            },
          ],
        },
      };
  }
};

describe("step.sandbox", () => {
  test("uses UUID identity and exposes the complete durable lifecycle", async () => {
    const operations: SandboxOperationV1[] = [];
    const rawTool: SandboxRawTool = vi.fn(async (_id, operation) => {
      operations.push(operation);
      return resultForOperation(operation);
    });
    const tools = createSandboxTools(() => rawTool);

    const created = await tools.create("create", createOptions);
    const listed = await tools.list("list", { limit: 10 });
    const fetched = await tools.get("get", sandboxId);
    const command = await created.commands.run("exec", {
      command: ["/bin/sh", "-lc", "printf ok"],
      environment: { "WITH.DOT": "allowed" },
      timeout: Temporal.Duration.from({ seconds: 1 }),
    });
    const process = await created.processes.start("start", {
      command: processRef.command,
      environment: { "1_NUMERIC": "also-allowed" },
      cwd: "/workspace",
    });
    const processes = await created.processes.list("process-list", {
      cursor: "process-cursor",
      limit: 25,
    });
    await created.processes.get("process-get", processId);
    await process.signal("signal", { signal: 15, includeChildren: true });
    const waited = await process.wait("wait", { timeout: "5s" });
    const output = await process.getOutput("output", { tailBytes: 123 });
    const destroyed = await created.destroy("destroy");

    expect(created).toMatchObject(sandboxRef);
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.resources)).toBe(true);
    expect(Object.isFrozen(created.commands)).toBe(true);
    expect("attach" in tools).toBe(false);
    expect("toJSON" in created).toBe(false);
    expect("toJSON" in process).toBe(false);
    expect("refresh" in created).toBe(false);
    expect("refresh" in process).toBe(false);
    expect(listed.items[0]).toMatchObject(sandboxRef);
    expect(fetched?.id).toBe(sandboxId);
    expect(command).toEqual({
      stdout: new Uint8Array([111, 107, 10]),
      stderr: new Uint8Array(),
      exitCode: 0,
      output: { truncated: false },
    });
    expect(waited).toMatchObject({
      id: processId,
      state: "KILLED",
      terminationSignal: 15,
    });
    expect(processes.items[0]).toMatchObject(processRef);
    expect(processes.page).toEqual({
      cursor: "next-process-page",
      hasMore: true,
      limit: 25,
    });
    expect(processes.fetchedAt).toBe(now);
    expect(Object.isFrozen(waited)).toBe(true);
    expect(Object.isFrozen(waited.command)).toBe(true);
    expect(output.chunks[0]?.data).toEqual(new Uint8Array([0, 255]));
    expect(destroyed).toMatchObject({ status: "TERMINATING" });

    expect(operations.map(({ action }) => action)).toEqual([
      "create",
      "list",
      "get",
      "exec",
      "process.start",
      "process.list",
      "process.get",
      "process.signal",
      "process.wait",
      "process.output",
      "destroy",
    ]);
    expect(operations[3]).toMatchObject({
      action: "exec",
      target: { sandbox: { id: sandboxId } },
      input: [
        {
          command: ["/bin/sh", "-lc", "printf ok"],
          environment: { "WITH.DOT": "allowed" },
          timeoutMs: 1000,
        },
      ],
    });
    expect(operations[4]).toMatchObject({
      action: "process.start",
      target: { sandbox: { id: sandboxId } },
    });
    expect(operations[5]).toMatchObject({
      action: "process.list",
      input: [{ cursor: "process-cursor", limit: 25 }],
    });
    expect(operations[7]).toMatchObject({
      action: "process.signal",
      target: {
        sandbox: { id: sandboxId },
        process: { sandboxId, id: processId },
      },
      input: [{ signal: 15, includeChildren: true }],
    });
  });

  test("validates Simcity limits without imposing identifier-style env keys", async () => {
    const rawTool = vi.fn<SandboxRawTool>(async (_id, operation) =>
      resultForOperation(operation),
    );
    const sandbox = await createSandboxTools(() => rawTool).get(
      "get-sandbox",
      sandboxId,
    );
    if (!sandbox) {
      throw new Error("Expected sandbox");
    }
    rawTool.mockClear();

    await expect(
      sandbox.commands.run("exec", {
        command: ["npm", "test"],
      }),
    ).rejects.toThrow("absolute executable path");
    await expect(
      sandbox.processes.start("start", {
        command: ["/bin/true"],
        environment: { "": "invalid" },
      }),
    ).rejects.toBeInstanceOf(SandboxValidationError);
    expect(rawTool).not.toHaveBeenCalled();
  });

  test("requires explicit middleware opt-in in function input types", () => {
    const client = createClient({ id: testClientId, isDev: true });
    const fn = client.createFunction(
      { id: "sandbox-without-middleware" },
      // @ts-expect-error step.sandbox is added by sandboxMiddleware
      async ({ step }) => step.sandbox.list("list"),
    );

    expect(fn).toBeDefined();
  });

  test("suspends fresh process mutations and rehydrates them on replay", async () => {
    const client = new Inngest({
      id: testClientId,
      isDev: true,
      middleware: [sandboxMiddleware()],
    });
    const fn = client.createFunction(
      { id: "sandbox-process", triggers: [{ event: "sandbox/process" }] },
      async ({ step }) => {
        const sandbox = await step.sandbox.create("create", createOptions);
        const process = await sandbox.processes.start("start", {
          command: processRef.command,
        });
        await process.signal("signal", { signal: 15 });
        return process.id;
      },
    );

    const results: SandboxOperationResultV1[] = [
      { protocolVersion: 1, action: "create", sandbox: sandboxRef },
      {
        protocolVersion: 1,
        action: "process.start",
        process: processRef,
      },
      {
        protocolVersion: 1,
        action: "process.signal",
        result: null,
      },
    ];
    const expectedActions = [
      "create",
      "process.start",
      "process.signal",
    ] as const;
    const state: Record<string, { id: string; data: unknown }> = {};
    const stackOrder: string[] = [];

    for (const [index, action] of expectedActions.entries()) {
      const invocation = await runFnWithStack(fn, state, {
        stackOrder,
        disableImmediateExecution: true,
      });
      expect(invocation.type).toBe("steps-found");
      if (invocation.type !== "steps-found") {
        throw new Error(`Expected steps-found, got ${invocation.type}`);
      }
      const outgoing = invocation.steps[0];
      if (!outgoing) {
        throw new Error(`Missing ${action} operation`);
      }
      expect(outgoing).toMatchObject({
        op: StepOpCode.StepPlanned,
        opts: {
          input: [{ protocolVersion: 1, action }],
        },
      });
      state[outgoing.id] = { id: outgoing.id, data: results[index] };
      stackOrder.push(outgoing.id);
    }

    await expect(
      runFnWithStack(fn, state, {
        stackOrder,
        disableImmediateExecution: true,
      }),
    ).resolves.toMatchObject({
      type: "function-resolved",
      data: processId,
    });
  });

  test("executes through REST in an ordinary run step and memoizes the result", async () => {
    const { kind: _kind, version: _version, ...sandboxResource } = sandboxRef;
    const fetchMock: typeof fetch = vi.fn(async () =>
      Response.json({ data: sandboxResource }, { status: 201 }),
    );
    const client = new Inngest({
      id: testClientId,
      signingKey: "signkey-test",
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
      middleware: [sandboxMiddleware()],
    });
    const fn = client.createFunction(
      { id: "sandbox-create", triggers: [{ event: "sandbox/create" }] },
      async ({ step }) =>
        (await step.sandbox.create("create", createOptions)).id,
    );
    const run = createFnRunner(fn);

    const first = await run();
    expect(first.result).toMatchObject({
      type: "step-ran",
      step: {
        op: StepOpCode.StepRun,
        data: {
          protocolVersion: 1,
          action: "create",
          sandbox: sandboxRef,
        },
      },
    });

    const replay = await run();
    expect(replay.result).toMatchObject({
      type: "function-resolved",
      data: sandboxId,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("keeps larger direct Exec results but tail-truncates them at the durable step boundary", async () => {
    const threeMiBBase64 = `AQID${"AAAA".repeat((1 << 20) - 1)}`;
    const oneMiBBase64 = `${"AAAA".repeat(349_525)}AA==`;
    const { kind: _kind, version: _version, ...sandboxResource } = sandboxRef;
    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (
        url.pathname === `/v2/sandboxes/${sandboxId}` &&
        (init?.method ?? "GET") === "GET"
      ) {
        return Response.json({ data: sandboxResource });
      }
      return Response.json({
        data: {
          stdout: threeMiBBase64,
          stderr: oneMiBBase64,
          encoding: "base64",
          exitCode: 0,
        },
      });
    });
    const client = new Inngest({
      id: testClientId,
      signingKey: "signkey-test",
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
      middleware: [sandboxMiddleware()],
    });

    const directSandbox = await client.sandboxes.get(sandboxId);
    if (!directSandbox) {
      throw new Error("Expected sandbox");
    }
    const direct = await directSandbox.commands.run({
      command: ["/bin/true"],
    });
    expect(direct.stdout).toHaveLength(3 << 20);
    expect(direct.stderr).toHaveLength(1 << 20);
    expect(direct.stdout.slice(0, 3)).toEqual(new Uint8Array([1, 2, 3]));
    expect(direct.output).toEqual({ truncated: false });

    const fn = client.createFunction(
      { id: "sandbox-exec-limit", triggers: [{ event: "sandbox/exec-limit" }] },
      async ({ step }) => {
        const sandbox = await step.sandbox.get("get-sandbox", sandboxId);
        if (!sandbox) {
          throw new Error("Expected sandbox");
        }
        const result = await sandbox.commands.run("exec", {
          command: ["/bin/true"],
        });
        return {
          stdoutBytes: result.stdout.byteLength,
          stderrBytes: result.stderr.byteLength,
          firstStdoutByte: result.stdout[0],
          output: result.output,
        };
      },
    );

    const getStep = await runFnWithStack(fn, {});
    expect(getStep).toMatchObject({
      type: "step-ran",
      step: {
        op: StepOpCode.StepRun,
        data: {
          protocolVersion: 1,
          action: "get",
          sandbox: sandboxRef,
        },
      },
    });
    if (getStep.type !== "step-ran") {
      throw new Error(`Expected step-ran, got ${getStep.type}`);
    }
    const getState = {
      [getStep.step.id]: {
        id: getStep.step.id,
        data: getStep.step.data,
      },
    };
    const execStep = await runFnWithStack(fn, getState, {
      stackOrder: [getStep.step.id],
    });
    expect(execStep).toMatchObject({
      type: "step-ran",
      step: {
        op: StepOpCode.StepRun,
        data: {
          protocolVersion: 1,
          action: "exec",
          result: {
            output: {
              truncated: true,
              strategy: "tail",
              originalBytes: {
                stdout: 3 << 20,
                stderr: 1 << 20,
              },
              retainedBytes: {
                stdout: 1 << 20,
                stderr: 1 << 20,
              },
            },
          },
        },
      },
    });
    if (execStep.type !== "step-ran") {
      throw new Error(`Expected step-ran, got ${execStep.type}`);
    }

    await expect(
      runFnWithStack(
        fn,
        {
          ...getState,
          [execStep.step.id]: {
            id: execStep.step.id,
            data: execStep.step.data,
          },
        },
        { stackOrder: [getStep.step.id, execStep.step.id] },
      ),
    ).resolves.toMatchObject({
      type: "function-resolved",
      data: {
        stdoutBytes: 1 << 20,
        stderrBytes: 1 << 20,
        firstStdoutByte: 0,
        output: {
          truncated: true,
          strategy: "tail",
          originalBytes: {
            stdout: 3 << 20,
            stderr: 1 << 20,
          },
          retainedBytes: {
            stdout: 1 << 20,
            stderr: 1 << 20,
          },
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test("reconstructs a non-retriable SandboxError from a failed run step", async () => {
    const fetchMock: typeof fetch = vi.fn(async () =>
      Response.json(
        {
          errors: [
            {
              code: "operation_ambiguous",
              message: "The sandbox may have been created",
            },
          ],
        },
        { status: 409 },
      ),
    );
    const client = new Inngest({
      id: testClientId,
      signingKey: "signkey-test",
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
      middleware: [sandboxMiddleware()],
    });
    const fn = client.createFunction(
      { id: "sandbox-error", triggers: [{ event: "sandbox/error" }] },
      async ({ step }) => {
        try {
          await step.sandbox.create("create", createOptions);
          return null;
        } catch (error) {
          return error instanceof SandboxError
            ? {
                name: error.name,
                action: error.action,
                code: error.code,
                ambiguous: error.ambiguous,
                retryable: error.retryable,
              }
            : {
                name: error instanceof Error ? error.name : typeof error,
                message: error instanceof Error ? error.message : String(error),
              };
        }
      },
    );

    const first = await runFnWithStack(fn, {});
    expect(first).toMatchObject({
      type: "step-ran",
      retriable: false,
      step: {
        op: StepOpCode.StepFailed,
      },
    });
    if (first.type !== "step-ran") {
      throw new Error(`Expected step-ran, got ${first.type}`);
    }

    const replay = await runFnWithStack(
      fn,
      {
        [first.step.id]: {
          id: first.step.id,
          data: undefined,
          error: first.step.error,
        },
      },
      { stackOrder: [first.step.id] },
    );
    expect(replay).toMatchObject({
      type: "function-resolved",
      data: {
        name: "SandboxError",
        action: "create",
        code: "operation_ambiguous",
        ambiguous: true,
        retryable: false,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("keeps availability failures retryable and reconstructs them after exhaustion", async () => {
    const fetchMock: typeof fetch = vi.fn(async () => {
      throw new TypeError("connection refused");
    });
    const client = new Inngest({
      id: testClientId,
      signingKey: "signkey-test",
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
      middleware: [sandboxMiddleware()],
    });
    const fn = client.createFunction(
      {
        id: "sandbox-retryable-error",
        triggers: [{ event: "sandbox/retryable-error" }],
      },
      async ({ step }) => {
        try {
          await step.sandbox.list("list");
          return null;
        } catch (error) {
          return error instanceof SandboxError
            ? {
                name: error.name,
                action: error.action,
                code: error.code,
                ambiguous: error.ambiguous,
                retryable: error.retryable,
              }
            : {
                name: error instanceof Error ? error.name : typeof error,
              };
        }
      },
    );

    const first = await runFnWithStack(fn, {});
    expect(first).toMatchObject({
      type: "step-ran",
      retriable: true,
      step: {
        op: StepOpCode.StepError,
      },
    });
    if (first.type !== "step-ran") {
      throw new Error(`Expected step-ran, got ${first.type}`);
    }

    const replay = await runFnWithStack(
      fn,
      {
        [first.step.id]: {
          id: first.step.id,
          data: undefined,
          error: first.step.error,
        },
      },
      { stackOrder: [first.step.id] },
    );
    expect(replay).toMatchObject({
      type: "function-resolved",
      data: {
        name: "SandboxError",
        action: "list",
        code: "compute_unavailable",
        ambiguous: false,
        retryable: true,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("maps a structured executor failure without making all errors non-retriable", async () => {
    const rawTool: SandboxRawTool = async (_id, operation) => {
      if (operation.action === "get") {
        return resultForOperation(operation);
      }
      throw {
        cause: {
          protocolVersion: 1,
          action: "process.start",
          code: "operation_ambiguous",
          message: "Result is ambiguous",
          sandboxId,
          ambiguous: true,
          retryable: false,
          details: [],
        },
      };
    };
    const sandbox = await createSandboxTools(() => rawTool).get(
      "get-sandbox",
      sandboxId,
    );
    if (!sandbox) {
      throw new Error("Expected sandbox");
    }
    const error = await sandbox.processes
      .start("start", { command: ["/bin/true"] })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(SandboxError);
    expect(error).toMatchObject({
      action: "process.start",
      code: "operation_ambiguous",
      sandboxId,
      ambiguous: true,
      retryable: false,
    });
  });
});

describe("inngest.sandboxes", () => {
  test("forwards the complete direct REST lifecycle", async () => {
    const {
      kind: _sandboxKind,
      version: _sandboxVersion,
      ...sandboxData
    } = sandboxRef;
    const {
      kind: _processKind,
      version: _processVersion,
      sandboxId: _processSandboxId,
      ...processData
    } = processRef;
    const sandboxPath = `/v2/sandboxes/${sandboxId}`;
    const processPath = `${sandboxPath}/processes/${processId}`;
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const method = init?.method ?? "GET";
      calls.push({ url, init });

      if (url.pathname === "/v2/sandboxes" && method === "GET") {
        return Response.json({
          data: [
            {
              ...sandboxData,
              resources: {
                ...sandboxData.resources,
                futureResourceField: true,
              },
              futureSandboxField: true,
            },
          ],
          metadata: { fetchedAt: now, futureMetadataField: true },
          page: {
            cursor: null,
            hasMore: false,
            limit: 10,
            futurePageField: true,
          },
        });
      }
      if (url.pathname === sandboxPath && method === "GET") {
        return Response.json({
          data: { ...sandboxData, futureSandboxField: true },
        });
      }
      if (url.pathname === `${sandboxPath}/exec` && method === "POST") {
        return Response.json({
          data: {
            stdout: "AP8=",
            stderr: "ZXJyCg==",
            encoding: "base64",
            exitCode: 7,
            futureExecField: true,
          },
        });
      }
      if (url.pathname === `${sandboxPath}/logs` && method === "GET") {
        return new Response(
          `${JSON.stringify({
            type: "log",
            stream: "STDERR",
            data: "AP8=",
            encoding: "base64",
            at: now,
            futureChunkField: true,
          })}\n`,
        );
      }
      if (url.pathname === `${sandboxPath}/files` && method === "PUT") {
        return Response.json({
          data: {
            path: "/tmp/result.bin",
            bytesWritten: 2,
            futureUploadField: true,
          },
        });
      }
      if (url.pathname === `${sandboxPath}/files` && method === "GET") {
        return new Response(new Uint8Array([0, 255]), {
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
      if (url.pathname === `${sandboxPath}/processes` && method === "POST") {
        return Response.json(
          { data: { ...processData, futureProcessField: true } },
          { status: 201 },
        );
      }
      if (url.pathname === `${sandboxPath}/processes` && method === "GET") {
        return Response.json({
          data: [{ ...processData, futureProcessField: true }],
          metadata: { fetchedAt: now, futureMetadataField: true },
          page: {
            cursor: "next-process-page",
            hasMore: true,
            limit: 25,
            futurePageField: true,
          },
        });
      }
      if (url.pathname === processPath && method === "GET") {
        return Response.json({
          data: { ...processData, futureProcessField: true },
        });
      }
      if (url.pathname === `${processPath}/signals` && method === "POST") {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === `${processPath}/wait` && method === "POST") {
        return Response.json({
          data: {
            id: processId,
            state: "EXITED",
            exitCode: 0,
            futureWaitField: true,
          },
        });
      }
      if (url.pathname === `${processPath}/output` && method === "GET") {
        return Response.json({
          data: {
            chunks: [
              {
                stream: "STDOUT",
                data: "AP8=",
                encoding: "base64",
                at: now,
                futureChunkField: true,
              },
            ],
          },
        });
      }
      if (url.pathname === sandboxPath && method === "DELETE") {
        return Response.json(
          { data: { ...sandboxData, status: "TERMINATING" } },
          { status: 202 },
        );
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    const inngest = createClient({
      id: testClientId,
      signingKey: "signkey-test",
      baseUrl: "https://api.example.test",
      env: "branch",
      fetch: fetchMock,
    });

    const listed = await inngest.sandboxes.list({
      cursor: "opaque",
      limit: 10,
    });
    const sandbox = await inngest.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error("Expected sandbox");
    }
    const command = await sandbox.commands.run({
      command: ["/bin/sh", "-lc", "printf ok"],
      timeout: "1s",
    });
    const logReader = (await sandbox.logs.stream({ follow: true })).getReader();
    const log = await logReader.read();
    const upload = await sandbox.files.upload({
      path: "/tmp/result.bin",
      data: new Uint8Array([0, 255]),
      mode: 0o640,
    });
    const download = await sandbox.files.download({
      path: "/tmp/result.bin",
    });
    const started = await sandbox.processes.start({
      command: processRef.command,
    });
    const processes = await sandbox.processes.list({
      cursor: "process-cursor",
      limit: 25,
    });
    const fetchedProcess = await sandbox.processes.get(processId);
    await started.signal({ signal: 15, includeChildren: true });
    const waited = await started.wait({ timeout: "2s" });
    const output = await started.getOutput({ tailBytes: 64 });
    const destroyed = await sandbox.destroy();

    expect(listed.items[0]).toMatchObject(sandboxRef);
    expect(sandbox).toMatchObject(sandboxRef);
    expect("attach" in inngest.sandboxes).toBe(false);
    expect("toJSON" in sandbox).toBe(false);
    expect("toJSON" in started).toBe(false);
    expect("refresh" in sandbox).toBe(false);
    expect(command).toEqual({
      stdout: new Uint8Array([0, 255]),
      stderr: new TextEncoder().encode("err\n"),
      exitCode: 7,
      output: { truncated: false },
    });
    expect(log).toEqual({
      done: false,
      value: {
        stream: "STDERR",
        data: new Uint8Array([0, 255]),
        at: now,
      },
    });
    expect(upload).toEqual({ path: "/tmp/result.bin", bytesWritten: 2 });
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(
      new Uint8Array([0, 255]),
    );
    expect(started).toMatchObject(processRef);
    expect("refresh" in started).toBe(false);
    expect(processes.items[0]).toMatchObject(processRef);
    expect(processes.page).toEqual({
      cursor: "next-process-page",
      hasMore: true,
      limit: 25,
    });
    expect(processes.fetchedAt).toBe(now);
    expect(fetchedProcess).toMatchObject(processRef);
    expect(waited).toMatchObject({
      id: processId,
      state: "EXITED",
      exitCode: 0,
    });
    expect(output.chunks[0]?.data).toEqual(new Uint8Array([0, 255]));
    expect(destroyed).toMatchObject({
      status: "TERMINATING",
      sandbox: { id: sandboxId, status: "TERMINATING" },
    });

    expect(
      calls.find(
        ({ url, init }) =>
          url.pathname.endsWith("/files") && init?.method === "PUT",
      )?.url.search,
    ).toBe("?path=%2Ftmp%2Fresult.bin&mode=0640");
    expect(calls[0]?.url.search).toBe("?limit=10&cursor=opaque");
    expect(
      calls.find(
        ({ url, init }) =>
          url.pathname.endsWith("/processes") && init?.method === "GET",
      )?.url.search,
    ).toBe("?limit=25&cursor=process-cursor");
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: `Bearer ${hashSigningKey("signkey-test")}`,
      "x-inngest-env": "branch",
    });
  });

  test("uses the REST v2 resource shape and decodes byte-safe streams", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      calls.push({ url, init });

      if (url.pathname === "/v2/sandboxes" && init?.method === "POST") {
        return Response.json(
          { data: { ...sandboxRef, kind: undefined, version: undefined } },
          { status: 201 },
        );
      }
      if (url.pathname.endsWith("/processes") && init?.method === "POST") {
        const {
          kind: _kind,
          version: _version,
          sandboxId: _sandbox,
          ...data
        } = processRef;
        return Response.json({ data }, { status: 201 });
      }
      if (url.pathname.endsWith("/output/stream")) {
        return new Response(
          [
            JSON.stringify({
              type: "log",
              stream: "STDOUT",
              data: "AP8=",
              encoding: "base64",
              at: now,
            }),
            "",
          ].join("\n"),
          { headers: { "Content-Type": "application/x-ndjson" } },
        );
      }
      throw new Error(`Unexpected request: ${init?.method} ${url}`);
    });
    const client = createSandboxClient({
      baseUrl: () => "https://api.example.test",
      apiKey: () => "signkey-test",
      headers: () => ({ "X-Inngest-Env": "test" }),
      fetch: () => fetchMock,
    });

    const sandbox = await client.create(createOptions);
    const process = await sandbox.processes.start({
      command: processRef.command,
    });
    const stream = await process.streamOutput({ tailBytes: 42 });
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      chunks.push(next.value.data);
    }

    expect(sandbox).toMatchObject(sandboxRef);
    expect(process).toMatchObject(processRef);
    expect(chunks).toEqual([new Uint8Array([0, 255])]);
    expect(calls.map(({ url }) => `${url.pathname}${url.search}`)).toEqual([
      "/v2/sandboxes",
      `/v2/sandboxes/${sandboxId}/processes`,
      `/v2/sandboxes/${sandboxId}/processes/${processId}/output/stream?tailBytes=42`,
    ]);
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer signkey-test",
      "X-Inngest-Env": "test",
    });
  });

  test.each([
    [413, "sandbox_exec_output_too_large"],
    [504, "sandbox_exec_timed_out"],
  ])(
    "marks an incomplete captured Exec result as ambiguous (%s)",
    async (status, code) => {
      let requestCount = 0;
      const { kind: _kind, version: _version, ...sandboxResource } = sandboxRef;
      const client = createSandboxClient({
        baseUrl: () => "https://api.example.test",
        apiKey: () => "key",
        headers: () => ({}),
        fetch: () => async () => {
          requestCount++;
          if (requestCount === 1) {
            return Response.json({ data: sandboxResource });
          }
          return Response.json(
            {
              errors: [
                {
                  code,
                  message: "The command may have executed",
                },
              ],
            },
            { status },
          );
        },
      });

      const sandbox = await client.get(sandboxId);
      if (!sandbox) {
        throw new Error("Expected sandbox");
      }
      await expect(
        sandbox.commands.run({
          command: ["/bin/true"],
        }),
      ).rejects.toMatchObject({
        name: "SandboxError",
        action: "exec",
        code,
        ambiguous: true,
        retryable: false,
      });
    },
  );

  test("turns a terminal NDJSON error frame into a SandboxError", async () => {
    let requestCount = 0;
    const fetchMock: typeof fetch = vi.fn(async () => {
      requestCount++;
      if (requestCount === 1) {
        const { kind: _kind, version: _version, ...data } = sandboxRef;
        return Response.json({ data });
      }
      if (requestCount === 2) {
        const {
          kind: _kind,
          version: _version,
          sandboxId: _sandbox,
          ...data
        } = processRef;
        return Response.json({ data });
      }
      return new Response(
        `${JSON.stringify({
          type: "error",
          error: {
            code: "compute_unavailable",
            message: "node disconnected",
          },
        })}\n`,
        { headers: { "Content-Type": "application/x-ndjson" } },
      );
    });
    const client = createSandboxClient({
      baseUrl: () => "https://api.example.test",
      apiKey: () => "key",
      headers: () => ({}),
      fetch: () => fetchMock,
    });
    const sandbox = await client.get(sandboxId);
    const process = await sandbox?.processes.get(processId);
    const stream = await process?.streamOutput();

    await expect(stream?.getReader().read()).rejects.toMatchObject({
      name: "SandboxError",
      action: "process.stream",
      code: "compute_unavailable",
      retryable: true,
    });
  });

  test("aborts the HTTP response when a direct stream is cancelled", async () => {
    let requestCount = 0;
    let streamSignal: AbortSignal | undefined;
    let responseCancelled = false;
    const fetchMock: typeof fetch = vi.fn(async (_input, init) => {
      requestCount++;
      if (requestCount === 1) {
        const { kind: _kind, version: _version, ...data } = sandboxRef;
        return Response.json({ data });
      }
      if (requestCount === 2) {
        const {
          kind: _kind,
          version: _version,
          sandboxId: _sandbox,
          ...data
        } = processRef;
        return Response.json({ data });
      }
      streamSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          cancel: () => {
            responseCancelled = true;
          },
        }),
      );
    });
    const client = createSandboxClient({
      baseUrl: () => "https://api.example.test",
      apiKey: () => "key",
      headers: () => ({}),
      fetch: () => fetchMock,
    });
    const sandbox = await client.get(sandboxId);
    const process = await sandbox?.processes.get(processId);
    const stream = await process?.streamOutput();

    await stream?.cancel();

    expect(streamSignal?.aborted).toBe(true);
    expect(responseCancelled).toBe(true);
  });
});
