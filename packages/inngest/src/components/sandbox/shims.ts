/**
 * @module
 * EXPERIMENTAL: Command shims. A shim stands in for a program on `PATH` inside
 * a sandbox command. When code runs it, the shim calls its handler in your app
 * through a tool, and the handler returns one of two things: run the real
 * program (optionally with another argv, extra environment or stdin), or
 * reply with an exit code, stdout and stderr. Declining, faking and running on
 * the host are all replies; injecting a credential and rewriting are runs.
 *
 * Shims are made with `tool.shim()` and passed in `shims` on `commands.run()`
 * or `$`. `tool.shim.injectEnv()`, `tool.shim.gitCredentials()` and
 * `tool.shim.hostEnv()` are small shims built on the same pieces.
 *
 * Shims are built on tools (`tools.ts`, `toolRunner.ts`). They are a
 * convenience, a credential channel and an audit log, not a boundary: code can
 * call the real program by its absolute path.
 *
 * A handler runs in the step that replies to the sandbox, so a retry of that
 * step runs it again: keep it safe to repeat (it gets a stable idempotency
 * key), and expect a credential to be minted again. Its time adds to that
 * step, and calls answered in one round wait for the slowest of them.
 *
 * A shim with a handler is the `inngest-tool` binary under another name
 * (`toolBinary.ts`). A shim that only injects environment is a few lines of
 * `sh` that read each value with `inngest-tool env`. Code in the sandbox finds
 * out what is shimmed with `inngest-tool shims` (every shim and the host
 * values it may read); `INNGEST_SHIMS` lists the shimmed program names.
 */
import { z } from "zod/v3";

import { internalTool } from "./internalTool.ts";
import type { ToolBinary } from "./toolBinary.ts";
import type { SandboxTool, SandboxToolContext, SandboxTools } from "./tools.ts";
import { SandboxValidationError } from "./types.ts";

/**
 * The tool every handler shim calls. The name of the shim travels in the
 * request.
 */
export const shimToolName = "inngestShim";

export const hostEnvToolName = "env";

const envNamePattern = /^(?!__proto__$)[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * Variables an injecting shim can't set: the launcher itself relies on them.
 */
const reservedVariables = /^(PATH|IFS|INNGEST_.*)$/;

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
 * A value from the host: a literal, a function that makes one on each read, or
 * a function whose value is kept in host memory for `ttl` per run.
 */
export type HostEnvValue =
  | string
  | (() => string | Promise<string>)
  | {
      mint: () => string | Promise<string>;
      ttl: number;
      scope?: string;
    };

export type HostEnv = Record<string, HostEnvValue>;

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
   * Added to the command's environment, for programs that must be told about
   * the shim (see `tool.shim.gitCredentials`).
   */
  environment?: Record<string, string>;
}

/**
 * What a shim does: a handler that decides, or `inject` alone.
 */
export type ShimDefinition = ShimOptions &
  (
    | {
        /**
         * Decides what the shim does.
         */
        handle: ShimHandler;
        inject?: never;
      }
    | {
        /**
         * Instead of a handler: environment variables for the real program,
         * each read from the host just before it runs. No call to a handler,
         * no binary.
         */
        inject: HostEnv;
        handle?: never;
      }
  );

/**
 * A program shim, made with `tool.shim()`.
 */
export type ProgramShim = ShimDefinition & {
  readonly shim: true;
  readonly kind: "program";
  readonly name: string;
};

/**
 * The values code may read with `inngest-tool env`, made with
 * `tool.shim.hostEnv()`.
 */
export interface HostEnvShim {
  readonly shim: true;
  readonly kind: "hostEnv";
  readonly allowed: HostEnv;
  readonly description?: string;
}

/**
 * What `shims` accepts, and nothing else.
 */
export type SandboxShim = ProgramShim | HostEnvShim;

/**
 * Checks a host environment: variable names, and values that are strings,
 * functions or `{ mint, ttl }`.
 */
export const validateHostEnv = (option: unknown): void => {
  const entries: [unknown, unknown][] =
    option && typeof option === "object" && !Array.isArray(option)
      ? Object.entries(option)
      : [];

  if (entries.length === 0) {
    throw new SandboxValidationError(
      "A host environment needs at least one name and value",
    );
  }

  for (const [name, source] of entries) {
    const valid =
      typeof source === "string" ||
      typeof source === "function" ||
      (typeof source === "object" &&
        source !== null &&
        typeof (source as { mint?: unknown }).mint === "function" &&
        Number.isFinite((source as { ttl?: unknown }).ttl) &&
        (source as { ttl: number }).ttl > 0);

    if (typeof name !== "string" || !envNamePattern.test(name) || !valid) {
      throw new SandboxValidationError(
        `Invalid entry "${String(name).slice(0, 64)}": names are variable names, values a string, a function or { mint, ttl }`,
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

  if (parsed.inject) {
    validateHostEnv(parsed.inject);

    if (parsed.stdin || parsed.local) {
      throw new SandboxValidationError(
        "stdin and local are for shims with a handle",
      );
    }
  }

  if (parsed.handle && typeof parsed.handle !== "function") {
    throw new SandboxValidationError("handle must be a function");
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

  // The type says so; this catches callers that cast.
  if (Boolean(parsed.handle) === Boolean(parsed.inject)) {
    throw new SandboxValidationError(
      "A shim needs either a handle or inject, not both",
    );
  }

  return { ...parsed, shim: true, kind: "program", name };
};

/**
 * EXPERIMENTAL: A shim that only injects environment variables for the real
 * program, each read from the host when the program starts.
 *
 * @example
 * ```ts
 * await sandbox.$({
 *   shims: [
 *     tool.shim.injectEnv("fly", { FLY_API_TOKEN: () => mintDeployToken(app) }),
 *   ],
 * }).sh`fly deploy`;
 * ```
 */
shim.injectEnv = (
  name: string,
  env: HostEnv,
  options: Pick<ShimOptions, "description"> = {},
): ProgramShim => {
  return shim(name, {
    inject: env,
    description:
      options.description ??
      `runs with ${Object.keys(env).join(", ")} set by the host`,
  });
};

/**
 * EXPERIMENTAL: The values code in the sandbox may read with
 * `inngest-tool env NAME`, and nothing else. A list of names reads them from
 * the host's environment; an object gives values, functions that mint one on
 * each read, or `{ mint, ttl, scope }` kept in host memory for `ttl`
 * milliseconds per run, name and scope. The values are never stored in the
 * run.
 *
 * @example
 * ```ts
 * await sandbox.$({
 *   shims: [
 *     tool.shim.hostEnv({
 *       REGION: "iad",
 *       GH_TOKEN: { mint: () => ghToken(repo), ttl: 600_000, scope: repo },
 *     }),
 *   ],
 * }).sh`TOKEN=$(inngest-tool -r env GH_TOKEN) ./deploy.sh`;
 * ```
 */
shim.hostEnv = (
  source: readonly string[] | HostEnv,
  options: Pick<ShimOptions, "description"> = {},
): HostEnvShim => {
  const allowed = hostEnvFrom(source);
  validateHostEnv(allowed);

  return {
    shim: true,
    kind: "hostEnv",
    allowed,
    description:
      options.description ??
      `values to read with inngest-tool env NAME: ${Object.keys(allowed).join(", ")}`,
  };
};

const hostEnvFrom = (option: readonly string[] | HostEnv): HostEnv => {
  if (!Array.isArray(option)) {
    return option as HostEnv;
  }

  return Object.fromEntries(
    option.map((name: string) => {
      return [
        name,
        () => {
          const value = process.env[name];
          if (value === undefined) {
            throw new Error(`${name} is not set on the host`);
          }

          return value;
        },
      ];
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
    shims.flatMap((one) => {
      return one.handle ? [[one.name, one.handle] as const] : [];
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

      return wireResult(
        await handle({
          ...ctx,
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

const sourceCache = new Map<
  string,
  { expires: number; value: Promise<string> }
>();

/**
 * The built-in `env` tool: `inngest-tool env NAME...` returns the value of
 * one name, or an array for several. Only names in `allowed` can be read.
 * A function is called on each read, so it can mint a fresh value; a
 * `{ mint, ttl }` value is kept in host memory for `ttl` milliseconds per run,
 * so repeated reads share one token and a worker change mints again. There is
 * one cached value per name and `scope` per run: give commands that mint
 * different things for one name (a token per repository, say) different
 * scopes. Results are never stored in the run.
 */
const hostEnvTool = (allowed: HostEnv): SandboxTool => {
  return internalTool({
    description: "Reads allowed environment values of the host",
    memo: "none" as const,
    run: async (...args: unknown[]) => {
      // A tool without an input schema receives its context last.
      const ctx = args.at(-1) as SandboxToolContext;
      const values: string[] = [];

      for (const name of args.slice(0, -1)) {
        const source =
          typeof name === "string" && Object.hasOwn(allowed, name)
            ? allowed[name]
            : undefined;
        if (source === undefined) {
          throw new Error(`Not allowed to read: ${String(name).slice(0, 64)}`);
        }

        if (typeof source === "string") {
          values.push(source);
        } else if (typeof source === "function") {
          values.push(await source());
        } else if (!ctx.runId) {
          // Without a run there is no one to share a value with.
          values.push(await source.mint());
        } else {
          const key = `${ctx.runId}\0${String(name)}\0${source.scope ?? ""}`;
          const now = Date.now();
          let hit = sourceCache.get(key);
          if (!hit || hit.expires <= now) {
            for (const [other, entry] of sourceCache) {
              if (entry.expires <= now) {
                sourceCache.delete(other);
              }
            }

            hit = {
              expires: now + source.ttl,
              value: Promise.resolve(source.mint()),
            };
            sourceCache.set(key, hit);
          }

          try {
            values.push(await hit.value);
          } catch (error) {
            sourceCache.delete(key);
            throw error;
          }
        }
      }

      return values.length === 1 ? values[0] : values;
    },
  }) as SandboxTool;
};

/**
 * The launcher of a shim that only injects: reads each variable from the host
 * with `inngest-tool env`, then runs the real program with it.
 */
const injectLauncher = (name: string, variables: string[]): string => {
  const lines = [
    "#!/bin/sh",
    // Drop the shims directory wherever the code moved it to in PATH.
    "d=${0%/*}",
    "set -f",
    "p=; IFS=:",
    'for e in $PATH; do [ "$e" = "$d" ] || p="$p${p:+:}$e"; done',
    "unset IFS",
    "PATH=$p",
    ...variables.map((variable) => {
      return `${variable}=$(inngest-tool -r env ${variable}) || exit 125`;
    }),
    `export ${variables.join(" ")}`,
    `exec ${name} "$@"`,
  ];

  return `cat > "$S/bin/${name}" <<'INNGEST_SHIM_SH'\n${lines.join("\n")}\nINNGEST_SHIM_SH\nchmod +x "$S/bin/${name}"`;
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
 * What a command with shims runs as: the shims around it, the tools they
 * call, and the environment they need.
 */
export interface ShimmedCommand {
  command: string[];
  tools: SandboxTools;
  environment: Record<string, string>;
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
      one.kind === "program" ? (one as ProgramShim).name : hostEnvToolName;
    if (seen.has(key)) {
      throw new SandboxValidationError(
        key === hostEnvToolName
          ? "Only one tool.shim.hostEnv() can be passed"
          : `The shim "${key}" is passed twice`,
      );
    }

    seen.add(key);
  }

  return shims as readonly SandboxShim[];
};

/**
 * Wraps `command` so that `shims` are first on `PATH` while it runs. Handler
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
  const allowed: HostEnv = {};
  const lines: string[] = [];
  const launchers: string[] = [];
  const handlers = programs.filter((one) => {
    return one.handle;
  });

  for (const one of shims) {
    if (one.kind === "hostEnv") {
      Object.assign(allowed, one.allowed);
      lines.push(
        `${hostEnvToolName}: ${plainLine(one.description ?? "values you can read with inngest-tool env NAME")}`,
      );
    }
  }

  if (handlers.length > 0 && !options.binary) {
    throw new SandboxValidationError(
      `Shims with a handle (${handlers
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

    if (one.handle) {
      launchers.push(`ln -s "${options.binary?.path}" "$S/bin/${one.name}"`);

      continue;
    }

    const variables = Object.keys(one.inject ?? {});
    for (const variable of variables) {
      if (reservedVariables.test(variable)) {
        throw new SandboxValidationError(
          `The variable "${variable}" can't be injected: the shims rely on it`,
        );
      }

      if (Object.hasOwn(allowed, variable)) {
        throw new SandboxValidationError(
          `The variable "${variable}" is set by more than one shim`,
        );
      }

      allowed[variable] = (one.inject as HostEnv)[variable] as HostEnvValue;
    }

    launchers.push(injectLauncher(one.name, variables));
  }

  const config = Object.fromEntries(
    programs.map(({ name, stdin, local }) => {
      return [name, { stdin, local }];
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
  const environment: Record<string, string> = {};
  for (const one of programs) {
    for (const [key, value] of Object.entries(one.environment ?? {})) {
      if (Object.hasOwn(environment, key) && environment[key] !== value) {
        throw new SandboxValidationError(
          `Shims set ${key} to different values`,
        );
      }

      environment[key] = value;
    }
  }

  return {
    command: ["/bin/sh", "-c", script, "sh", ...argv],
    tools: {
      ...(handlers.length > 0 && { [shimToolName]: shimTool(handlers) }),
      ...(Object.keys(allowed).length > 0 && {
        [hostEnvToolName]: hostEnvTool(allowed),
      }),
    },
    environment,
  };
};

const parseCredentialRequest = (text: string): Record<string, string> => {
  const fields: Record<string, string> = {};

  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) {
      fields[line.slice(0, at)] = line.slice(at + 1);
    }
  }

  return fields;
};

export interface GitCredential {
  username: string;
  password: string;

  /**
   * Epoch seconds. Git forgets the credential after this, whatever a cache
   * helper says.
   */
  expiresAt?: number;
}

export interface GitCredentialRequest {
  protocol: string;
  host: string;

  /**
   * Set when git sends the path, which it does only with
   * `credential.useHttpPath`.
   */
  path?: string;
}

/**
 * EXPERIMENTAL: A git credential helper backed by your app. Git asks it for a
 * credential when a fetch or push needs one, and the handler for that host
 * mints it, so the real `git` talks to the real remote with a token that lives
 * for one operation. A host without a handler gets no credential.
 *
 * The token is readable by code in the sandbox (`git credential fill` prints
 * it), so mint tokens scoped to one repository that expire quickly. It is
 * never stored in the run.
 *
 * @example
 * ```ts
 * await sandbox.commands.run("ship", "git push origin HEAD", {
 *   shims: [
 *     tool.shim.gitCredentials({
 *       "github.com": async ({ path }) => {
 *         return { username: "x-access-token", password: await mint(path) };
 *       },
 *     }),
 *   ],
 * });
 * ```
 */
shim.gitCredentials = (
  hosts: Record<
    string,
    (request: GitCredentialRequest) => GitCredential | Promise<GitCredential>
  >,
): ProgramShim => {
  return shim("git-credential-inngest", {
    description: `git logins for ${Object.keys(hosts).join(", ")}, minted by the host for each operation`,
    stdin: true,
    // git calls "store" after a successful operation and "erase" after a
    // rejected one. Neither needs your app.
    local: { store: { exit: 0 }, erase: { exit: 0 } },
    // The empty value resets helpers configured elsewhere.
    environment: {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "inngest",
    },
    handle: async ({ argv, stdin, reply }) => {
      const fields = parseCredentialRequest(stdin);
      const mint =
        argv[0] === "get" && Object.hasOwn(hosts, fields.host ?? "")
          ? hosts[fields.host ?? ""]
          : undefined;
      if (!mint) {
        return reply(0);
      }

      const credential = await mint({
        protocol: fields.protocol ?? "https",
        host: fields.host ?? "",
        ...(fields.path !== undefined && { path: fields.path }),
      });
      if (
        credential.expiresAt !== undefined &&
        !Number.isFinite(credential.expiresAt)
      ) {
        throw new Error("expiresAt must be a number of epoch seconds");
      }

      // A newline would add fields to what git reads.
      if (/[\r\n\0]/.test(credential.username + credential.password)) {
        throw new Error("A git credential can't contain line breaks");
      }

      return reply(0, {
        stdout: [
          `username=${credential.username}`,
          `password=${credential.password}`,
          ...(credential.expiresAt === undefined
            ? []
            : [`password_expiry_utc=${credential.expiresAt}`]),
          "",
          "",
        ].join("\n"),
      });
    },
  });
};

export { shim };
