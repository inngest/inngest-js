import { runFnWithStack, testClientId } from "../test/helpers.ts";
import type { InngestExecutionOptions } from "./execution/InngestExecution.ts";
import { Inngest } from "./Inngest.ts";
import { encodeBase64, sandboxMiddleware } from "./InngestSandbox.ts";

/**
 * Literal environment values, argv, and cwd passed to `step.sandbox` must not
 * be persisted in run state: not as step input, step output, step errors, or
 * step metadata. Only what the command itself prints can end up there.
 */

const secret = "DUMMY_SECRET_VALUE_123";
const sandboxId = "22222222-2222-4222-8222-222222222222";
const processId = "33333333-3333-4333-8333-333333333333";
const now = "2026-07-28T00:00:00Z";

const sandboxResource = {
  id: sandboxId,
  name: "secrets",
  status: "RUNNING",
  vpcId: "11111111-1111-4111-8111-111111111111",
  imageRef: "default",
  resources: { vcpu: 1, memoryMb: 1024 },
  createdAt: now,
  startedAt: now,
};

type StepState = InngestExecutionOptions["stepState"];

/**
 * Everything a step hands to the executor, with base64 stdout, stderr, and
 * output chunks decoded so that a plain search also covers them.
 */
const recordedText = (step: unknown): string => {
  const decoded: string[] = [];
  JSON.stringify(step, (key, value) => {
    if (
      (key === "stdout" || key === "stderr" || key === "data") &&
      typeof value === "string"
    ) {
      decoded.push(Buffer.from(value, "base64").toString("utf8"));
    }
    return value;
  });
  return [JSON.stringify(step), ...decoded].join("\n");
};

/**
 * A Cloud API stand-in. Like the real API, it echoes a started process's argv
 * back, and it never returns environment values.
 */
const createCloudFetch = (options: {
  execStdout: string;
  failProcessStart?: boolean;
}): typeof fetch => {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const path = url.pathname;

    if (method === "POST" && path === "/v2/sandboxes") {
      return Response.json({ data: sandboxResource }, { status: 201 });
    }
    if (method === "GET" && path === `/v2/sandboxes/${sandboxId}`) {
      return Response.json({ data: sandboxResource });
    }
    if (method === "POST" && path.endsWith("/exec")) {
      return Response.json({
        data: {
          stdout: encodeBase64(new TextEncoder().encode(options.execStdout)),
          stderr: "",
          encoding: "base64",
          exitCode: 0,
        },
      });
    }
    if (method === "POST" && path.endsWith("/processes")) {
      if (options.failProcessStart) {
        return Response.json(
          {
            errors: [
              { code: "invalid_argument", message: "process was rejected" },
            ],
          },
          { status: 400 },
        );
      }
      return Response.json(
        {
          data: {
            id: processId,
            command: body.command,
            pid: 42,
            state: "RUNNING",
            startedAt: now,
          },
        },
        { status: 201 },
      );
    }
    if (method === "POST" && path.endsWith("/signals")) {
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path.endsWith("/wait")) {
      return Response.json({
        data: { id: processId, state: "EXITED", exitCode: 0 },
      });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
};

/**
 * Run a function to completion the way the executor would, recording every
 * step each request reports.
 */
const runToCompletion = async (
  fn: Parameters<typeof runFnWithStack>[0],
): Promise<{ recorded: string[]; final: unknown }> => {
  let state: StepState = {};
  const stackOrder: string[] = [];
  const recorded: string[] = [];

  for (let request = 0; request < 20; request++) {
    const result = await runFnWithStack(fn, state, { stackOrder });
    if (result.type === "step-ran") {
      recorded.push(recordedText(result.step));
      state = {
        ...state,
        [result.step.id]: {
          id: result.step.id,
          data: result.step.data,
          error: result.step.error,
        },
      };
      stackOrder.push(result.step.id);
      continue;
    }
    if (result.type === "steps-found") {
      recorded.push(...result.steps.map(recordedText));
      throw new Error("Expected each sandbox step to run immediately");
    }
    return { recorded, final: result };
  }
  throw new Error("Function did not finish");
};

const createFn = (fetchImpl: typeof fetch) => {
  const client = new Inngest({
    id: testClientId,
    signingKey: "signkey-test",
    baseUrl: "https://api.example.test",
    fetch: fetchImpl,
    middleware: [sandboxMiddleware()],
  });
  return client.createFunction(
    { id: "sandbox-secrets", triggers: [{ event: "sandbox/secrets" }] },
    async ({ step }) => {
      const sandbox = await step.sandbox.create("create", {
        name: "secrets",
        vcpu: 1,
        memoryMb: 1024,
        environment: { CREATE_ENV: secret },
        secrets: ["NPM_TOKEN"],
      });
      const exec = await sandbox.commands.run(
        "exec",
        ["deploy", `--token=${secret}`],
        {
          environment: { EXEC_ENV: secret },
          cwd: `/workspace/${secret}`,
        },
      );
      const process = await sandbox.processes.start("start", {
        command: ["serve", `--token=${secret}`],
        environment: { START_ENV: secret },
        cwd: `/workspace/${secret}`,
      });
      await process.signal("signal", { signal: 15 });
      const exited = await process.wait("wait");
      return {
        execExitCode: exec.exitCode,
        execStdoutHasSecret: exec.stdout.includes(secret),
        // Replay still exposes argv to code, taken from code, not run state.
        startCommandFromCode:
          process.command.join(" ") === `serve --token=${secret}`,
        waitCommandFromCode:
          exited.command.join(" ") === `serve --token=${secret}`,
      };
    },
  );
};

describe("step.sandbox secret handling", () => {
  test("never records literal environment values, argv, or cwd", async () => {
    const { recorded, final } = await runToCompletion(
      createFn(createCloudFetch({ execStdout: "deployed\n" })),
    );

    expect(recorded).toHaveLength(5);
    for (const step of recorded) {
      expect(step).not.toContain(secret);
    }
    // No sandbox step records the operation as input.
    for (const step of recorded) {
      expect(step).not.toContain('"input"');
    }
    expect(final).toMatchObject({
      type: "function-resolved",
      data: {
        execExitCode: 0,
        execStdoutHasSecret: false,
        startCommandFromCode: true,
        waitCommandFromCode: true,
      },
    });
  });

  test("never records them in a failed step's error", async () => {
    const { recorded, final } = await runToCompletion(
      createFn(
        createCloudFetch({ execStdout: "deployed\n", failProcessStart: true }),
      ),
    );

    expect(final).toMatchObject({ type: "function-rejected" });
    expect(recorded.at(-1)).toContain("process was rejected");
    for (const step of recorded) {
      expect(step).not.toContain(secret);
    }
  });

  test("records command output verbatim, so a command that prints a secret stores it", async () => {
    const { recorded } = await runToCompletion(
      createFn(createCloudFetch({ execStdout: `token is ${secret}\n` })),
    );

    const execStep = recorded[1];
    expect(execStep).toBeDefined();
    // Stored base64-encoded, so a plain search of run state would miss it.
    expect(JSON.stringify(JSON.parse(execStep!.split("\n")[0]!))).not.toContain(
      secret,
    );
    expect(execStep).toContain(`token is ${secret}`);
    for (const step of recorded.filter((_, index) => index !== 1)) {
      expect(step).not.toContain(secret);
    }
  });
});
