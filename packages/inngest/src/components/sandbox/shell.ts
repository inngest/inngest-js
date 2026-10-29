/**
 * @module
 * `sandbox.shell()`: commands that share a working directory and exported
 * environment, like the commands typed into one terminal. Each command is
 * still one ordinary step run by `commands.run`. It runs inside a small
 * script that starts in the session's directory and, when the command ends,
 * prints where it ended and what it exported after a marker line. The session
 * reads that off the step's result, so its state is derived from memoized
 * results and a replay rebuilds it without touching the sandbox.
 */

import { getStepOptions } from "../InngestStepTools.ts";
import { commandText } from "./commandError.ts";
import type { SandboxDollar } from "./dollar.ts";
import { createDollar, shellEscape } from "./dollar.ts";
import type { DurableSandbox } from "./types.ts";

/**
 * The starting point of a shell.
 */
export interface SandboxShellOptions {
  /**
   * Where the first command starts. Default the sandbox's own directory,
   * which `shell.cwd` then reports after the first command.
   */
  cwd?: string;
  /**
   * Environment every command starts with, before what the commands export.
   */
  env?: Record<string, string>;
}

/**
 * A shell session on a sandbox. Its `$` is the sandbox's `$` with the
 * session's state: `cd` and `export` in one command apply to every command
 * called after it finishes. A command uses the state as of the moment it was
 * called, so commands started together (`Promise.all`) all begin from the same
 * state and run in parallel.
 *
 * Only the working directory and exported variables carry over. Shell
 * functions, aliases, unexported variables and shell options do not, because
 * each command runs in its own shell. A command that sets its own \`EXIT\` trap
 * or replaces the shell with \`exec\` ends without the report, so its \`cd\` and
 * \`export\` are not kept. A variable a command exports is stored in its step's
 * output, so do not export secrets you would not want kept there. State advances only when a command ends
 * with an allowed exit code, so a command that throws leaves it as it was.
 *
 * @example
 * ```ts
 * const sh = sandbox.shell({ cwd: "/work" });
 *
 * await sh.$`cd app`;
 * await sh.$`export NODE_ENV=test`;
 * await sh.$`npm test`; // runs in /work/app with NODE_ENV=test
 *
 * sh.cwd; // "/work/app"
 * ```
 */
export interface SandboxShell {
  /**
   * `$` for this session: a `$` whose commands run through a shell, so
   * `` $`cd app` `` works, and whose `cwd` and `env` start from the session's.
   * An option on a call overrides the session for that command only.
   */
  readonly $: SandboxDollar;
  /**
   * The working directory the next command starts in, or `undefined` until a
   * command has told us the sandbox's own.
   */
  readonly cwd: string | undefined;
  /**
   * The environment the session adds to every command: what it started with
   * and what commands exported since.
   */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * A session and the `commands.run` that goes with it, for code that builds on
 * `commands.run` directly, such as the model tools.
 */
export interface ShellSession extends SandboxShell {
  readonly run: DurableSandbox["commands"]["run"];
}

/**
 * Variables the shell itself sets as a command runs, so that they never count
 * as something a command exported.
 */
const shellOwned = new Set(["PWD", "OLDPWD", "_", "SHLVL", "BASH_TRAPSIG"]);

/**
 * Whether a name is one the session's own script uses (`__rc`, `__d`, `__f`).
 */
const isOwned = (name: string): boolean => {
  return shellOwned.has(name) || name.startsWith("__");
};

/**
 * A marker for one command that its output will not contain by accident.
 */
const markerOf = (id: string): string => {
  let hash = 2166136261;

  for (const char of id) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  }

  return `__INGEST_SHELL_${hash.toString(36)}__`;
};

const shownName = (text: string): string => {
  const line = text.split("\n", 1)[0] ?? "";

  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
};

const scriptOf = (text: string, unset: string[], marker: string): string => {
  // Only what the command changed is reported, worked out inside the sandbox
  // from two sorted listings of its environment (one NAME=value per line), so
  // the environment itself never reaches the step's output.
  const sorted = `command -p env -0 | command -p tr "\\n\\0" "\\001\\n" | LC_ALL=C command -p sort`;
  const body = [
    `command printf "\\n${marker}:cwd\\n"`,
    `command pwd`,
    `command printf "\\n${marker}:from\\n"`,
    `command printf "%s" "$__d"`,
    `if [ -n "$__f" ]`,
    `then ${sorted} > "$__f.2"`,
    `command printf "\\n${marker}:set\\n"`,
    `LC_ALL=C command -p comm -13 "$__f" "$__f.2"`,
    `command printf "\\n${marker}:gone\\n"`,
    `LC_ALL=C command -p comm -23 "$__f" "$__f.2"`,
    `command -p rm -f "$__f" "$__f.2"`,
    `fi`,
    `command printf "\\n${marker}:end\\n"`,
  ].join("; ");
  const report = `__rc=$?; ${body}; exit $__rc`;

  // The first line is what a trace shows of a script, so it is the command
  const first = text.split("\n", 1)[0] ?? "";

  return [
    `# ${first}`,
    ...(unset.length > 0 ? [`unset ${unset.map(shellEscape).join(" ")}`] : []),
    `__d=$(pwd)`,
    `__f=$(mktemp 2>/dev/null) && ${sorted} > "$__f" || __f=`,
    `trap '${report}' EXIT`,
    text,
  ].join("\n");
};

interface Report {
  /** What the command printed, without the report. */
  stdout: string;
  /** Where it ended, and where it started. */
  cwd?: string;
  from?: string;
  /** Variables it set or changed, and the ones it removed. */
  set?: Map<string, string>;
  gone?: Set<string>;
}

const parseVars = (block: string): Map<string, string> => {
  const entries = new Map<string, string>();

  for (const line of block.split("\n")) {
    const at = line.indexOf("=");

    if (at > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, at))) {
      // A newline inside a value travels as \u0001, so the value stays on one line
      entries.set(
        line.slice(0, at),
        line
          .slice(at + 1)
          .split("\u0001")
          .join("\n"),
      );
    }
  }

  return entries;
};

/**
 * Splits a command's stdout into what it printed and the report the script
 * added after it. A command that was killed has no report: its stdout is
 * returned as it is.
 */
const parseReport = (stdout: string, marker: string): Report => {
  const mark = (name: string) => {
    return `\n${marker}:${name}\n`;
  };
  const start = stdout.lastIndexOf(mark("cwd"));

  if (start === -1) {
    return { stdout };
  }

  const rest = stdout.slice(start);
  const part = (name: string, next: string): string | undefined => {
    const at = rest.indexOf(mark(name));
    const to = rest.indexOf(mark(next), at);

    return at === -1 || to === -1
      ? undefined
      : rest.slice(at + mark(name).length, to);
  };
  const cwd = part("cwd", "from");
  const from = part("from", rest.includes(mark("set")) ? "set" : "end");
  const set = part("set", "gone");
  const gone = part("gone", "end");

  return {
    stdout: stdout.slice(0, start),
    cwd: cwd?.replace(/\n+$/, ""),
    from,
    ...(set !== undefined && gone !== undefined
      ? {
          set: parseVars(set),
          gone: new Set(parseVars(gone).keys()),
        }
      : {}),
  };
};

/**
 * What a session carries between commands: the working directory, the
 * variables its commands exported, and the ones they unset.
 */
export interface ShellState {
  cwd?: string;
  env: Record<string, string>;
  unset: Set<string>;
}

/**
 * A command planned against a session: the script to run in place of the
 * command, and where and with what environment it starts.
 */
export interface ShellStart {
  /** Which command of the session this is, in the order they were called. */
  seq: number;
  script: string;
  marker: string;
  cwd?: string;
  env: Record<string, string>;
  ownCwd?: string;
}

/**
 * Which command last wrote each part of a session. Commands that finish in a
 * different order on a replay than live still leave the same state, because
 * the one called last wins for each variable and for the directory.
 */
const orders = new WeakMap<
  ShellState,
  { calls: number; cwd: number; vars: Map<string, number> }
>();

const orderOf = (state: ShellState) => {
  let order = orders.get(state);

  if (!order) {
    order = { calls: 0, cwd: 0, vars: new Map() };
    orders.set(state, order);
  }

  return order;
};

/**
 * Plans `text` (a shell script) as the next command of a session, starting
 * from the session's state as it is now. `id` is the command's step ID, which
 * its report marker is made from. `own` overrides the session for this
 * command only.
 */
export const beginShellCommand = (
  state: ShellState,
  text: string,
  id: string,
  own: { cwd?: string; env?: Record<string, string> } = {},
): ShellStart => {
  const marker = markerOf(id);
  const seq = ++orderOf(state).calls;
  const removed = [...state.unset].filter((name) => {
    return !(own.env && Object.hasOwn(own.env, name));
  });

  return {
    seq,
    script: scriptOf(text, removed, marker),
    marker,
    cwd: own.cwd ?? state.cwd,
    ownCwd: own.cwd,
    env: { ...state.env, ...own.env },
  };
};

/**
 * Takes a finished command's report off its stdout, moves the session to
 * where the command ended, and returns what the command printed. Stdout with
 * no report (a command that was killed) leaves the session as it is.
 */
export const endShellCommand = (
  state: ShellState,
  start: ShellStart,
  stdout: string,
): string => {
  const report = parseReport(stdout, start.marker);

  // A command moved the session when it ended somewhere other than where it
  // started, as the shell itself saw both, so a relative or symlinked `cwd`
  // option is not mistaken for a move
  const order = orderOf(state);

  if (
    report.cwd &&
    report.from !== undefined &&
    report.cwd !== report.from &&
    start.seq >= order.cwd
  ) {
    state.cwd = report.cwd;
    order.cwd = start.seq;
  }

  if (report.set && report.gone) {
    for (const [name, value] of report.set) {
      if (!isOwned(name) && start.seq >= (order.vars.get(name) ?? 0)) {
        state.env[name] = value;
        state.unset.delete(name);
        order.vars.set(name, start.seq);
      }
    }

    for (const name of report.gone) {
      if (
        !isOwned(name) &&
        !report.set.has(name) &&
        start.seq >= (order.vars.get(name) ?? 0)
      ) {
        delete state.env[name];
        state.unset.add(name);
        order.vars.set(name, start.seq);
      }
    }
  }

  return report.stdout;
};

/**
 * What a command printed, without the report its script added.
 */
export const stripShellReport = (stdout: string, marker: string): string => {
  return parseReport(stdout, marker).stdout;
};

/**
 * Builds a shell session whose commands run with `run` (`commands.run`).
 */
export const createShell = (
  run: DurableSandbox["commands"]["run"],
  options: SandboxShellOptions = {},
): ShellSession => {
  const state: ShellState = {
    cwd: options.cwd,
    env: { ...options.env },
    unset: new Set(),
  };

  const shellRun: DurableSandbox["commands"]["run"] = (
    idOrOptions,
    command,
    runOptions,
  ) => {
    const { environment, cwd: ownCwd, ...rest } = runOptions ?? {};
    const start = beginShellCommand(
      state,
      typeof command === "string"
        ? command
        : command.map(shellEscape).join(" "),
      getStepOptions(idOrOptions).id,
      { cwd: ownCwd, env: environment },
    );

    const given = getStepOptions(idOrOptions);
    const result = run(
      { ...given, name: given.name ?? shownName(commandText(command)) },
      ["/bin/sh", "-c", start.script],
      {
        ...rest,
        environment: start.env,
        ...(start.cwd !== undefined && { cwd: start.cwd }),
        "~shell": {
          text: commandText(command),
          strip: (stdout: string) => {
            return stripShellReport(stdout, start.marker);
          },
        },
      } as Parameters<typeof run>[2],
    );

    return result.then((finished) => {
      return {
        ...finished,
        stdout: endShellCommand(state, start, finished.stdout),
      };
    });
  };

  return {
    $: createDollar(shellRun),
    get cwd() {
      return state.cwd;
    },
    get env() {
      return { ...state.env };
    },
    run: shellRun,
  };
};
