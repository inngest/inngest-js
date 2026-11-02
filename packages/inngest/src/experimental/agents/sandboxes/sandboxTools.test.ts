/**
 * @module
 * Tests for `codeTools()` and `repo()` against a sandbox API that records the
 * commands it is sent.
 */

import { vi } from "vitest";
import { codeTools } from "../../../components/sandbox/codeTools.ts";
import {
  createClient,
  runToEnd,
  sandboxResource,
} from "../../../components/sandbox/test-helpers.ts";
import { tool } from "../../../components/sandbox/tools.ts";
import type { DurableSandbox } from "../../../components/sandbox/types.ts";

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
            codeTools(sandbox, { cwd: "/repo", only: ["edit"] }).edit
              .run as Call
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
      const tools = codeTools(sandbox, { cwd: "/repo", session: false });
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

  test("run keeps its directory between calls and says where a command moved it", async () => {
    const { execs } = await inSandbox(async (sandbox) => {
      const tools = codeTools(sandbox, { cwd: "/repo" });
      const ctx = { signal: new AbortController().signal, idempotencyKey: "k" };
      const run = tools.run.run as (input: unknown, ctx: unknown) => unknown;

      await run({ command: "cd pkg" }, ctx);
      await run({ command: "npm test" }, ctx);
    });

    // The fake answers with no report, so nothing moved: the session starts
    // each command in cwd and carries its text after the report setup.
    expect(execs.map((exec) => exec.cwd)).toEqual(["/repo", "/repo"]);
    expect(execs[1]?.command.at(-1)).toMatch(/npm test$/);
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

  test("only adds read, search and edit, and there is no write", async () => {
    await inSandbox(async (sandbox) => {
      const tools = codeTools(sandbox, {
        only: ["run", "read", "search", "edit"],
      });

      expect(Object.keys(tools)).toEqual(["run", "read", "search", "edit"]);
      expect(Object.keys(codeTools(sandbox, { tools: {} }))).not.toContain(
        "write",
      );
    });
  });

  test("only may leave out run", async () => {
    await inSandbox(async (sandbox) => {
      expect(Object.keys(codeTools(sandbox, { only: ["read"] }))).toEqual([
        "read",
      ]);
    });
  });

  test("only returns the tools asked for", async () => {
    await inSandbox(async (sandbox) => {
      expect(
        Object.keys(codeTools(sandbox, { only: ["read", "run"] })),
      ).toEqual(["read", "run"]);
    });
  });
});

describe("codeTools run_code", () => {
  const sandbox = {} as DurableSandbox;

  test("is offered only when the script's tools are given", () => {
    expect(Object.keys(codeTools(sandbox))).toEqual(["run"]);
    expect(Object.keys(codeTools(sandbox, { tools: {} }))).toEqual([
      "run",
      "run_code",
    ]);
    expect(Object.keys(codeTools(sandbox, { only: ["run_code"] }))).toEqual([
      "run_code",
    ]);
  });
});

describe("codeTools run_code options", () => {
  const sandbox = {} as DurableSandbox;

  test("refuses tools named like the built-ins", () => {
    expect(() => {
      return codeTools(sandbox, {
        tools: {
          sleep: () => {
            return 1;
          },
        },
      });
    }).toThrow(/built in/);
  });

  test("refuses tools when only leaves run_code out", () => {
    expect(() => {
      return codeTools(sandbox, { tools: {}, only: ["run"] });
    }).toThrow(/only leaves it out/);
  });
});

describe("codeTools run keeps the thread's place", () => {
  const fake = (saved: unknown) => {
    const seen: { cwd?: string; environment?: Record<string, string> }[] = [];
    let read: (() => unknown) | undefined;
    const sandbox = {
      commands: {
        run: async (
          _id: unknown,
          _command: unknown,
          options: { cwd?: string; environment?: Record<string, string> },
        ) => {
          seen.push(options);

          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
      files: {},
      "~shellPlace": {
        load: async () => {
          return saved;
        },
        track: (fn: () => unknown) => {
          read = fn;
        },
      },
    } as unknown as DurableSandbox;

    return { sandbox, seen, place: () => read?.() };
  };

  const call = (tools: ReturnType<typeof codeTools>, command: string) => {
    return (tools.run.run as (input: unknown, ctx: unknown) => unknown)(
      { command },
      { signal: new AbortController().signal, idempotencyKey: "k" },
    );
  };

  test("a first command starts in the saved directory with the saved environment", async () => {
    const { sandbox, seen } = fake({
      cwd: "/work/app",
      env: { MODE: "test" },
      unset: [],
    });

    await call(codeTools(sandbox), "ls");

    expect(seen[0]?.cwd).toBe("/work/app");
    expect(seen[0]?.environment).toEqual({ MODE: "test" });
  });

  test("with nothing saved the shell starts at cwd with an empty environment", async () => {
    const { sandbox, seen } = fake(undefined);

    await call(codeTools(sandbox, { cwd: "/src" }), "ls");

    expect(seen[0]?.cwd).toBe("/src");
    expect(seen[0]?.environment).toEqual({});
  });

  test("the shell hands its place over to be kept", async () => {
    const { sandbox, place } = fake({
      cwd: "/work/app",
      env: { MODE: "test" },
      unset: ["OLD"],
    });

    await call(codeTools(sandbox), "ls");

    expect(place()).toEqual({
      cwd: "/work/app",
      env: { MODE: "test" },
      unset: ["OLD"],
    });
  });
});

describe("shims on the model's code tools", () => {
  const fake = () => {
    const run = vi.fn(async () => {
      return { stdout: "", stderr: "", exitCode: 0, output: {} };
    });
    const files = {
      read: vi.fn(async () => {
        return new Uint8Array();
      }),
      write: vi.fn(async () => {}),
    };

    return { run, sandbox: { commands: { run }, files } as never };
  };
  const deploy = tool.shim("deploy", ({ reply }) => {
    return reply(0);
  });
  const context = { signal: new AbortController().signal, idempotencyKey: "k" };

  test("run passes shims to its command", async () => {
    const { run, sandbox } = fake();
    const tools = codeTools(sandbox, { shims: [deploy], session: false });

    await (tools.run.run as (...args: unknown[]) => unknown)(
      { command: "deploy now" },
      context,
    );

    expect(run).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ shims: [deploy] }),
    );
  });

  test("run in a session passes shims to its command", async () => {
    const { run, sandbox } = fake();
    const tools = codeTools(sandbox, { shims: [deploy] });

    await (tools.run.run as (...args: unknown[]) => unknown)(
      { command: "deploy now" },
      context,
    );

    expect(run).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ shims: [deploy] }),
    );
  });

  test("run_code passes shims beside its tools", async () => {
    const { run, sandbox } = fake();
    const tools = codeTools(sandbox, {
      shims: [deploy],
      tools: { ping: () => 1 },
    });

    await (tools.run_code.run as (...args: unknown[]) => unknown)(
      { language: "python", code: "print(1)" },
      context,
    ).catch(() => {});

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run_code" }),
      expect.anything(),
      expect.objectContaining({ shims: [deploy] }),
    );
  });
});
