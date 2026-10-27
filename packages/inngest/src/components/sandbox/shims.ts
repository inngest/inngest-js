/**
 * @module
 * EXPERIMENTAL: Command shims. A shim stands in for a program on `PATH` inside
 * a sandbox command. When code runs it, the shim calls its handler in your app
 * through a tool, and the handler returns one of two things: run the real
 * program (optionally with another argv, extra environment or stdin), or
 * reply with an exit code, stdout and stderr. Declining, faking and doing the
 * work in your app are all replies; rewriting is a run.
 *
 * Credentials never enter the sandbox. A handler that needs one does the work
 * in your app and replies with the result: it gets the `sandbox` of its
 * command to move files in and out (see `tool.shim.git()`, which pushes from
 * your app with a token only your app holds). `run()` is for programs that
 * need no secret.
 *
 * Shims are made with `tool.shim()` and passed in `shims` on `commands.run()`
 * or `$`. `tool.shim.git()` and `tool.shim.config()` are shims for the common
 * cases.
 *
 * Shims are built on tools (`tools.ts`, `toolRunner.ts`). They are a
 * convenience and an audit log, not a boundary: code can call the real
 * program by its absolute path, and until egress is closed it can reach the
 * network without them.
 *
 * A handler runs in the step that replies to the sandbox, so a retry of that
 * step runs it again: keep it safe to repeat (it gets a stable idempotency
 * key). Its time adds to that step, and calls answered in one round wait for
 * the slowest of them.
 *
 * A shim is the `inngest-tool` binary under another name (`toolBinary.ts`).
 * Code in the sandbox finds out what is shimmed with `inngest-tool shims`
 * (every shim and the config it may read); `INNGEST_SHIMS` lists the shimmed
 * program names.
 */
import { z } from "zod/v3";

import { type GitShimOptions, gitShimDefinition } from "./gitShim.ts";
import { internalTool } from "./internalTool.ts";
import type { ToolBinary } from "./toolBinary.ts";
import type { SandboxTool, SandboxToolContext, SandboxTools } from "./tools.ts";
import { type Sandbox, SandboxValidationError } from "./types.ts";

/**
 * The tool every handler shim calls. The name of the shim travels in the
 * request.
 */
export const shimToolName = "inngestShim";

export const configToolName = "config";

const envNamePattern = /^(?!__proto__$)[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const shimNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Names the prelude itself relies on, which a shim would replace on `PATH`.
 */
const reservedShimNames = new Set([
  "inngest-tool",
  ...["sh", "rm", "cat", "ln", "chmod", "mktemp", "mkdir", "env"],
  ...["sed", "grep", "tail", "wc", "dd", "sleep", "tr", "head", "tee"],
  ...["base64", "gunzip", "dirname", "basename", "test", "printf", "echo"],
]);

/**
 * Run the real program, found on `PATH` without the shims. Each field
 * replaces what the code passed.
 */
export interface ShimRun {
  exec: {
    argv?: string[];

    /**
     * Added to the environment of this one process. Never stored in the run.
     */
    env?: Record<string, string>;
    stdin?: string;
  };
}

/**
 * End the shim with this exit code and output, without running anything.
 */
export interface ShimReply {
  exit: number;
  stdout?: string | Uint8Array;
  stderr?: string | Uint8Array;
}

/**
 * What a handler returns. Nothing means run the program as it was called.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: a handler that returns nothing has the type void
export type ShimResult = ShimRun | ShimReply | undefined | void;

/**
 * What a handler receives: the call, and the ways to answer it.
 */
export interface ShimCall extends SandboxToolContext {
  /**
   * The sandbox the command runs in. The command waits for the handler, so it
   * can run commands in the sandbox and read and write its files meanwhile.
   * These calls aren't steps of their own: they belong to the step that
   * answers the shim, so a retry repeats them.
   */
  sandbox: Sandbox;

  /**
   * The shim that was run, such as `git` or `fly`.
   */
  name: string;
  argv: string[];
  cwd: string;

  /**
   * Text read from stdin. Empty unless the shim declares `stdin: true`.
   */
  stdin: string;

  /**
   * Run the real program as it was called, or changed: another `argv`, extra
   * `env` for this one process, other `stdin`.
   */
  run: (change?: ShimRun["exec"]) => ShimRun;

  /**
   * Answer without running anything.
   */
  reply: (
    exit: number,
    output?: { stdout?: string | Uint8Array; stderr?: string | Uint8Array },
  ) => ShimReply;

  /**
   * Decline: exit 126 with `<name>: <message>` on stderr.
   */
  refuse: (message: string) => ShimReply;
}

export type ShimHandler = (call: ShimCall) => ShimResult | Promise<ShimResult>;

/**
 * Plain strings code in the sandbox may read with `inngest-tool config NAME`.
 */
export type ShimConfig = Record<string, string>;

export interface ShimOptions {
  /**
   * What the shim does, shown to code that runs `inngest-tool shims`.
   */
  description?: string;

  /**
   * Read stdin and send it with the call. Off by default, since reading an
   * inherited pipe nobody writes to would hang.
   */
  stdin?: boolean;

  /**
   * Answers by first argument inside the sandbox, with no call to your app,
   * for arguments whose answer never depends on it.
   */
  local?: Record<string, { exit: number; stdout?: string; stderr?: string }>;

  /**
   * Call the handler only when one of these words is an argument, such as
   * `["push", "clone"]`. Any other call runs the real program at once, with
   * no round trip to your app.
   */
  only?: string[];
}

/**
 * What a shim does: a handler that decides.
 */
export interface ShimDefinition extends ShimOptions {
  /**
   * Decides what the shim does.
   */
  handle: ShimHandler;
}

/**
 * A program shim, made with `tool.shim()`.
 */
export type ProgramShim = ShimDefinition & {
  readonly shim: true;
  readonly kind: "program";
  readonly name: string;
};

/**
 * The values code may read with `inngest-tool config`, made with
 * `tool.shim.config()`.
 */
export interface ConfigShim {
  readonly shim: true;
  readonly kind: "config";
  readonly allowed: ShimConfig;
  readonly description?: string;
}

/**
 * What `shims` accepts, and nothing else.
 */
export type SandboxShim = ProgramShim | ConfigShim;

/**
 * Checks a config: variable names and string values.
 */
export const validateConfig = (option: unknown): void => {
  const entries: [unknown, unknown][] =
    option && typeof option === "object" && !Array.isArray(option)
      ? Object.entries(option)
      : [];

  if (entries.length === 0) {
    throw new SandboxValidationError(
      "A config needs at least one name and value",
    );
  }

  for (const [name, value] of entries) {
    if (
      typeof name !== "string" ||
      !envNamePattern.test(name) ||
      typeof value !== "string"
    ) {
      throw new SandboxValidationError(
        `Invalid entry "${String(name).slice(0, 64)}": names are variable names and values are strings`,
      );
    }
  }
};

const run: ShimCall["run"] = (change = {}) => {
  return { exec: change };
};

const reply: ShimCall["reply"] = (exit, output = {}) => {
  return { exit, ...output };
};

const plainLine = (text: string): string => {
  return Array.from(text)
    .map((char) => {
      const code = char.charCodeAt(0);

      return code < 32 || code === 127 ? " " : char;
    })
    .join("")
    .slice(0, 200);
};

/**
 * EXPERIMENTAL: A program that stands in for the real one inside a sandbox
 * command. See the module comment.
 */
const shim = (
  name: string,
  definition: ShimDefinition | ShimHandler,
): ProgramShim => {
  const parsed: ShimDefinition =
    typeof definition === "function" ? { handle: definition } : definition;

  if (typeof name !== "string" || !shimNamePattern.test(name)) {
    throw new SandboxValidationError(
      `Invalid shim name "${String(name).slice(0, 64)}": use letters, digits, ".", "_" and "-", up to 64 characters`,
    );
  }

  if (reservedShimNames.has(name)) {
    throw new SandboxValidationError(
      `"${name}" can't be shimmed: the shims rely on it`,
    );
  }

  if (typeof parsed.handle !== "function") {
    throw new SandboxValidationError("handle must be a function");
  }

  if (
    parsed.only !== undefined &&
    !(
      Array.isArray(parsed.only) &&
      parsed.only.length > 0 &&
      parsed.only.every((word) => {
        return typeof word === "string" && word !== "";
      })
    )
  ) {
    throw new SandboxValidationError(
      'only is a list of words, such as ["push"]',
    );
  }

  for (const [first, answer] of Object.entries(parsed.local ?? {})) {
    if (
      !Number.isInteger(answer?.exit) ||
      answer.exit < 0 ||
      answer.exit > 255 ||
      (answer.stdout !== undefined && typeof answer.stdout !== "string") ||
      (answer.stderr !== undefined && typeof answer.stderr !== "string")
    ) {
      throw new SandboxValidationError(
        `local.${first} needs an exit code from 0 to 255 and text output`,
      );
    }
  }

  return { ...parsed, shim: true, kind: "program", name };
};

/**
 * EXPERIMENTAL: The `git` action shim. `git clone` and `git fetch` run on the
 * host and unpack into the sandbox; `git push` is bundled in the sandbox,
 * brought home, checked by `policy` and pushed from the host. The token is made
 * on the host for each operation and never enters the sandbox. Other git
 * commands run the real git in the sandbox. See `gitShim.ts`.
 *
 * @example
 * ```ts
 * const git = tool.shim.git({
 *   remote: "https://github.com/acme/app.git",
 *   token: () => installationToken("acme/app"),
 *   policy: async (push) => {
 *     if (!push.branch?.startsWith("agent/")) {
 *       return { refuse: "agents push to agent/* branches" };
 *     }
 *   },
 * });
 *
 * await sandbox.$({ shims: [git] }).sh`git clone https://github.com/acme/app.git work`;
 * ```
 */
shim.git = (options: GitShimOptions): ProgramShim => {
  return shim("git", gitShimDefinition(options));
};

/**
 * EXPERIMENTAL: The values code in the sandbox may read with
 * `inngest-tool config NAME`, and nothing else: plain settings such as a
 * region or a registry URL, never secrets. A list of names reads their values from
 * the app's environment; an object gives them.
 *
 * @example
 * ```ts
 * await sandbox.$({
 *   shims: [tool.shim.config({ REGION: "iad" })],
 * }).sh`./deploy.sh "$(inngest-tool -r config REGION)"`;
 * ```
 */
shim.config = (
  source: readonly string[] | ShimConfig,
  options: Pick<ShimOptions, "description"> = {},
): ConfigShim => {
  const allowed = configFrom(source);
  validateConfig(allowed);

  return {
    shim: true,
    kind: "config",
    allowed,
    description:
      options.description ??
      `values to read with inngest-tool config NAME: ${Object.keys(allowed).join(", ")}`,
  };
};

const configFrom = (option: readonly string[] | ShimConfig): ShimConfig => {
  if (!Array.isArray(option)) {
    return option as ShimConfig;
  }

  return Object.fromEntries(
    option.map((name: string) => {
      const value = process.env[name];
      if (value === undefined) {
        throw new SandboxValidationError(`${name} is not set`);
      }

      return [name, value];
    }),
  );
};

const callSchema = z.object({
  name: z.string().max(128),
  argv: z.array(z.string().max(32_768)).max(512),
  cwd: z.string().max(4_096),
  stdin: z.string().max(128 * 1024),
});

const toBase64 = (bytes: Uint8Array): string => {
  return Buffer.from(bytes).toString("base64");
};

/**
 * What goes over the wire: bytes travel as base64 fields.
 */
const wireResult = (result: ShimResult) => {
  if (!result) {
    return { exec: {} };
  }

  if ("exec" in result) {
    const { argv, env, stdin } = result.exec;
    if (
      (argv !== undefined &&
        !(
          Array.isArray(argv) && argv.every((arg) => typeof arg === "string")
        )) ||
      (stdin !== undefined && typeof stdin !== "string") ||
      (env !== undefined &&
        !(
          env !== null &&
          typeof env === "object" &&
          Object.values(env).every((value) => typeof value === "string")
        ))
    ) {
      throw new Error(
        "run() takes argv as strings, env as a record of strings and stdin as text",
      );
    }

    return result;
  }

  const { stdout, stderr, exit } = result;
  if (!Number.isInteger(exit) || exit < 0 || exit > 255) {
    throw new Error(
      "A shim handler must return run(), reply() or refuse(), with an exit code from 0 to 255",
    );
  }

  return {
    exit,
    ...(typeof stdout === "string" && { stdout }),
    ...(stdout instanceof Uint8Array && { stdoutB64: toBase64(stdout) }),
    ...(typeof stderr === "string" && { stderr }),
    ...(stderr instanceof Uint8Array && { stderrB64: toBase64(stderr) }),
  };
};

/**
 * The one tool behind all handler shims. It answers inline in the step that
 * replies to the sandbox, so nothing is stored: a handler may return a
 * credential in `exec.env`. An unknown shim name is an error, since the name
 * comes from the sandbox.
 */
const shimTool = (shims: ProgramShim[]): SandboxTool => {
  const handlers = new Map(
    shims.map((one) => {
      return [one.name, one.handle] as const;
    }),
  );

  return internalTool({
    description: "Calls the handler of a command shim",
    memo: "none" as const,
    input: callSchema,
    run: async (call: z.infer<typeof callSchema>, ctx: SandboxToolContext) => {
      const handle = handlers.get(call.name);
      if (!handle) {
        throw new Error(`Unknown shim: ${call.name.slice(0, 64)}`);
      }

      if (!ctx.sandbox) {
        throw new Error("A shim handler needs the sandbox of its command");
      }

      return wireResult(
        await handle({
          ...ctx,
          sandbox: ctx.sandbox,
          ...call,
          run,
          reply,
          refuse: (message) => {
            return reply(126, { stderr: `${call.name}: ${message}\n` });
          },
        }),
      );
    },
  }) as SandboxTool;
};

/**
 * The built-in `config` tool: `inngest-tool config NAME...` returns the value
 * of one name, or an array for several. Only names in `allowed` can be read.
 */
const configTool = (allowed: ShimConfig): SandboxTool => {
  return internalTool({
    description: "Reads the allowed config values of the host",
    memo: "none" as const,
    run: (...args: unknown[]) => {
      // A tool without an input schema receives its context last.
      const values = args.slice(0, -1).map((name) => {
        if (typeof name !== "string" || !Object.hasOwn(allowed, name)) {
          throw new Error(`Not allowed to read: ${String(name).slice(0, 64)}`);
        }

        return allowed[name] as string;
      });

      return values.length === 1 ? values[0] : values;
    },
  }) as SandboxTool;
};

/**
 * Runs as "/bin/sh -c <prelude> sh <command...>", inside the tools wrapper.
 * Writes the shim config, the list `inngest-tool shims` prints and one
 * launcher per name into a temporary directory, puts that first on `PATH`,
 * runs the command and removes the directory. A handler shim is a symlink to
 * the binary, which runs as the shim when its name is not `inngest-tool`.
 */
const preludeScript = (
  launchers: string[],
  config: unknown,
  manifest: string,
  names: string[],
  binaryPath: string | undefined,
): string => {
  return [
    `S=$(mktemp -d)`,
    `trap 'rm -rf "$S"' EXIT`,
    `mkdir "$S/bin"`,
    `cat > "$S/config.json" <<'INNGEST_SHIM_CONFIG'\n${JSON.stringify(config)}\nINNGEST_SHIM_CONFIG`,
    `cat > "$S/shims.txt" <<'INNGEST_SHIM_LIST'\n${manifest}\nINNGEST_SHIM_LIST`,
    ...(binaryPath ? [`ln -s "${binaryPath}" "$S/bin/inngest-tool"`] : []),
    ...launchers,
    `export INNGEST_SHIMS_DIR="$S" INNGEST_SHIMS="${names.join(",")}" PATH="$S/bin:$PATH"`,
    `"$@"`,
    `exit $?`,
  ].join("\n");
};

/**
 * What a command with shims runs as: the shims around it and the tools they
 * call.
 */
export interface ShimmedCommand {
  command: string[];
  tools: SandboxTools;
}

/**
 * Checks what `shims` holds: only shims made by `tool.shim`, and no name twice.
 */
export const validateShims = (shims: unknown): readonly SandboxShim[] => {
  if (!Array.isArray(shims)) {
    throw new SandboxValidationError(
      "shims must be a list of tool.shim() values",
    );
  }

  const seen = new Set<string>();
  for (const one of shims as { shim?: unknown; kind?: unknown }[]) {
    if (one?.shim !== true) {
      throw new SandboxValidationError(
        "shims accepts only values made with tool.shim()",
      );
    }

    const key =
      one.kind === "program" ? (one as ProgramShim).name : configToolName;
    if (seen.has(key)) {
      throw new SandboxValidationError(
        key === configToolName
          ? "Only one tool.shim.config() can be passed"
          : `The shim "${key}" is passed twice`,
      );
    }

    seen.add(key);
  }

  return shims as readonly SandboxShim[];
};

/**
 * Wraps `command` so that `shims` are first on `PATH` while it runs. Program
 * shims need `binary`.
 */
export const withShims = (
  command: string | readonly string[],
  shims: readonly SandboxShim[],
  options: { binary?: ToolBinary } = {},
): ShimmedCommand => {
  const programs = shims.filter((one): one is ProgramShim => {
    return one.kind === "program";
  });
  const allowed: ShimConfig = {};
  const lines: string[] = [];
  const launchers: string[] = [];

  for (const one of shims) {
    if (one.kind === "config") {
      Object.assign(allowed, one.allowed);
      lines.push(
        `${configToolName}: ${plainLine(one.description ?? "values you can read with inngest-tool config NAME")}`,
      );
    }
  }

  if (programs.length > 0 && !options.binary) {
    throw new SandboxValidationError(
      `Shims (${programs
        .map((one) => {
          return one.name;
        })
        .join(
          ", ",
        )}) need the inngest-tool binary, which is not available here (run pnpm build:sandbox-tool in packages/inngest, or set INNGEST_SANDBOX_TOOL to its path)`,
    );
  }

  for (const one of programs) {
    lines.push(
      `${one.name}: ${plainLine(one.description ?? "handled by the host")}`,
    );
    launchers.push(`ln -s "${options.binary?.path}" "$S/bin/${one.name}"`);
  }

  const config = Object.fromEntries(
    programs.map(({ name, stdin, local, only }) => {
      return [name, { stdin, local, only }];
    }),
  );
  const argv =
    typeof command === "string" ? ["/bin/sh", "-c", command] : command;
  const script = preludeScript(
    launchers,
    config,
    lines.join("\n"),
    programs.map((one) => {
      return one.name;
    }),
    options.binary?.path,
  );

  return {
    command: ["/bin/sh", "-c", script, "sh", ...argv],
    tools: {
      ...(programs.length > 0 && { [shimToolName]: shimTool(programs) }),
      ...(Object.keys(allowed).length > 0 && {
        [configToolName]: configTool(allowed),
      }),
    },
  };
};

export type {
  GitPolicyResult,
  GitPush,
  GitShimOptions,
} from "./gitShim.ts";
export { shim };
