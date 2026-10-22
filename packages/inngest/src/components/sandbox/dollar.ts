/**
 * @module
 * `$`: run a command in a sandbox as one step, from a tagged template.
 * `` sandbox.$`npm test` `` runs argv with no shell, `` sandbox.$.sh`a | b` ``
 * runs a quoted shell command, and a bare `$` inside `group.sandbox()` runs in
 * that group's sandbox.
 *
 * SPIKE: proves the async-context binding and the step IDs only. Exit codes,
 * long commands and the `[$]` error are not built.
 */

import { getAsyncCtxSync, runWithAsyncCtx } from "../execution/als.ts";
import type {
  DurableSandbox,
  SandboxCommand,
  SandboxCommandOptions,
  SandboxCommandResult,
  SandboxDuration,
} from "./types.ts";

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
  /** The step ID, in place of one made from the command. */
  id?: string;
  /** Environment for this command, over the sandbox's. */
  env?: Record<string, string>;
  cwd?: string;
  timeout?: SandboxDuration;
}

/**
 * The promise of a command's result, with the helpers most callers want.
 */
export interface DollarPromise extends Promise<SandboxCommandResult> {
  text(): Promise<string>;
  lines(): Promise<string[]>;
  json<T = unknown>(): Promise<T>;
}

/**
 * Where a `$` runs its commands: the step that `commands.run` makes.
 */
export type DollarRunner = (
  id: string,
  command: SandboxCommand,
  options: SandboxCommandOptions,
) => Promise<SandboxCommandResult>;

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
      return (await result).stdout.trim();
    },
    lines: async () => {
      const text = (await result).stdout.trim();

      return text === "" ? [] : text.split("\n");
    },
    json: async <T>() => {
      return JSON.parse((await result).stdout) as T;
    },
  });
};

/**
 * Build a `$` that runs commands with the runner `getRunner` returns when a
 * command is made, not when `$` is built, so a bare `$` can find its sandbox
 * from the context it is called in.
 */
export const createDollar = (
  getRunner: () => DollarRunner,
  defaults: DollarOptions = {},
): SandboxDollar => {
  const run = (
    argv: SandboxCommand,
    text: string,
    options: DollarOptions,
  ): DollarPromise => {
    const runner = getRunner();
    const { id, env, cwd, timeout } = options;

    // Planned now, not when awaited, so `Promise.all` of several commands
    // plans them in the order they were written.
    return withHelpers(
      runner(id ?? commandId(text), argv, {
        ...(env && { environment: env }),
        ...(cwd !== undefined && { cwd }),
        ...(timeout !== undefined && { timeout }),
      }),
    );
  };

  const dollar = ((
    first: TemplateStringsArray | DollarOptions,
    ...values: DollarValue[]
  ) => {
    if (!isTemplate(first)) {
      return createDollar(getRunner, { ...defaults, ...first });
    }

    const argv = buildArgv(first, values);

    return run(argv, argv.join(" "), defaults);
  }) as SandboxDollar;

  dollar.sh = (strings, ...values) => {
    const script = buildShellString(strings, values);

    return run(script, script, defaults);
  };

  return dollar;
};

/**
 * Run `fn` with `sandbox` as the one a bare `$` runs in.
 */
export const withCurrentSandbox = <T>(
  sandbox: DurableSandbox,
  fn: () => T,
): T => {
  const current = getAsyncCtxSync();

  if (!current?.execution) {
    return fn();
  }

  return runWithAsyncCtx(
    { ...current, execution: { ...current.execution, sandbox } },
    fn,
  );
};

const currentRunner = (): DollarRunner => {
  const sandbox = getAsyncCtxSync()?.execution?.sandbox as
    | DurableSandbox
    | undefined;

  if (!sandbox) {
    throw new Error(
      "`$` was called outside `group.sandbox()`, so it has no sandbox to run in. Call `$` inside a `group.sandbox()` callback, or use `sandbox.$` on a sandbox you hold.",
    );
  }

  return (id, command, options) => {
    return sandbox.commands.run(id, command, options);
  };
};

/**
 * Run a command in the sandbox of the enclosing `group.sandbox()`.
 */
export const $: SandboxDollar = createDollar(currentRunner);
