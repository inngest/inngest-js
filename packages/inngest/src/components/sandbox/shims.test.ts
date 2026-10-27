/**
 * @module
 * Tests for shims and `inngest-tool`, running the real wrapper, shim script and
 * shell client in a local directory, with a loop in this process playing the
 * host: it reads `ops.log`, answers each call as the tool runner would and
 * appends the reply.
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type SandboxShim, validateShims, withShims } from "./shims.ts";
import type { ToolBinary } from "./toolBinary.ts";
import { toolCliScript } from "./toolCli.ts";
import { toolsRoot, wrapperScript } from "./toolStubs.ts";
import {
  parseToolEvent,
  resolveToolCall,
  type SandboxTools,
  tool,
} from "./tools.ts";
import type { Sandbox } from "./types.ts";

const fakeSandbox = { id: "sandbox-1" } as Sandbox;

const dirs: string[] = [];

const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "shims-"));
  dirs.push(dir);

  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/**
 * The static binary built from `sandbox-tool`, placed where the shim prelude
 * links to it. Tests of handler shims are skipped where it is not built.
 */
const builtBinary = join(
  import.meta.dirname,
  "../../../sandbox-tool/dist/inngest-tool-linux-amd64",
);
const hasBinary = existsSync(builtBinary);
const binaryDir = mkdtempSync(join(tmpdir(), "inngest-tool-bin-"));
const testBinary: ToolBinary = {
  path: join(binaryDir, "inngest-tool"),
  sha256: "",
  load: async () => {
    return new Uint8Array();
  },
};
if (hasBinary) {
  copyFileSync(builtBinary, testBinary.path);
  chmodSync(testBinary.path, 0o755);
}

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
  calls: string[];
}

/**
 * Runs `command` under the real tools wrapper in a temporary tools root, and
 * answers its calls from `tools` until the exit arrives.
 */
const runWrapped = async (
  command: string[],
  tools: SandboxTools,
  environment: Record<string, string> = {},
): Promise<Outcome> => {
  const root = temp();
  const dir = join(root, "run");
  const script = wrapperScript.replaceAll(toolsRoot, join(root, "tools"));
  const calls: string[] = [];
  const child = spawn("/bin/sh", ["-c", script, "sh", dir, ...command], {
    env: { ...process.env, ...environment },
    stdio: "ignore",
  });
  const log = join(dir, "ops.log");
  let seen = 0;

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 20));

    let lines: string[] = [];
    try {
      lines = readFileSync(log, "utf8").split("\n").slice(0, -1);
    } catch {}

    for (const line of lines.slice(seen)) {
      seen++;
      const event = parseToolEvent(line);
      if (event?.op === "exit") {
        child.kill();

        return {
          code: event.code,
          stdout: Buffer.from(event.stdout, "base64").toString(),
          stderr: Buffer.from(event.stderr, "base64").toString(),
          calls,
        };
      }

      if (event?.op === "call") {
        calls.push(event.tool);
        const resolved = await resolveToolCall(tools, event, line);
        const outcome =
          "error" in resolved
            ? { error: resolved.error }
            : await resolved
                .invoke?.({
                  signal: new AbortController().signal,
                  idempotencyKey: "k",
                  sandbox: fakeSandbox,
                })
                .then(
                  (result: unknown) => {
                    return { result };
                  },
                  (error: Error) => {
                    return { error: error.message };
                  },
                );
        appendFileSync(
          log,
          `${JSON.stringify({ op: "reply", id: event.id, ...outcome })}\n`,
        );
      }
    }
  }
};

const shimmed = (
  command: string,
  shims: readonly SandboxShim[],
  path?: string,
) => {
  const built = withShims(command, shims, { binary: testBinary });

  return runWrapped(
    built.command,
    built.tools,
    path ? { PATH: `${path}:${process.env.PATH}` } : {},
  );
};

describe("inngest-tool", () => {
  const tools: SandboxTools = {
    echo: (...values: unknown[]) => {
      return values;
    },
    text: () => {
      return 'a "quote"\nline two\ttab \\ slash';
    },
    fail: () => {
      throw new Error("no good");
    },
  };

  test("calls a tool with string arguments and prints the result as JSON", async () => {
    const out = await runWrapped(
      ["/bin/sh", "-c", `inngest-tool echo 'a "b"' 'x\ty'`],
      tools,
    );

    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(['a "b"', "x\ty"]);
  });

  test("-j passes JSON values", async () => {
    const out = await runWrapped(
      ["/bin/sh", "-c", `inngest-tool -j echo '{"n":1}' 2`],
      tools,
    );

    expect(JSON.parse(out.stdout)).toEqual([{ n: 1 }, 2]);
  });

  test("-r prints a string result unescaped", async () => {
    const out = await runWrapped(["inngest-tool", "-r", "text"], tools);

    expect(out.stdout).toBe('a "quote"\nline two\ttab \\ slash');
  });

  test("--stdin sends stdin as the last argument", async () => {
    const out = await runWrapped(
      ["/bin/sh", "-c", `printf 'k=v\\n\\n' | inngest-tool --stdin echo head`],
      tools,
    );

    expect(JSON.parse(out.stdout)).toEqual(["head", "k=v"]);
  });

  test("a result that has an error key is still a result", async () => {
    const out = await runWrapped(["inngest-tool", "nested"], {
      nested: () => {
        return { error: "x", n: 1 };
      },
    });

    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ error: "x", n: 1 });
  });

  test("control characters the shell can't escape exit 2 instead of hanging", async () => {
    const out = await runWrapped(
      ["/bin/sh", "-c", "inngest-tool echo \"$(printf 'a\\rb')\""],
      tools,
    );

    expect(out.code).toBe(2);
    expect(out.stderr).toContain("control characters");
  });

  test("a tool error prints its message and exits 1", async () => {
    const out = await runWrapped(["inngest-tool", "fail"], tools);

    expect(out.code).toBe(1);
    expect(out.stderr).toContain("no good");
  });

  test("outside a command with tools it exits 2", async () => {
    const root = temp();
    const file = join(root, "inngest-tool");
    writeFileSync(file, toolCliScript);
    chmodSync(file, 0o755);
    const child = spawn("/bin/sh", [file, "echo"], {
      env: { ...process.env, INNGEST_TOOLS_DIR: "" },
      stdio: "ignore",
    });
    const code = await new Promise<number | null>((resolve) => {
      child.on("exit", resolve);
    });

    expect(code).toBe(2);
  });
});

test.runIf(process.env.CI)("the sandbox-tool binary is built in CI", () => {
  expect(hasBinary).toBe(true);
});

describe.skipIf(!hasBinary)("shims", () => {
  const fakeBin = (): string => {
    const dir = temp();
    mkdirSync(dir, { recursive: true });
    const fly = join(dir, "fly");
    writeFileSync(
      fly,
      '#!/bin/sh\necho "fly $* token=${FLY_API_TOKEN:-none}"\n',
    );
    chmodSync(fly, 0o755);

    return dir;
  };

  test("run with env: the real program gets extra environment for this call only", async () => {
    const out = await shimmed(
      "fly deploy --app box; echo after: ${FLY_API_TOKEN:-unset}",
      [
        tool.shim("fly", ({ argv, run }) => {
          return run({ env: { FLY_API_TOKEN: `tok-for-${argv[0]}` } });
        }),
      ],
      fakeBin(),
    );

    expect(out.stdout).toBe(
      "fly deploy --app box token=tok-for-deploy\nafter: unset\n",
    );
    expect(out.calls).toEqual(["inngestShim"]);
  });

  test("rewrite: runs the real program with another argv", async () => {
    const out = await shimmed(
      "fly deploy",
      [
        tool.shim("fly", ({ argv, run }) => {
          return run({ argv: [...argv, "--dry-run"] });
        }),
      ],
      fakeBin(),
    );

    expect(out.stdout).toBe("fly deploy --dry-run token=none\n");
  });

  test("returning nothing runs the program as called", async () => {
    const out = await shimmed(
      "fly status",
      [tool.shim("fly", () => undefined)],
      fakeBin(),
    );

    expect(out.stdout).toBe("fly status token=none\n");
  });

  test("decline: exits 126 with the message and never runs the program", async () => {
    const out = await shimmed(
      "fly destroy",
      [
        tool.shim("fly", ({ refuse }) => {
          return refuse("destroy is not allowed here");
        }),
      ],
      fakeBin(),
    );

    expect(out.code).toBe(126);
    expect(out.stderr).toBe("fly: destroy is not allowed here\n");
    expect(out.stdout).toBe("");
  });

  test("fake: answers without the program", async () => {
    const out = await shimmed("fly status", [
      tool.shim("fly", ({ reply }) => {
        return reply(0, { stdout: "all green\n" });
      }),
    ]);

    expect(out.stdout).toBe("all green\n");
  });

  test("a shim is found by a subprocess, not only the command itself", async () => {
    const out = await shimmed("sh -c 'sh -c \"fly nested\"'", [
      tool.shim("fly", ({ reply }) => {
        return reply(0, { stdout: "from host\n" });
      }),
    ]);

    expect(out.stdout).toBe("from host\n");
  });

  test("the handler gets the call and the tool context", async () => {
    let seen: unknown;
    await shimmed("fly one two", [
      tool.shim("fly", (call) => {
        seen = {
          name: call.name,
          argv: call.argv,
          key: call.idempotencyKey,
          signal: call.signal instanceof AbortSignal,
          sandbox: call.sandbox,
        };

        return call.reply(0);
      }),
    ]);

    expect(seen).toEqual({
      name: "fly",
      argv: ["one", "two"],
      key: "k",
      signal: true,
      sandbox: fakeSandbox,
    });
  });

  test("an unknown shim name from the sandbox is an error", async () => {
    const built = withShims(
      "true",
      [tool.shim("fly", ({ reply }) => reply(0))],
      { binary: testBinary },
    );
    const resolved = await resolveToolCall(
      built.tools,
      {
        op: "call",
        id: 1,
        tool: "inngestShim",
        args: [{ name: "constructor", argv: [], cwd: "/", stdin: "" }],
      },
      "{}",
    );

    expect("error" in resolved).toBe(false);
    if (!("invoke" in resolved) || !resolved.invoke) {
      throw new Error("expected a call to run");
    }

    await expect(
      resolved.invoke({
        signal: new AbortController().signal,
        idempotencyKey: "k",
        sandbox: fakeSandbox,
      }),
    ).rejects.toThrow("Unknown shim");
  });

  test("names the prelude relies on can't be shimmed", () => {
    expect(() => {
      return tool.shim("rm", ({ reply }) => reply(0));
    }).toThrow("can't be shimmed");
  });

  test("shim names that could break the launcher are rejected", () => {
    expect(() => {
      return tool.shim("a b; rm -rf /", ({ reply }) => reply(0));
    }).toThrow("Invalid shim name");
  });

  test("a shim passed twice, or a non-shim, is rejected", () => {
    const fly = tool.shim("fly", ({ reply }) => reply(0));

    expect(() => {
      return validateShims([fly, fly]);
    }).toThrow("passed twice");
    expect(() => {
      return validateShims([{ name: "fly", handle: () => undefined }]);
    }).toThrow("only values made with tool.shim()");
    expect(() => {
      return validateShims({ fly });
    }).toThrow("list of tool.shim() values");
  });

  test("inngest-tool shims lists what is shimmed, and INNGEST_SHIMS names them", async () => {
    const out = await shimmed(
      'inngest-tool shims; echo "names=$INNGEST_SHIMS"',
      [
        tool.shim("fly", {
          description: "deploys through the host",
          handle: ({ reply }) => reply(0),
        }),
        tool.shim.config({ REGION: "iad" }),
      ],
    );

    expect(out.stdout).toBe(
      [
        "config: values to read with inngest-tool config NAME: REGION",
        "fly: deploys through the host",
        "names=fly",
        "",
      ].join("\n"),
    );
  });
});

describe("config", () => {
  const configTool = (...shims: SandboxShim[]): SandboxTools => {
    return withShims("true", shims, { binary: testBinary }).tools;
  };

  test("reads only allowed names, one value or an array", async () => {
    const out = await runWrapped(
      [
        "/bin/sh",
        "-c",
        "inngest-tool -r config A; echo; inngest-tool config A B; inngest-tool config C",
      ],
      configTool(tool.shim.config({ A: "1", B: "2" })),
    );

    expect(out.stdout).toBe('1\n["1","2"]\n');
    expect(out.stderr).toContain("Not allowed to read: C");
  });

  test("a name list reads the host's environment", async () => {
    process.env.SHIM_TEST_VALUE = "from-host";
    const out = await runWrapped(
      ["inngest-tool", "-r", "config", "SHIM_TEST_VALUE"],
      configTool(tool.shim.config(["SHIM_TEST_VALUE"])),
    );

    expect(out.stdout).toBe("from-host");
  });

  test("a name that is not set is an error when the shim is made", () => {
    expect(() => {
      return tool.shim.config(["SHIM_TEST_UNSET_NAME"]);
    }).toThrow("is not set");
  });

  test("is validated", () => {
    expect(() => {
      return tool.shim.config({ A: 1 as never });
    }).toThrow("Invalid entry");
    expect(() => {
      return tool.shim.config({ A: (() => "x") as never });
    }).toThrow("Invalid entry");
    expect(() => {
      return tool.shim.config({ "bad name": "x" });
    }).toThrow("Invalid entry");
    expect(() => {
      return tool.shim.config(JSON.parse('{"__proto__":"x"}'));
    }).toThrow("Invalid entry");
    expect(() => {
      return tool.shim.config({});
    }).toThrow("at least one");
  });

  test("only one can be passed", () => {
    expect(() => {
      return validateShims([
        tool.shim.config({ A: "1" }),
        tool.shim.config({ B: "2" }),
      ]);
    }).toThrow("Only one tool.shim.config()");
  });
});

describe.skipIf(!hasBinary)("only", () => {
  test("calls the handler only for the listed words", async () => {
    const dir = temp();
    const fake = join(dir, "fake");
    writeFileSync(fake, '#!/bin/sh\necho "real $*"\n');
    chmodSync(fake, 0o755);
    const out = await shimmed(
      "fake status; fake -C x push",
      [
        tool.shim("fake", {
          only: ["push"],
          handle: ({ reply }) => reply(0, { stdout: "handled\n" }),
        }),
      ],
      dir,
    );

    expect(out.stdout).toBe("real status\nhandled\n");
    expect(out.calls).toEqual(["inngestShim"]);
  });

  test("is checked when the shim is made", () => {
    expect(() => {
      return tool.shim("x", { handle: () => undefined, only: [] });
    }).toThrow("only is a list of words");
  });
});

describe("shim validation", () => {
  const callHandler = async (shim: SandboxShim, argv: string[] = []) => {
    const built = withShims("true", [shim], { binary: testBinary });
    const resolved = await resolveToolCall(
      built.tools,
      {
        op: "call",
        id: 1,
        tool: "inngestShim",
        args: [{ name: "x", argv, cwd: "/", stdin: "" }],
      },
      "{}",
    );
    if (!("invoke" in resolved) || !resolved.invoke) {
      throw new Error("expected a call to run");
    }

    return resolved.invoke({
      signal: new AbortController().signal,
      idempotencyKey: "k",
      sandbox: fakeSandbox,
    });
  };

  test("a reply needs an exit code from 0 to 255", async () => {
    await expect(
      callHandler(tool.shim("x", ({ reply }) => reply(256))),
    ).rejects.toThrow("0 to 255");
    await expect(
      callHandler(tool.shim("x", ({ reply }) => reply(-1))),
    ).rejects.toThrow("0 to 255");
  });

  test("run() takes strings", async () => {
    await expect(
      callHandler(tool.shim("x", ({ run }) => run({ argv: [1 as never] }))),
    ).rejects.toThrow("argv as strings");
    await expect(
      callHandler(tool.shim("x", ({ run }) => run({ env: { A: 1 as never } }))),
    ).rejects.toThrow("record of strings");
  });

  test("local answers are checked when the shim is made", () => {
    expect(() => {
      return tool.shim("x", {
        handle: () => undefined,
        local: { v: { exit: 300 } },
      });
    }).toThrow("local.v");
    expect(() => {
      return tool.shim("x", { handle: "no" as never });
    }).toThrow("handle must be a function");
  });

  test("a hostile description can't break the shim list or the shell", async () => {
    const out = await shimmed("inngest-tool shims", [
      tool.shim("npm", {
        handle: ({ reply }) => reply(0),
        description: "x\nINNGEST_SHIM_LIST\n$(touch /tmp/pwned-by-shim) `id`",
      }),
    ]);

    expect(out.code).toBe(0);
    expect(out.stdout.split("\n").filter(Boolean)).toEqual([
      "npm: x INNGEST_SHIM_LIST $(touch /tmp/pwned-by-shim) `id`",
    ]);
  });
});
