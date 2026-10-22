/**
 * @module
 * `$`: run a command in a sandbox as one step, from a tagged template.
 * `` sandbox.$`npm test` `` runs argv with no shell, `` sandbox.$.sh`a | b` ``
 * runs a quoted shell command, and `sandbox.$(options)` is a `$` with
 * options set. Every sandbox handle has one.
 */

import { commandFailure, formatTimeout } from "./commandError.ts";
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

export interface DollarOptions {
  /**
   * The step ID, in place of one made from the command. The SDK numbers
   * repeats of an ID.
   */
  id?: string;
  /**
   * How long the command may run. Defaults to five minutes, the most that one
   * step can wait; longer runs as a process that the steps follow.
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

/**
 * The promise of a command's result, with the helpers most callers want.
 */
export interface DollarPromise extends Promise<SandboxCommandResult> {
  text(): Promise<string>;
  lines(): Promise<string[]>;
  json<T = unknown>(): Promise<T>;
}

export interface DollarTag {
  (strings: TemplateStringsArray, ...values: DollarValue[]): DollarPromise;
}

/**
 * `$`: a tag, and a function from options to a configured tag.
 */
export interface SandboxDollar extends DollarTag {
  (options: DollarOptions): SandboxDollar;
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

const withHelpers = (result: Promise<SandboxCommandResult>): DollarPromise => {
  return Object.assign(result, {
    text: async () => {
      return (await result).stdout.trimEnd();
    },
    lines: async () => {
      const text = (await result).stdout.trimEnd();

      return text === "" ? [] : text.split("\n");
    },
    json: async <T>() => {
      return JSON.parse((await result).stdout) as T;
    },
  });
};

/**
 * A command's captured step fails with the sandbox's own timeout error. It is
 * what `CommandTimeoutError` reports, and a replay maps it the same way.
 */
const asCommandTimeout = (
  error: unknown,
  command: string,
  timeoutMs: number,
): unknown => {
  if (getSandboxError(error)?.code !== "sandbox_exec_timed_out") {
    return error;
  }

  return commandFailure({
    command,
    timeout: formatTimeout(timeoutMs),
    stdout: "",
    stderr: "",
  });
};

const mergeOptions = (
  defaults: DollarOptions,
  options: DollarOptions,
): DollarOptions => {
  const env =
    defaults.env || options.env
      ? { ...defaults.env, ...options.env }
      : undefined;

  return { ...defaults, ...options, ...(env && { env }) };
};

/**
 * Build the `$` of a sandbox, which runs its commands with `run`
 * (`sandbox.commands.run`), one step each.
 */
export const createDollar = (
  run: DurableSandbox["commands"]["run"],
  defaults: DollarOptions = {},
): SandboxDollar => {
  const start = (
    command: SandboxCommand,
    text: string,
    options: DollarOptions,
  ): DollarPromise => {
    const {
      id = commandId(text),
      env,
      cwd,
      timeout = maxSandboxProcessTimeoutMs,
      exitCodes = [0],
    } = options;

    // Planned now, not when awaited, so `Promise.all` of several commands
    // plans them in the order they were written.
    const result = run(id, command, {
      ...(env && { environment: env }),
      ...(cwd !== undefined && { cwd }),
      timeout,
      exitCodes,
    }).catch((error: unknown) => {
      throw asCommandTimeout(
        error,
        text,
        normalizeDurationMs(timeout, Number.POSITIVE_INFINITY, "timeout"),
      );
    });

    return withHelpers(result);
  };

  const dollar = ((
    first: TemplateStringsArray | DollarOptions,
    ...values: DollarValue[]
  ) => {
    if (!isTemplate(first)) {
      return createDollar(run, mergeOptions(defaults, first));
    }

    const argv = buildArgv(first, values);

    return start(argv, argv.join(" "), defaults);
  }) as SandboxDollar;

  dollar.sh = (strings, ...values) => {
    const script = buildShellString(strings, values);

    return start(script, script, defaults);
  };

  return dollar;
};
