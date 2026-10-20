/**
 * @module
 * Tests for `codeTools()` and `repo()` against a sandbox API that records the
 * commands it is sent.
 */
import {
  createClient,
  runToEnd,
  sandboxResource,
} from "../sandbox/test-helpers.ts";
import type { DurableSandbox } from "../sandbox/types.ts";
import { codeTools } from "./codeTools.ts";
import { repo } from "./repo.ts";

type Exec = {
  command: string[];
  environment?: Record<string, string>;
  cwd?: string;
};

/**
 * Runs `body` inside a sandbox whose commands exit with `exitCode` after
 * printing `stdout`, and returns the commands the API received with the
 * steps that were recorded.
 */
const inSandbox = async (
  body: (sandbox: DurableSandbox) => Promise<unknown>,
  { stdout = "", stderr = "", exitCode = 0 } = {},
) => {
  const execs: Exec[] = [];
  const client = createClient((path, method, { body: request }) => {
    if (path === "/v2/sandboxes" && method === "POST") {
      return Response.json({ data: sandboxResource }, { status: 201 });
    }

    if (path.endsWith("/exec")) {
      execs.push(JSON.parse(request as string));

      return Response.json({
        data: {
          stdout: btoa(stdout),
          stderr: btoa(stderr),
          encoding: "base64",
          exitCode,
        },
      });
    }

    return new Response(null, { status: 204 });
  });
  const fn = client.createFunction(
    { id: "sandbox-tools", triggers: [{ event: "sandbox/tools" }] },
    async ({ group }) => {
      await group.sandbox("box", body);
    },
  );
  const { type, ran, steps } = await runToEnd(fn);

  return { type, ran, steps, execs };
};

describe("codeTools", () => {
  test("names each step after its command and runs it in cwd", async () => {
    const { ran, execs } = await inSandbox(async (sandbox) => {
      const tools = codeTools(sandbox, { cwd: "/repo" });
      const ctx = { signal: new AbortController().signal, idempotencyKey: "k" };

      await (tools.run.run as (input: unknown, ctx: unknown) => unknown)(
        { command: "npm test" },
        ctx,
      );
      await (tools.edit.run as (input: unknown, ctx: unknown) => unknown)(
        { path: "a.ts", old: "x", new: "y" },
        ctx,
      );
    });

    expect(ran).toEqual(["box", "run", "edit", "box:destroy"]);
    expect(execs.map((exec) => exec.cwd)).toEqual(["/repo", "/repo"]);
    expect(execs[0]?.command).toEqual(["/bin/sh", "-c", "npm test"]);
    expect(execs[1]?.environment).toEqual({ P: "a.ts", OLD: "x", NEW: "y" });
  });

  test("returns the exit code with the output", async () => {
    let output: unknown;

    await inSandbox(
      async (sandbox) => {
        output = await (
          codeTools(sandbox).run.run as (input: unknown) => unknown
        )({ command: "false" });
      },
      { stdout: "out", stderr: "err", exitCode: 2 },
    );

    expect(output).toBe("exit 2\nout\nstderr:\nerr");
  });

  test("only returns the tools asked for", async () => {
    await inSandbox(async (sandbox) => {
      expect(
        Object.keys(codeTools(sandbox, { only: ["read", "run"] })),
      ).toEqual(["read", "run"]);
    });
  });
});

describe("repo", () => {
  const token = "ghs_secret_token";

  test("keeps the token in the command environment, out of steps and scripts", async () => {
    let checkout: Awaited<ReturnType<typeof repo>> | undefined;

    const { steps, execs } = await inSandbox(
      async (sandbox) => {
        checkout = await repo(sandbox, { repo: "acme/web", ref: "dev", token });
        await checkout.push("fix");
      },
      { stdout: "noise\nabc123\n" },
    );

    expect(checkout).toMatchObject({ path: "/work", sha: "abc123" });
    expect(execs.map((exec) => exec.environment?.GIT_TOKEN)).toEqual([
      token,
      token,
    ]);
    expect(execs[0]?.environment).toMatchObject({
      URL: "https://github.com/acme/web.git",
      REF: "dev",
    });
    expect(execs[1]?.environment?.BRANCH).toBe("fix");
    expect(JSON.stringify(steps)).not.toContain(token);
    expect(JSON.stringify(execs.map((exec) => exec.command))).not.toContain(
      token,
    );
  });

  test("fails without retrying when git fails", async () => {
    const { type } = await inSandbox(
      async (sandbox) => {
        await repo(sandbox, { repo: "acme/missing" });
      },
      { stderr: "not found", exitCode: 128 },
    );

    expect(type).toBe("function-rejected");
  });
});
