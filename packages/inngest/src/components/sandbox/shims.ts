/**
 * @module
 * EXPERIMENTAL: Command shims. A shim stands in for a program on `PATH` inside
 * a sandbox command. When code runs it, the shim calls a handler in your app
 * through a tool, and the handler answers with one of two actions: run the real
 * program (optionally with another argv, extra environment or stdin), or
 * reply with an exit code, stdout and stderr. Declining, faking and running on
 * the host are all replies; injecting a credential and rewriting are runs.
 *
 * Shims are built on tools (`tools.ts`, `toolRunner.ts`), so each call is a
 * durable step with the same limits: one command, 5 minutes, request and reply
 * sizes, no tty, output only when the shim exits. They are a convenience and a
 * credential channel, not a boundary: code can call the real program by its
 * absolute path.
 */
import { z } from "zod/v3";

import { type SandboxToolContext, type SandboxTools, tool } from "./tools.ts";

/**
 * The tool every shim calls. The name of the shim travels in the request.
 */
export const shimToolName = "inngestShim";

const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const shimNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * What a shim hands its handler.
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
 * Runs the real program, found on `PATH` without the shims. Each field
 * replaces what the code passed.
 */
export interface ShimRun {
  exec: {
    argv?: string[];

    /**
     * Added to the environment of this one process.
     */
    env?: Record<string, string>;
    stdin?: string;
  };
}

/**
 * Ends the shim with this exit code and output, without running anything.
 */
export interface ShimReply {
  exit: number;
  stdout?: string;
  stderr?: string;
}

export type ShimAction = ShimRun | ShimReply;

/**
 * A value from the host: a literal, or a function that makes one per call.
 */
export type HostEnvValue = string | (() => string | Promise<string>);

export type HostEnv = Record<string, HostEnvValue>;

export interface Shim {
  /**
   * Decides what the shim does. Without it, `inject` is the whole shim.
   */
  handle?: (
    call: ShimCall,
    ctx: SandboxToolContext,
  ) => ShimAction | Promise<ShimAction>;

  /**
   * Environment variables for the real program, each read from the host with
   * `inngest-tool env` just before it runs. The shim is then a few lines of
   * `sh`: no `node`, no handler. Values are secrets (never stored in the run).
   */
  inject?: HostEnv;

  /**
   * Read stdin and send it with the call. Off by default, since reading an
   * inherited pipe nobody writes to would hang.
   */
  stdin?: boolean;

  /**
   * Answers by first argument inside the sandbox, with no call home. For
   * arguments whose answer never depends on your app.
   */
  local?: Record<string, ShimReply>;

  /**
   * Added to the command's environment, for programs that must be told where
   * the shim is (see `gitCredentials`).
   */
  environment?: Record<string, string>;
}

export type Shims = Record<string, Shim>;

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
  output: { stdout?: string; stderr?: string } = {},
): ShimReply => {
  return { exit, ...output };
};

/**
 * Decline: exit 126 with the message on stderr.
 */
export const refuse = (name: string, message: string): ShimReply => {
  return reply(126, { stderr: `${name}: ${message}\n` });
};

const callSchema = z.object({
  name: z.string().max(128),
  argv: z.array(z.string()),
  cwd: z.string(),
  stdin: z.string(),
});

/**
 * The one tool behind all shims. An unknown shim name is an error, since the
 * name comes from the sandbox.
 */
export const shimTool = (shims: Shims): SandboxTools[string] => {
  return tool.step({
    description: "Calls the handler of a command shim",
    // A handler may return a credential in `exec.env`.
    memo: "none",
    input: callSchema,
    run: async (call, ctx) => {
      const shim = Object.hasOwn(shims, call.name)
        ? shims[call.name]
        : undefined;
      if (!shim) {
        throw new Error(`Unknown shim: ${call.name.slice(0, 64)}`);
      }

      if (!shim.handle) {
        throw new Error(`Shim ${call.name} has no handler`);
      }

      return await shim.handle(call, ctx);
    },
  });
};

/**
 * The built-in `env` tool: `inngest-tool env NAME...` returns the value of
 * one name, or an array for several. Only names in `allowed` can be read, and
 * a function is called on each read, so it can mint a fresh value. Results are
 * never stored (`memo: "none"`).
 */
export const hostEnvTool = (allowed: HostEnv): SandboxTools[string] => {
  return tool.step({
    description: "Reads allowed environment values of the host",
    memo: "none",
    run: async (...args: unknown[]) => {
      // A tool without an input schema receives its context last.
      const names = args.slice(0, -1);
      const values: string[] = [];

      for (const name of names) {
        const source =
          typeof name === "string" && Object.hasOwn(allowed, name)
            ? allowed[name]
            : undefined;
        if (source === undefined) {
          throw new Error(`Not allowed to read: ${String(name).slice(0, 64)}`);
        }

        values.push(typeof source === "function" ? await source() : source);
      }

      return values.length === 1 ? values[0] : values;
    },
  });
};

/**
 * The host variables that tools may read: a list of names read from the
 * host's environment, or names with the values or functions that produce them.
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
 * The JavaScript every shim runs. It needs `node` in the image, and finds
 * `inngest_tools` through the `NODE_PATH` the tools wrapper exports. Outside a
 * command with tools it runs the real program, so a shim never breaks a
 * command that does not use it.
 */
export const shimScript = String.raw`const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const [name, ...args] = process.argv.slice(2);
const dir = process.env.INNGEST_SHIMS_DIR;
const spec = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"))[name] || {};

const real = () => {
  const own = path.join(dir, "bin");
  for (const entry of (process.env.PATH || "").split(path.delimiter)) {
    if (entry === own) continue;
    const file = path.join(entry, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
};

const exec = (argv, env, input) => {
  const file = real();
  if (!file) {
    process.stderr.write(name + ": command not found\n");
    process.exit(127);
  }
  const out = spawnSync(file, argv, {
    stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    input,
    env: { ...process.env, ...env },
  });
  process.exit(out.status === null ? 128 + (os.constants.signals[out.signal] || 0) : out.status);
};

const finish = (action) => {
  if (action.exec) {
    return exec(action.exec.argv || args, action.exec.env, action.exec.stdin);
  }
  if (action.stdout) fs.writeSync(1, action.stdout);
  if (action.stderr) fs.writeSync(2, action.stderr);
  process.exit(action.exit);
};

(async () => {
  const local = spec.local && Object.hasOwn(spec.local, args[0]) ? spec.local[args[0]] : undefined;
  if (local) return finish(local);
  if (!process.env.INNGEST_TOOLS_DIR) return exec(args);
  const stdin = spec.stdin ? fs.readFileSync(0, "utf8") : "";
  const { tools } = require("inngest_tools");
  let action;
  try {
    action = await tools.${shimToolName}({ name, argv: args, cwd: process.cwd(), stdin });
  } catch (error) {
    process.stderr.write(name + ": " + error.message + "\n");
    process.exit(125);
  }
  finish(action);
})();
`;

/**
 * The launcher of a shim that only injects: reads each variable from the host
 * with `inngest-tool env`, then runs the real program with it. No `node`.
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
 * Writes the shim script, its config and one `sh` launcher per name into a
 * temporary directory, puts that first on `PATH`, runs the command and removes
 * the directory.
 */
const preludeScript = (
  script: string,
  names: string[],
  config: unknown,
  launchers: Record<string, string>,
): string => {
  return [
    `S=$(mktemp -d)`,
    `trap 'rm -rf "$S"' EXIT`,
    `mkdir "$S/bin"`,
    `cat > "$S/shim.js" <<'INNGEST_SHIM_JS'\n${script}INNGEST_SHIM_JS`,
    `cat > "$S/config.json" <<'INNGEST_SHIM_CONFIG'\n${JSON.stringify(config)}\nINNGEST_SHIM_CONFIG`,
    ...names.map((name) => {
      return (
        launchers[name] ??
        `printf '#!/bin/sh\\nexec node "%s/shim.js" ${name} "$@"\\n' "$S" > "$S/bin/${name}" && chmod +x "$S/bin/${name}"`
      );
    }),
    `export INNGEST_SHIMS_DIR="$S" PATH="$S/bin:$PATH"`,
    `"$@"`,
    `exit $?`,
  ].join("\n");
};

/**
 * What a command with shims runs as: the shims around it, the tool they call,
 * and the environment they need.
 */
export interface ShimmedCommand {
  command: string[];
  tools: SandboxTools;
  environment: Record<string, string>;
}

/**
 * Wraps `command` so that `shims` are first on `PATH` while it runs.
 */
export const withShims = (
  command: string | readonly string[],
  shims: Shims,
): ShimmedCommand => {
  const names = Object.keys(shims);

  for (const name of names) {
    if (!shimNamePattern.test(name)) {
      throw new Error(
        `Invalid shim name "${name}": use letters, digits, ".", "_" and "-", up to 64 characters`,
      );
    }
  }

  const config = Object.fromEntries(
    Object.entries(shims).map(([name, { stdin, local }]) => {
      return [name, { stdin, local }];
    }),
  );
  const argv =
    typeof command === "string" ? ["/bin/sh", "-c", command] : command;
  const allowed: HostEnv = {};
  const launchers: Record<string, string> = {};

  for (const [name, shim] of Object.entries(shims)) {
    if (!shim.handle && !shim.inject) {
      throw new Error(`Shim "${name}" needs a handle or inject`);
    }

    if (shim.inject && !shim.handle) {
      for (const [variable, source] of Object.entries(shim.inject)) {
        if (
          !envNamePattern.test(variable) ||
          Object.hasOwn(allowed, variable)
        ) {
          throw new Error(`Invalid or repeated inject variable "${variable}"`);
        }

        allowed[variable] = source;
      }

      launchers[name] = injectLauncher(name, Object.keys(shim.inject));
    }
  }

  const script = preludeScript(shimScript, names, config, launchers);
  const needsHandler = Object.values(shims).some((shim) => {
    return shim.handle;
  });

  return {
    command: ["/bin/sh", "-c", script, "sh", ...argv],
    tools: {
      ...(needsHandler && { [shimToolName]: shimTool(shims) }),
      ...(Object.keys(allowed).length > 0 && { env: hostEnvTool(allowed) }),
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
 * operation. A host without a handler gets no credential.
 *
 * The token is readable by code in the sandbox (`git credential fill` prints
 * it), so mint tokens scoped to one repository that expire quickly. It is
 * also step data: persisted for the life of the run, so use the encryption
 * middleware.
 *
 * @example
 * ```ts
 * await sandbox.commands.run("ship", "git push origin HEAD", {
 *   shims: gitCredentials({
 *     "github.com": async ({ path }) => {
 *       return { username: "x-access-token", password: await mint(path) };
 *     },
 *   }),
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
    "git-credential-inngest": {
      stdin: true,
      // git calls "store" after a successful operation and "erase" after a
      // rejected one. Neither needs your app.
      local: { store: reply(0), erase: reply(0) },
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
    },
  };
};
