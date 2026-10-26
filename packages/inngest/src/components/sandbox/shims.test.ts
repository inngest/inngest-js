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
import { internalTool } from "./internalTool.ts";
import {
  gitCredentials,
  hostEnvFrom,
  hostEnvTool,
  injectEnv,
  refuse,
  reply,
  run,
  type Shims,
  withShims,
} from "./shims.ts";
import type { ToolBinary } from "./toolBinary.ts";
import { toolCliScript } from "./toolCli.ts";
import { toolsRoot, wrapperScript } from "./toolStubs.ts";
import {
  parseToolEvent,
  resolveToolCall,
  type SandboxTools,
  tool,
} from "./tools.ts";

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

const shimmed = (command: string, shims: Shims, path?: string) => {
  const built = withShims(command, shims, { binary: testBinary });

  return runWrapped(built.command, built.tools, {
    ...built.environment,
    ...(path && { PATH: `${path}:${process.env.PATH}` }),
  });
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

  test("inject: runs the real program with a credential for this call only", async () => {
    const out = await shimmed(
      "fly deploy --app box; echo after: ${FLY_API_TOKEN:-unset}",
      {
        fly: tool.shim(({ argv }) => {
          return run({ env: { FLY_API_TOKEN: `tok-for-${argv[0]}` } });
        }),
      },
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
      {
        fly: tool.shim(({ argv }) => {
          return run({ argv: [...argv, "--dry-run"] });
        }),
      },
      fakeBin(),
    );

    expect(out.stdout).toBe("fly deploy --dry-run token=none\n");
  });

  test("decline: exits 126 with the message and never runs the program", async () => {
    const out = await shimmed(
      "fly destroy",
      {
        fly: tool.shim(({ name }) => {
          return refuse(name, "destroy is not allowed here");
        }),
      },
      fakeBin(),
    );

    expect(out.code).toBe(126);
    expect(out.stderr).toBe("fly: destroy is not allowed here\n");
    expect(out.stdout).toBe("");
  });

  test("fake: answers without the program", async () => {
    const out = await shimmed("fly status", {
      fly: tool.shim(() => {
        return reply(0, { stdout: "all green\n" });
      }),
    });

    expect(out.stdout).toBe("all green\n");
  });

  test("a shim is found by a subprocess, not only the command itself", async () => {
    const out = await shimmed("sh -c 'sh -c \"fly nested\"'", {
      fly: tool.shim(() => {
        return reply(0, { stdout: "from host\n" });
      }),
    });

    expect(out.stdout).toBe("from host\n");
  });

  test("an unknown shim name from the sandbox is an error", async () => {
    const built = withShims(
      "true",
      {
        fly: tool.shim(() => {
          return reply(0);
        }),
      },
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
      }),
    ).rejects.toThrow("Unknown shim");
  });

  test("names the prelude relies on can't be shimmed", () => {
    expect(() => {
      return withShims(
        "true",
        {
          rm: tool.shim(() => {
            return reply(0);
          }),
        },
        { binary: testBinary },
      );
    }).toThrow("can't be shimmed");
  });

  test("shim names that could break the launcher are rejected", () => {
    expect(() => {
      return withShims(
        "true",
        {
          "a b; rm -rf /": tool.shim(() => {
            return reply(0);
          }),
        },
        { binary: testBinary },
      );
    }).toThrow("Invalid shim name");
  });
});

describe("inject and hostEnv", () => {
  let minted = 0;
  const inject = {
    fly: injectEnv({
      FLY_API_TOKEN: () => {
        minted++;

        return `minted-${minted}`;
      },
    }),
  };
  const fly = (): string => {
    const dir = temp();
    const file = join(dir, "fly");
    writeFileSync(file, '#!/bin/sh\necho "fly $* $FLY_API_TOKEN"\n');
    chmodSync(file, 0o755);

    return dir;
  };

  test("an inject-only shim is plain sh: reads the value from the host and runs the real program", async () => {
    const out = await shimmed("fly deploy; fly status", inject, fly());

    expect(out.stdout).toBe("fly deploy minted-1\nfly status minted-2\n");
    expect(out.calls).toEqual(["env", "env"]);
  });

  test("an inject shim still finds the real program when the code moves it in PATH", async () => {
    const out = await shimmed(
      'PATH="/usr/bin:$PATH" fly deploy; PATH="$PATH:/tmp" fly status',
      inject,
      fly(),
    );

    expect(out.stdout).toMatch(
      /^fly deploy minted-\d+\nfly status minted-\d+\n$/,
    );
  });

  test("hostEnv reads only allowed names, one value or an array", async () => {
    const built = withShims("true", {});
    const tools: SandboxTools = {
      env: hostEnvTool(hostEnvFrom({ A: "1", B: () => "2" })),
    };
    const out = await runWrapped(
      [
        "/bin/sh",
        "-c",
        "inngest-tool -r env A; echo; inngest-tool env A B; inngest-tool env C",
      ],
      tools,
    );

    expect(built.tools).toEqual({});
    expect(out.stdout).toBe('1\n["1","2"]\n');
    expect(out.stderr).toContain("Not allowed to read: C");
  });

  test("minted values are shared per run and scope", async () => {
    let count = 0;
    const mint = () => {
      count++;

      return `v${count}`;
    };
    const read = async (scope: string, runId: string) => {
      const env = hostEnvTool({
        T: { mint, ttl: 60_000, scope },
      }) as unknown as {
        run: (...args: unknown[]) => Promise<unknown>;
      };

      return env.run("T", { runId });
    };

    expect(await read("a", "run-1")).toBe("v1");
    expect(await read("a", "run-1")).toBe("v1");
    expect(await read("b", "run-1")).toBe("v2");
    expect(await read("a", "run-2")).toBe("v3");
  });

  test("a name list reads the host's environment", async () => {
    process.env.SHIM_TEST_VALUE = "from-host";
    const env = hostEnvTool(hostEnvFrom(["SHIM_TEST_VALUE"]));
    const out = await runWrapped(
      ["inngest-tool", "-r", "env", "SHIM_TEST_VALUE"],
      { env },
    );

    expect(out.stdout).toBe("from-host");
  });
});

describe("a credential helper written in sh", () => {
  test("git calls inngest-tool directly, with no shim and no node", async () => {
    const helper =
      '!f() { test "$1" = get || exit 0; inngest-tool -r --stdin gitCredential; }; f';
    const tools: SandboxTools = {
      gitCredential: internalTool({
        memo: "none",
        run: (stdin: string) => {
          return stdin.includes("host=github.com")
            ? "username=x-access-token\npassword=ghs_sh\n\n"
            : "";
        },
      }) as SandboxTools[string],
    };
    const out = await runWrapped(
      [
        "/bin/sh",
        "-c",
        "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill",
      ],
      tools,
      {
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_KEY_1: "credential.helper",
        GIT_CONFIG_VALUE_1: helper,
      },
    );

    expect(out.stdout).toContain("password=ghs_sh\n");
  });
});

describe.skipIf(!hasBinary)("gitCredentials", () => {
  const minted: string[] = [];
  const shims = gitCredentials({
    "github.com": ({ path }) => {
      minted.push(path ?? "");

      return { username: "x-access-token", password: "ghs_short" };
    },
  });

  test("git asks the helper, which answers from the host", async () => {
    const out = await shimmed(
      `printf 'protocol=https\\nhost=github.com\\npath=acme/app.git\\n\\n' | git -c credential.useHttpPath=true credential fill`,
      shims,
    );

    expect(out.stdout).toContain("username=x-access-token\n");
    expect(out.stdout).toContain("password=ghs_short\n");
    expect(minted).toEqual(["acme/app.git"]);
  });

  test("a host without a handler gets no credential and git gives up", async () => {
    const out = await shimmed(
      `printf 'protocol=https\\nhost=example.com\\n\\n' | GIT_TERMINAL_PROMPT=0 git credential fill`,
      shims,
    );

    expect(out.code).not.toBe(0);
  });

  test("store and erase are answered in the sandbox", async () => {
    const out = await shimmed(
      `printf 'protocol=https\\nhost=github.com\\nusername=u\\npassword=p\\n\\n' | git credential approve; git credential-inngest erase </dev/null`,
      shims,
    );

    expect(out.calls).toEqual([]);
  });
});
