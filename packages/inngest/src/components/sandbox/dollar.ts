/**
 * @module
 * `$`: run a command in a sandbox as one step, from a tagged template.
 * `` sandbox.$`/usr/bin/git status` `` runs argv with no shell,
 * `` sandbox.$.sh`a | b` `` runs a quoted shell command, and
 * `sandbox.$(options)` is a `$` with options set. Every sandbox handle has one.
 */

import {
  clip,
  commandErrorTextBytes,
  commandFailure,
  formatTimeout,
} from "./commandError.ts";
import { getSandboxError } from "./protocol.ts";
import type {
  DurableSandbox,
  SandboxCommand,
  SandboxCommandResult,
  SandboxDuration,
  SandboxExitCodes,
} from "./types.ts";
import {
  maxSandboxProcessTimeoutMs,
  normalizeDurationMs,
} from "./validation.ts";

/**
 * A value in a `$` template. Each becomes one argument, arrays spread into
 * several, and `null`, `undefined` and `false` are dropped.
 */
export type DollarValue =
  | string
  | number
  | boolean
  | readonly (string | number)[]
  | null
  | undefined;

/**
 * The options of a `$`, which a configured `$` keeps for every command it runs.
 */
export interface DollarOptions {
  /**
   * How long the command may run. Defaults to five minutes, the most that one
   * step can wait. A longer command runs as a process that several steps
   * follow, shown as one row, and its output is the last 512 KiB; a shorter
   * one fails on output that is too large.
   */
  timeout?: SandboxDuration;
  /**
   * Environment for this command, over the sandbox's. Values are kept out of
   * the trace.
   */
  env?: Record<string, string>;
  /**
   * The working directory.
   */
  cwd?: string;
  /**
   * The exit codes that are not failures. Defaults to `[0]`; `"any"` allows
   * them all.
   */
  exitCodes?: SandboxExitCodes;
}

type DollarTag = (
  strings: TemplateStringsArray,
  ...values: DollarValue[]
) => DollarPromise;

/**
 * The promise of a command's result, with the helpers most callers want.
 */
export interface DollarPromise extends Promise<SandboxCommandResult> {
  /**
   * The command's stdout, trimmed.
   */
  text(): Promise<string>;
  /**
   * The command's stdout as lines, with trailing whitespace trimmed. Empty
   * output is no lines.
   */
  lines(): Promise<string[]>;
  /**
   * The command's stdout parsed as JSON. Throws, naming the command, when it
   * is not JSON.
   */
  json<T = unknown>(): Promise<T>;
}

/**
 * `$`: runs a command as one step, from a tagged template.
 *
 * `` sandbox.$`/usr/bin/git status` `` runs argv, with no shell: static text
 * splits on whitespace and each value is one argument. The first word must be
 * an absolute path, as the sandbox does not search `PATH` for it. To run a
 * program by name, use `` sandbox.$.sh`git status` ``, which runs a shell
 * script with each value quoted.
 *
 * `sandbox.$(options)` is a `$` with options set, to keep or to use once.
 * `sandbox.$({ id: "build" })` also names the step, in place of one made from
 * the command; the SDK numbers repeats of an ID.
 *
 * A command that exits with a code not in `exitCodes` fails its step without
 * retrying, and `getCommandError()` reads the failure. A command that is not
 * found fails the step with the sandbox's own error, which `getSandboxError()`
 * reads, and not as a command failure.
 *
 * Don't put secrets in the command: its text and step ID are not redacted.
 * Pass them in `env`, whose values are kept out of the trace.
 */
export interface SandboxDollar {
  (strings: TemplateStringsArray, ...values: DollarValue[]): DollarPromise;
  (options: DollarOptions): SandboxDollar;
  (options: DollarOptions & { id: string }): DollarTag & { sh: DollarTag };
  sh: DollarTag;
}

const isPresent = (value: DollarValue): boolean => {
  return value !== null && value !== undefined && value !== false;
};

/**
 * The argv of a `$` template. Static text splits on whitespace and each value
 * is one argument, so there is nothing to quote. A value touching static text,
 * as in `--filter=${pkg}`, joins onto that argument.
 */
export const buildArgv = (
  strings: readonly string[],
  values: readonly DollarValue[],
): string[] => {
  const argv: string[] = [];
  let open = false;

  const append = (token: string): void => {
    if (open) {
      argv[argv.length - 1] = `${argv[argv.length - 1]}${token}`;
    } else {
      argv.push(token);
    }

    open = true;
  };

  for (const [index, chunk] of strings.entries()) {
    for (const [partIndex, part] of chunk.split(/\s+/).entries()) {
      if (partIndex > 0) {
        open = false;
      }

      if (part !== "") {
        append(part);
      }
    }

    const value = values[index];

    if (value === undefined || !isPresent(value)) {
      continue;
    }

    if (Array.isArray(value)) {
      argv.push(...value.map(String));

      open = false;
    } else {
      append(String(value));
    }
  }

  return argv;
};

const shellEscape = (value: string): string => {
  return `'${value.split("'").join(`'\\''`)}'`;
};

/**
 * The shell string of a `$.sh` template, with each value escaped.
 */
export const buildShellString = (
  strings: readonly string[],
  values: readonly DollarValue[],
): string => {
  let out = "";

  for (const [index, chunk] of strings.entries()) {
    out += chunk;

    const value = values[index];

    if (value === undefined || !isPresent(value)) {
      continue;
    }

    out += Array.isArray(value)
      ? value
          .map((item) => {
            return shellEscape(String(item));
          })
          .join(" ")
      : shellEscape(String(value));
  }

  return out;
};

const maxIdChars = 60;

/**
 * The step ID a command gets when its caller gave none: its text. The SDK
 * numbers repeats (`npm test`, `npm test:1`), so equal commands never clash.
 */
export const commandId = (text: string): string => {
  return text.length <= maxIdChars ? text : `${text.slice(0, maxIdChars - 1)}…`;
};

const isTemplate = (value: unknown): value is TemplateStringsArray => {
  return Array.isArray(value) && "raw" in value;
};

const withHelpers = (
  result: Promise<SandboxCommandResult>,
  text: string,
): DollarPromise => {
  return Object.assign(result, {
    text: async () => {
      return (await result).stdout.trim();
    },
    lines: async () => {
      const stdout = (await result).stdout.trimEnd();

      return stdout === "" ? [] : stdout.split(/\r?\n/);
    },
    json: async <T>() => {
      const { stdout } = await result;

      try {
        return JSON.parse(stdout) as T;
      } catch (error) {
        throw new Error(
          `Output of command is not valid JSON: ${clip(text, commandErrorTextBytes, "start")}`,
          { cause: error },
        );
      }
    },
  });
};

/**
 * A command's captured step fails with the sandbox's own timeout error. This
 * reports it as the command failure that a process's timeout is, so a replay
 * of either reads the same. The server returns no output for it, so the
 * tails are empty.
 */
const asCommandTimeout = (
  error: unknown,
  command: string,
  timeout: SandboxDuration,
): unknown => {
  if (getSandboxError(error)?.code !== "sandbox_exec_timed_out") {
    return error;
  }

  const timeoutMs = normalizeDurationMs(
    timeout,
    Number.POSITIVE_INFINITY,
    "timeout",
  );

  return commandFailure({
    type: "timeout",
    reason: `timed out after ${formatTimeout(timeoutMs)}`,
    command,
    stdout: "",
    stderr: "",
  });
};

/**
 * `options` over `defaults`, with the `env` of both. An option set to
 * `undefined` leaves the default as it is.
 */
const mergeOptions = (
  defaults: DollarOptions,
  options: DollarOptions,
): DollarOptions => {
  const set = Object.fromEntries(
    Object.entries(options).filter(([, value]) => {
      return value !== undefined;
    }),
  );
  const env =
    defaults.env || options.env
      ? { ...defaults.env, ...options.env }
      : undefined;

  return { ...defaults, ...set, ...(env && { env }) };
};

/**
 * Build the `$` of a sandbox, which runs its commands with `run`
 * (`sandbox.commands.run`), one step each. `id` names the step of every
 * command it runs; only a call's own options give one.
 */
export const createDollar = (
  run: DurableSandbox["commands"]["run"],
  defaults: DollarOptions = {},
  id?: string,
): SandboxDollar => {
  const start = (command: SandboxCommand, text: string): DollarPromise => {
    const {
      env,
      cwd,
      timeout = maxSandboxProcessTimeoutMs,
      exitCodes = [0],
    } = defaults;

    // Planned now, not when awaited, so `Promise.all` of several commands
    // plans them in the order they were written.
    const result = run(id ?? commandId(text), command, {
      ...(env && { environment: env }),
      ...(cwd !== undefined && { cwd }),
      timeout,
      exitCodes,
    }).catch((error: unknown) => {
      throw asCommandTimeout(error, text, timeout);
    });

    return withHelpers(result, text);
  };

  const dollar = ((
    first: TemplateStringsArray | (DollarOptions & { id?: string }),
    ...values: DollarValue[]
  ) => {
    if (!isTemplate(first)) {
      const { id: callId, ...options } = first;

      return createDollar(run, mergeOptions(defaults, options), callId);
    }

    const argv = buildArgv(first, values);

    return start(argv, argv.join(" "));
  }) as SandboxDollar;

  dollar.sh = (strings, ...values) => {
    const script = buildShellString(strings, values);

    return start(script, script);
  };

  return dollar;
};
