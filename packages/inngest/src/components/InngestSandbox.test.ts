import { Temporal } from "temporal-polyfill";

import {
  createClient,
  getStepTools,
  runFnWithStack,
  testClientId,
} from "../test/helpers.ts";
import { StepMode, StepOpCode } from "../types.ts";
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
} from "./InngestSandbox.ts";
import {
  step as deferredStep,
  type SandboxStepTools,
  sandboxStepToolSymbol,
} from "./InngestStepTools.ts";

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
    await created.processes.list("process-list");
    await created.processes.get("process-get", processId);
    await process.refresh("process-refresh");
    await process.signal("signal", { signal: 15, includeChildren: true });
    const waited = await process.wait("wait", { timeout: "5s" });
    const output = await process.getOutput("output", { tailBytes: 123 });
    const destroyed = await created.destroy("destroy");

    expect(created.toJSON()).toEqual(sandboxRef);
    expect(JSON.parse(JSON.stringify(created))).toEqual(sandboxRef);
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.resources)).toBe(true);
    expect(Object.isFrozen(created.commands)).toBe(true);
    expect(listed.items[0]?.toJSON()).toEqual(sandboxRef);
    expect(fetched?.id).toBe(sandboxId);
    expect(command).toEqual({
      stdout: new Uint8Array([111, 107, 10]),
      stderr: new Uint8Array(),
      exitCode: 0,
    });
    expect(waited.toJSON()).toMatchObject({
      id: processId,
      state: "KILLED",
      terminationSignal: 15,
    });
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
      "process.get",
      "process.signal",
      "process.wait",
      "process.output",
      "destroy",
    ]);
    expect(operations[3]).toMatchObject({
      action: "exec",
      target: { sandboxId },
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
      target: { sandboxId },
    });
    expect(operations[8]).toMatchObject({
      action: "process.signal",
      target: { sandboxId, processId },
      input: [{ signal: 15, includeChildren: true }],
    });
  });

  test("emits one executor-owned opcode and rejects race parallelism", async () => {
    let operation: SandboxOperationV1 | undefined;
    const captureTool: SandboxRawTool = async (_id, value) => {
      operation = value;
      return resultForOperation(value);
    };
    await createSandboxTools(() => captureTool).create(
      "capture",
      createOptions,
    );

    const step = getStepTools() as SandboxStepTools;
    const rawTool = step[sandboxStepToolSymbol];
    await expect(rawTool("create", operation!)).resolves.toEqual({
      id: "create",
      mode: StepMode.Async,
      op: StepOpCode.Sandbox,
      displayName: "create",
      opts: {
        type: "step.sandbox.create",
        sandbox: operation,
      },
      userland: { id: "create" },
    });
    await expect(
      rawTool({ id: "create", parallelMode: "race" }, operation!),
    ).rejects.toThrow("cannot run with race parallelism");
  });

  test("validates Simcity limits without imposing identifier-style env keys", async () => {
    const rawTool = vi.fn<SandboxRawTool>();
    const sandbox = createSandboxTools(() => rawTool).attach(sandboxRef);

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

  test("attach is synchronous and defers raw-tool resolution", async () => {
    const sandbox = deferredStep.sandbox.attach(sandboxRef);
    expect(sandbox.toJSON()).toEqual(sandboxRef);
    await expect(sandbox.refresh("refresh")).rejects.toThrow(
      "`step` tools can only be used within Inngest function executions",
    );
  });

  test("suspends fresh process mutations and rehydrates them on replay", async () => {
    const client = createClient({ id: testClientId, isDev: true });
    const fn = client.createFunction(
      { id: "sandbox-process", triggers: [{ event: "sandbox/process" }] },
      async ({ step }) => {
        const sandbox = await step.sandbox.create("create", createOptions);
        const process = await sandbox.processes.start("start", {
          command: processRef.command,
        });
        await process.signal("signal", { signal: 15 });
        return process.toJSON();
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
      const invocation = await runFnWithStack(fn, state, { stackOrder });
      expect(invocation.type).toBe("steps-found");
      if (invocation.type !== "steps-found") {
        throw new Error(`Expected steps-found, got ${invocation.type}`);
      }
      const outgoing = invocation.steps[0];
      if (!outgoing) {
        throw new Error(`Missing ${action} operation`);
      }
      expect(outgoing).toMatchObject({
        op: StepOpCode.Sandbox,
        opts: {
          type: `step.sandbox.${action}`,
          sandbox: { protocolVersion: 1, action },
        },
      });
      state[outgoing.id] = { id: outgoing.id, data: results[index] };
      stackOrder.push(outgoing.id);
    }

    await expect(
      runFnWithStack(fn, state, { stackOrder }),
    ).resolves.toMatchObject({
      type: "function-resolved",
      data: processRef,
    });
  });

  test("maps a structured executor failure without making all errors non-retriable", async () => {
    const rawTool: SandboxRawTool = async () => {
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
    const error = await createSandboxTools(() => rawTool)
      .attach(sandboxRef)
      .processes.start("start", { command: ["/bin/true"] })
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
          data: [sandboxData],
          metadata: { fetchedAt: now },
          page: { cursor: null, hasMore: false, limit: 10 },
        });
      }
      if (url.pathname === sandboxPath && method === "GET") {
        return Response.json({ data: sandboxData });
      }
      if (url.pathname === `${sandboxPath}/exec` && method === "POST") {
        return Response.json({
          data: {
            stdout: "AP8=",
            stderr: "ZXJyCg==",
            encoding: "base64",
            exitCode: 7,
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
          })}\n`,
        );
      }
      if (url.pathname === `${sandboxPath}/files` && method === "PUT") {
        return Response.json({
          data: { path: "/tmp/result.bin", bytesWritten: 2 },
        });
      }
      if (url.pathname === `${sandboxPath}/files` && method === "GET") {
        return new Response(new Uint8Array([0, 255]), {
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
      if (url.pathname === `${sandboxPath}/processes` && method === "POST") {
        return Response.json({ data: processData }, { status: 201 });
      }
      if (url.pathname === `${sandboxPath}/processes` && method === "GET") {
        return Response.json({ data: [processData] });
      }
      if (url.pathname === processPath && method === "GET") {
        return Response.json({ data: processData });
      }
      if (url.pathname === `${processPath}/signals` && method === "POST") {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === `${processPath}/wait` && method === "POST") {
        return Response.json({
          data: { id: processId, state: "EXITED", exitCode: 0 },
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
    const processes = await sandbox.processes.list();
    const fetchedProcess = await sandbox.processes.get(processId);
    const refreshedProcess = await started.refresh();
    await started.signal({ signal: 15, includeChildren: true });
    const waited = await started.wait({ timeout: "2s" });
    const output = await started.getOutput({ tailBytes: 64 });
    const destroyed = await sandbox.destroy();

    expect(listed.items[0]?.toJSON()).toEqual(sandboxRef);
    expect(sandbox.toJSON()).toEqual(sandboxRef);
    expect(command).toEqual({
      stdout: new Uint8Array([0, 255]),
      stderr: new TextEncoder().encode("err\n"),
      exitCode: 7,
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
    expect(started.toJSON()).toEqual(processRef);
    expect(processes[0]?.toJSON()).toEqual(processRef);
    expect(fetchedProcess?.toJSON()).toEqual(processRef);
    expect(refreshedProcess?.toJSON()).toEqual(processRef);
    expect(waited.toJSON()).toMatchObject({
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
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer signkey-test",
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

    expect(sandbox.toJSON()).toEqual(sandboxRef);
    expect(process.toJSON()).toEqual(processRef);
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

  test("turns a terminal NDJSON error frame into a SandboxError", async () => {
    let requestCount = 0;
    const fetchMock: typeof fetch = vi.fn(async () => {
      requestCount++;
      if (requestCount === 1) {
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
    const stream = await client
      .attach(sandboxRef)
      .processes.get(processId)
      .then((process) => process?.streamOutput());

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
    const process = await client.attach(sandboxRef).processes.get(processId);
    const stream = await process?.streamOutput();

    await stream?.cancel();

    expect(streamSignal?.aborted).toBe(true);
    expect(responseCancelled).toBe(true);
  });
});
