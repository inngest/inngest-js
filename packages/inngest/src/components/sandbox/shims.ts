/**
 * @module
 * EXPERIMENTAL: Command shims. A shim stands in for a program on `PATH` inside
 * a sandbox command. When code runs it, the shim calls its handler in your app
 * through a tool, and the handler returns one of two things: run the real
 * program (optionally with another argv, extra environment or stdin), or
 * reply with an exit code, stdout and stderr. Declining, faking and running on
 * the host are all replies; injecting a credential and rewriting are runs.
 *
 * Shims are built on tools (`tools.ts`, `toolRunner.ts`), so each call is a
 * durable step. They are a convenience, a credential channel and an audit log,
 * not a boundary: code can call the real program by its absolute path.
 *
 * A shim with a handler is the `inngest-tool` binary under another name
 * (`toolBinary.ts`). A shim that only injects environment is a few lines of
 * `sh` that read each value with `inngest-tool env`.
 */
import { z } from "zod/v3";

import { internalTool } from "./internalTool.ts";
import type { ToolBinary } from "./toolBinary.ts";
import type { SandboxTool, SandboxToolContext, SandboxTools } from "./tools.ts";

/**
 * The tool every handler shim calls. The name of the shim travels in the
 * request.
 */
export const shimToolName = "inngestShim";

export const hostEnvToolName = "env";

const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const shimNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * What the shim hands its handler.
 */
export interface ShimCall {
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
}

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

export type ShimHandler = (
  call: ShimCall,
  ctx: SandboxToolContext,
) => ShimResult | Promise<ShimResult>;

/**
 * A value from the host: a literal, a function that makes one on each read, or
 * a function whose value is kept in host memory for `ttl` per run.
 */
export type HostEnvValue =
  | string
  | (() => string | Promise<string>)
  | { mint: () => string | Promise<string>; ttl: number };

export type HostEnv = Record<string, HostEnvValue>;

export interface ShimDefinition {
  description?: string;

  /**
   * Decides what the shim does.
   */
  handle?: ShimHandler;

  /**
   * Instead of a handler: environment variables for the real program, each
   * read from the host just before it runs. No call to a handler, no binary.
   */
  inject?: HostEnv;

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
   * the shim (see `gitCredentials`).
   */
  environment?: Record<string, string>;
}

/**
 * A shim made with `tool.shim()`, the only thing `shims` accepts.
 */
export interface SandboxShim extends ShimDefinition {
  readonly shim: true;
}

export type Shims = Record<string, SandboxShim>;

export const createShim = (
  definition: ShimDefinition | ShimHandler,
): SandboxShim => {
  const parsed: ShimDefinition =
    typeof definition === "function" ? { handle: definition } : definition;

  if (Boolean(parsed.handle) === Boolean(parsed.inject)) {
    throw new Error("A shim needs either a handle or inject, not both");
  }

  return { ...parsed, shim: true };
};

/**
 * Run the real program as it was called, or changed.
 */
export const run = (change: ShimRun["exec"] = {}): ShimRun => {
  return { exec: change };
};

/**
 * Answer without running anything.
 */
export const reply = (
  exit: number,
  output: { stdout?: string | Uint8Array; stderr?: string | Uint8Array } = {},
): ShimReply => {
  return { exit, ...output };
};

/**
 * Decline: exit 126 with the message on stderr.
 */
export const refuse = (name: string, message: string): ShimReply => {
  return reply(126, { stderr: `${name}: ${message}\n` });
};

/**
 * Environment variables for the real program, read from the host as it runs.
 */
export const injectEnv = (env: HostEnv): SandboxShim => {
  return createShim({ inject: env });
};

const callSchema = z.object({
  name: z.string().max(128),
  argv: z.array(z.string()),
  cwd: z.string(),
  stdin: z.string(),
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
    return result;
  }

  const { stdout, stderr, exit } = result;

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
export const shimTool = (shims: Shims): SandboxTool => {
  return internalTool({
    description: "Calls the handler of a command shim",
    memo: "none" as const,
    input: callSchema,
    run: async (call: z.infer<typeof callSchema>, ctx: SandboxToolContext) => {
      const shim = Object.hasOwn(shims, call.name)
        ? shims[call.name]
        : undefined;
      if (!shim?.handle) {
        throw new Error(`Unknown shim: ${call.name.slice(0, 64)}`);
      }

      return wireResult(await shim.handle(call, ctx));
    },
  }) as SandboxTool;
};

const mintedValues = new Map<
  string,
  { expires: number; value: Promise<string> }
>();

/**
 * The built-in `env` tool: `inngest-tool env NAME...` returns the value of
 * one name, or an array for several. Only names in `allowed` can be read.
 * A function is called on each read, so it can mint a fresh value; a
 * `{ mint, ttl }` value is kept in host memory for `ttl` milliseconds per run,
 * so repeated reads share one token and a worker change mints again. Results
 * are never stored in the run.
 */
export const hostEnvTool = (allowed: HostEnv): SandboxTool => {
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
        } else {
          const key = `${ctx.runId ?? ""}\0${String(name)}`;
          const now = Date.now();
          let hit = mintedValues.get(key);
          if (!hit || hit.expires <= now) {
            for (const [other, entry] of mintedValues) {
              if (entry.expires <= now) {
                mintedValues.delete(other);
              }
            }

            hit = {
              expires: now + source.ttl,
              value: Promise.resolve(source.mint()),
            };
            mintedValues.set(key, hit);
          }

          try {
            values.push(await hit.value);
          } catch (error) {
            mintedValues.delete(key);
            throw error;
          }
        }
      }

      return values.length === 1 ? values[0] : values;
    },
  }) as SandboxTool;
};

/**
 * The host variables that tools may read: a list of names read from the
 * host's environment, or names with values, functions or `{ mint, ttl }`.
 */
export const hostEnvFrom = (option: readonly string[] | HostEnv): HostEnv => {
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

/**
 * The launcher of a shim that only injects: reads each variable from the host
 * with `inngest-tool env`, then runs the real program with it.
 */
const injectLauncher = (name: string, variables: string[]): string => {
  const lines = [
    "#!/bin/sh",
    'PATH="${PATH#"${0%/*}":}"',
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
 * Writes the shim config and one launcher per name into a temporary
 * directory, puts that first on `PATH`, runs the command and removes the
 * directory. A handler shim is a symlink to the binary, which runs as the
 * shim when its name is not `inngest-tool`.
 */
const preludeScript = (
  launchers: string[],
  config: unknown,
  binaryPath: string | undefined,
): string => {
  return [
    `S=$(mktemp -d)`,
    `trap 'rm -rf "$S"' EXIT`,
    `mkdir "$S/bin"`,
    `cat > "$S/config.json" <<'INNGEST_SHIM_CONFIG'\n${JSON.stringify(config)}\nINNGEST_SHIM_CONFIG`,
    ...(binaryPath ? [`ln -s "${binaryPath}" "$S/bin/inngest-tool"`] : []),
    ...launchers,
    `export INNGEST_SHIMS_DIR="$S" PATH="$S/bin:$PATH"`,
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
 * Wraps `command` so that `shims` are first on `PATH` while it runs. `hostEnv`
 * adds names that `inngest-tool env` may read. Handler shims need `binary`.
 */
export const withShims = (
  command: string | readonly string[],
  shims: Shims,
  options: { binary?: ToolBinary; hostEnv?: HostEnv } = {},
): ShimmedCommand => {
  const names = Object.keys(shims);
  const allowed: HostEnv = { ...options.hostEnv };
  const launchers: string[] = [];
  const handlers = names.filter((name) => {
    return shims[name]?.handle;
  });

  for (const name of names) {
    if (!shimNamePattern.test(name)) {
      throw new Error(
        `Invalid shim name "${name}": use letters, digits, ".", "_" and "-", up to 64 characters`,
      );
    }
  }

  if (handlers.length > 0 && !options.binary) {
    throw new Error(
      `Shims with a handle (${handlers.join(", ")}) need the inngest-tool binary, which is not available here`,
    );
  }

  for (const [name, shim] of Object.entries(shims)) {
    if (shim.handle) {
      launchers.push(`ln -s "${options.binary?.path}" "$S/bin/${name}"`);

      continue;
    }

    const variables = Object.keys(shim.inject ?? {});
    for (const variable of variables) {
      if (!envNamePattern.test(variable) || Object.hasOwn(allowed, variable)) {
        throw new Error(`Invalid or repeated inject variable "${variable}"`);
      }

      allowed[variable] = (shim.inject as HostEnv)[variable] as HostEnvValue;
    }

    launchers.push(injectLauncher(name, variables));
  }

  const config = Object.fromEntries(
    Object.entries(shims).map(([name, { stdin, local }]) => {
      return [name, { stdin, local }];
    }),
  );
  const argv =
    typeof command === "string" ? ["/bin/sh", "-c", command] : command;
  const script = preludeScript(launchers, config, options.binary?.path);

  return {
    command: ["/bin/sh", "-c", script, "sh", ...argv],
    tools: {
      ...(handlers.length > 0 && { [shimToolName]: shimTool(shims) }),
      ...(Object.keys(allowed).length > 0 && {
        [hostEnvToolName]: hostEnvTool(allowed),
      }),
    },
    environment: Object.assign(
      {},
      ...names.map((name) => {
        return shims[name]?.environment ?? {};
      }),
    ),
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
 * A git credential helper backed by your app. Git asks it for a credential
 * when a fetch or push needs one, and the handler for that host mints it, so
 * the real `git` talks to the real remote with a token that lives for one
 * operation. A host without a handler gets no credential. Spread it into
 * `shims`.
 *
 * The token is readable by code in the sandbox (`git credential fill` prints
 * it), so mint tokens scoped to one repository that expire quickly. It is
 * never stored in the run.
 *
 * @example
 * ```ts
 * await sandbox.commands.run("ship", "git push origin HEAD", {
 *   shims: {
 *     ...gitCredentials({
 *       "github.com": async ({ path }) => {
 *         return { username: "x-access-token", password: await mint(path) };
 *       },
 *     }),
 *   },
 * });
 * ```
 */
export const gitCredentials = (
  hosts: Record<
    string,
    (request: GitCredentialRequest) => GitCredential | Promise<GitCredential>
  >,
): Shims => {
  return {
    "git-credential-inngest": createShim({
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
      handle: async ({ argv, stdin }) => {
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
    }),
  };
};
