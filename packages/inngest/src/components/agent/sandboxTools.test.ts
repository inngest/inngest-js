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
  {
    stdout = "",
    stderr = "",
    exitCode = 0,
    file = "" as string | Uint8Array | null,
  } = {},
) => {
  const execs: Exec[] = [];
  const uploads: { path: string; body: string }[] = [];
  const client = createClient((path, method, { query, body: request }) => {
    if (path.endsWith("/files")) {
      if (method === "PUT") {
        const body = new TextDecoder().decode(request as Uint8Array);
        uploads.push({ path: query.get("path") ?? "", body });

        return Response.json({
          data: { path: query.get("path"), bytesWritten: body.length },
        });
      }

      return file === null
        ? Response.json(
            { errors: [{ code: "file_not_found", message: "no such file" }] },
            { status: 404 },
          )
        : new Response(file as BodyInit);
    }

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

  return { type, ran, steps, execs, uploads };
};

type Call = (input: unknown) => Promise<unknown>;

describe("codeTools edit", () => {
  const edit = async (
    file: string | Uint8Array | null,
    input: Record<string, unknown>,
  ) => {
    let result: unknown;
    let error: unknown;
    const run = await inSandbox(
      async (sandbox) => {
        try {
          result = await (
            codeTools(sandbox, { cwd: "/repo" }).edit.run as Call
          )(input);
        } catch (caught) {
          error = caught;
        }
      },
      { file },
    );

    return { ...run, result, error };
  };

  test("reads, edits and writes the file in the app, relative to cwd", async () => {
    const { result, uploads, execs } = await edit("a\nb\n", {
      path: "src/a.ts",
      old_string: "b",
      new_string: "B",
    });

    expect(result).toBe("edited src/a.ts");
    expect(uploads).toEqual([{ path: "/repo/src/a.ts", body: "a\nB\n" }]);
    expect(execs).toEqual([]);
  });

  test("tells the model a missing file isn't there, without retrying", async () => {
    const { error, ran, uploads } = await edit(null, {
      path: "gone.ts",
      old_string: "a",
      new_string: "b",
    });

    expect((error as Error).message).toBe("File not found: gone.ts");
    expect(ran.filter((id) => id === "edit:read")).toHaveLength(1);
    expect(uploads).toEqual([]);
  });

  test("replace_all changes every match", async () => {
    const { uploads } = await edit("x x x", {
      path: "/a",
      old_string: "x",
      new_string: "y",
      replace_all: true,
    });

    expect(uploads[0]?.body).toBe("y y y");
  });

  test.each([
    {
      name: "no match",
      edit: { old_string: "zzz", new_string: "y" },
      message: "old_string was not found in f.ts",
    },
    {
      name: "several matches",
      edit: { old_string: "x", new_string: "y" },
      message: "matches 3 times in f.ts (lines 1, 2, 4)",
    },
    {
      name: "an empty old_string",
      edit: { old_string: "", new_string: "y" },
      message: "old_string is empty",
    },
    {
      name: "identical strings",
      edit: { old_string: "x", new_string: "x" },
      message: "identical",
    },
  ])("writes nothing on $name", async ({ edit: change, message }) => {
    const { uploads, error } = await edit("x\nx w\n\nx", {
      path: "f.ts",
      ...change,
    });

    expect((error as Error).message).toContain(message);
    expect(uploads).toEqual([]);
  });

  test("refuses a file that isn't UTF-8 text", async () => {
    const { error, uploads } = await edit(new Uint8Array([0xff, 0xfe]), {
      path: "f.bin",
      old_string: "a",
      new_string: "b",
    });

    expect(uploads).toEqual([]);
    expect((error as Error).message).toBe("f.bin is not a UTF-8 text file");
  });
});

describe("codeTools", () => {
  test("names each step after its command and runs it in cwd", async () => {
    const { ran, execs } = await inSandbox(async (sandbox) => {
      const tools = codeTools(sandbox, { cwd: "/repo" });
      const ctx = { signal: new AbortController().signal, idempotencyKey: "k" };

      await (tools.run.run as (input: unknown, ctx: unknown) => unknown)(
        { command: "npm test" },
        ctx,
      );
    });

    expect(ran).toEqual(["box", "run", "box:destroy"]);
    expect(execs.map((exec) => exec.cwd)).toEqual(["/repo"]);
    expect(execs[0]?.command).toEqual(["/bin/sh", "-c", "npm test"]);
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
        await (checkout.tools.push.run as (input: unknown) => unknown)({
          branch: "fix",
        });
      },
      { stdout: "noise\nabc123\n" },
    );

    expect(checkout).toMatchObject({ path: "/work", sha: "abc123" });
    expect(Object.keys(checkout?.tools ?? {})).toEqual([
      "read",
      "write",
      "edit",
      "search",
      "run",
      "push",
    ]);
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
