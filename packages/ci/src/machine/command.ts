/**
 * Running commands on a job's machine: the `$` tag, its builder methods and
 * the raw command helper other APIs reuse. Process plumbing for the sandbox
 * API (start, poll, read output) lives here too.
 *
 * @module
 */

import { NonRetriableError, StepError } from "inngest";
import { getAsyncCtx, getSandboxError } from "inngest/experimental";
import {
  CiUsageError,
  CommandFailedError,
  CommandTimeoutError,
} from "../errors.ts";
import { ciRun } from "../pipeline/metadata.ts";
import type { StepSpec } from "../pipeline/names.ts";
import { ciStep, spans, steps, traceName } from "../pipeline/names.ts";
import type { CiJobScope, MachineHandle } from "../pipeline/scope.ts";
import {
  countApi,
  defaultCwd,
  joinId,
  nextStepId,
  requireJobScope,
} from "../pipeline/scope.ts";
import { inSpan } from "../pipeline/spans.ts";
import type {
  BackgroundProcess,
  Command,
  CommandResult,
  CommandTag,
  CommandValue,
  Duration,
} from "../types.ts";
import {
  durationToMs,
  formatDuration,
  maskSecrets,
  shellEscape,
  tail,
  truncateLabel,
} from "../util.ts";
import { directSandbox, ensureMachine, inMachineSpan } from "./machine.ts";

/**
 * Captured `commands.run` is capped at five minutes, so anything longer runs
 * as a managed process instead.
 */
const capturedExecLimitMs = 5 * 60 * 1000;

/** How much of each stream is kept on a `CommandResult`. */
const outputTailBytes = 64 * 1024;

const terminalStates = new Set(["EXITED", "KILLED", "FAILED", "LOST"]);

/**
 * How long the step that starts a managed process follows it for, so a short
 * command is done in that one step.
 */
const startWindowMs = 10_000;

/**
 * How long each later step follows it for. There are no process exit events
 * yet, so these steps are how a command longer than the captured-exec cap is
 * followed.
 */
const pollWindowMs = 30_000;

// biome-ignore lint/suspicious/noExplicitAny: DurableSandboxProcess, loose like MachineHandle
type SandboxProcess = any;

export interface CommandState {
  argv: string[];
  /** What the command reads as, when that isn't its argv, as for `$.sh`. */
  text?: string;
  /** A name for the command, from `.as()` or the helper that made it. */
  label?: string;
  env: Record<string, string>;
  cwd?: string;
  retries: number;
  nothrow: boolean;
  timeoutMs?: number;
  onTimeout?: () => Promise<unknown>;
}

const isPresent = (value: CommandValue): boolean => {
  return value !== null && value !== undefined && value !== false;
};

/**
 * Build the argv for a `$` template.
 *
 * Static text is split on whitespace and each interpolated value becomes one
 * argument, so there's nothing to quote. Arrays spread into several arguments,
 * and `null`, `undefined`, and `false` are dropped so `${cond && [...]}` works.
 *
 * A value that follows static text with no whitespace between them, like
 * `--filter=${pkg}`, is joined onto that argument rather than split off it.
 */
export const buildArgv = (
  strings: readonly string[],
  values: CommandValue[],
): string[] => {
  const argv: string[] = [];
  // Whether the last argument can still grow, because nothing has closed it.
  let open = false;

  const append = (token: string) => {
    if (open) {
      argv[argv.length - 1] = `${argv[argv.length - 1]}${token}`;
    } else {
      argv.push(token);
    }

    open = true;
  };

  for (const [index, chunk] of strings.entries()) {
    for (const [partIndex, part] of chunk.split(/\s+/).entries()) {
      // Whitespace sits between every part after the first.
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

  return argv.filter((token) => {
    return token !== "";
  });
};

/**
 * Render a `$.sh` template into a single shell string, escaping interpolated
 * values so they can't break out of their argument.
 */
export const buildShellString = (
  strings: readonly string[],
  values: CommandValue[],
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

class CommandBuilder implements Command {
  private readonly getScope: () => CiJobScope;
  private readonly state: CommandState;
  private started?: Promise<CommandResult>;

  constructor(getScope: () => CiJobScope, state: CommandState) {
    this.getScope = getScope;

    this.state = state;
  }

  /** What a job's output stores of a command it returns. */
  toState(): CommandState {
    return { ...this.state, env: { ...this.state.env } };
  }

  env(vars: Record<string, string>): Command {
    Object.assign(this.state.env, vars);

    return this;
  }

  cwd(path: string): Command {
    this.state.cwd = path;

    return this;
  }

  as(name: string): Command {
    this.state.label = name;

    return this;
  }

  retries(count: number): Command {
    this.state.retries = count;

    return this;
  }

  nothrow(): Command {
    this.state.nothrow = true;

    return this;
  }

  timeout(duration: Duration): Command {
    this.state.timeoutMs = durationToMs(duration, "timeout");

    return this;
  }

  onTimeout(fn: () => Promise<unknown>): Command {
    this.state.onTimeout = fn;

    return this;
  }

  withSecret(_name: string, _value: string): Command {
    throw new CiUsageError(
      "`withSecret()` isn't supported yet. The Sandbox API has no per-command secrets, and a value passed as command environment is persisted in step data. Don't pass the secret to the command.",
    );
  }

  async text(): Promise<string> {
    return (await this.exec()).stdout.trim();
  }

  async lines(): Promise<string[]> {
    const text = await this.text();

    return text === "" ? [] : text.split("\n");
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse((await this.exec()).stdout) as T;
  }

  then<TResult1 = CommandResult, TResult2 = never>(
    onfulfilled?:
      | ((value: CommandResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }

  async background(): Promise<BackgroundProcess> {
    const scope = this.getScope();

    countApi("background");
    const stepId = this.stepId(scope);
    const machine = await ensureMachine(scope);

    // Starting, awaiting, reading and killing the process are separate
    // statements, so each is a row of its own, never one span re-entered.
    const process = await this.inSpan(scope, stepId, () => {
      return startProcess({
        scope,
        machine,
        stepId,
        options: this.spawnOptions(scope),
        windowMs: 0,
      });
    });

    const secrets = this.secretValues(scope);
    // Numbers the follow-up steps, so calling `exited()` or `output()` more
    // than once never reuses a step ID.
    const nextWait = counter();
    const nextExited = counter();

    return {
      id: process.id,
      exited: () => {
        return this.inSpan(
          scope,
          stepId,
          async () => {
            const polled = await pollUntilTerminal({
              scope,
              machine,
              process,
              stepId,
              nextWait,
            });

            return readResult({
              scope,
              machine,
              process: polled.process,
              stepId,
              secrets,
            });
          },
          { suffix: `exited #${nextExited()}`, label: "exited" },
        );
      },
      kill: async (signal = 15) => {
        await this.inSpan(
          scope,
          stepId,
          () => {
            return signalProcess(scope, machine, steps.stopProcess(stepId), {
              id: process.id,
              signal,
            });
          },
          { suffix: "kill", label: "kill" },
        );
      },
      output: async (opts) => {
        const suffix = `output #${nextWait()}`;

        const output = await this.inSpan(
          scope,
          stepId,
          () => {
            return readOutputStep(
              scope,
              machine,
              steps.readOutput(stepId, suffix),
              {
                id: process.id,
                tailBytes: opts?.tailBytes,
              },
            );
          },
          { suffix, label: "output" },
        );

        return maskSecrets(`${output.stdout}${output.stderr}`, secrets);
      },
    };
  }

  /** Runs once however many times the command is awaited. */
  private exec(): Promise<CommandResult> {
    if (!this.started) {
      countApi("commands");

      this.started = this.runWithRetries();
    }

    return this.started;
  }

  /** What the command reads as: its `$.sh` script, or its arguments. */
  private commandText(): string {
    return this.state.text ?? truncateLabel(this.state.argv.join(" "));
  }

  /** What the command's step IDs are built from. */
  private labelText(): string {
    return this.state.label ?? this.commandText();
  }

  private stepId(scope: CiJobScope): string {
    return nextStepId(scope.run, scope.path, this.labelText());
  }

  private environment(scope: CiJobScope): Record<string, string> {
    return {
      ...scope.env,
      ...this.state.env,
    };
  }

  private secretValues(scope: CiJobScope): string[] {
    return [...scope.secrets];
  }

  private spawnOptions(scope: CiJobScope) {
    return {
      command: this.state.argv,
      environment: this.environment(scope),
      cwd: this.state.cwd ?? scope.cwd ?? defaultCwd,
    };
  }

  private timeoutError(scope: CiJobScope): CommandTimeoutError {
    return new CommandTimeoutError({
      command: this.state.argv,
      timeout: formatDuration(this.state.timeoutMs ?? 0, true),
      jobPath: scope.path,
    });
  }

  /**
   * Run `fn` in the command's span, in its machine's span if it's an extra.
   * A statement on a background process, such as its `kill`, is a span of its
   * own beside the command's.
   */
  private inSpan<T>(
    scope: CiJobScope,
    stepId: string,
    fn: () => T,
    statement?: { suffix: string; label: string },
  ): T {
    const span = spans.command(
      stepId,
      this.commandText(),
      this.state.label,
      statement,
    );

    return inMachineSpan(scope, () => {
      return inSpan(span, fn);
    });
  }

  /**
   * Each attempt runs in the command's span, and in a span of its own when the
   * command has retries. A failed attempt's span ends in its failure.
   */
  private async runWithRetries(): Promise<CommandResult> {
    const scope = this.getScope();
    const stepId = this.stepId(scope);
    const attempts = Math.max(0, this.state.retries) + 1;

    for (let attempt = 1; ; attempt++) {
      const attemptId =
        attempts === 1 ? stepId : `${stepId} #attempt-${attempt}`;

      const attemptInfo = { id: stepId, name: this.labelText(), attempt };

      scope.run.ci.hooks.commandStarted(scope, attemptInfo);

      const runAttempt = async () => {
        const result = await this.runOnce(scope, attemptId);

        if (result.exitCode !== 0 && !this.state.nothrow) {
          await recordFailure(scope, attemptId, this.failure(scope, result));
        }

        return result;
      };

      const result = await this.inSpan(scope, stepId, () => {
        return attempts === 1
          ? runAttempt()
          : inSpan(spans.attempt(attempt), runAttempt);
      });

      scope.run.ci.hooks.commandFinished(scope, attemptInfo, result);

      if (result.exitCode === 0 || this.state.nothrow) {
        return result;
      }

      const error = this.failure(scope, result);

      if (attempt >= attempts) {
        throw error;
      }

      await scope.run.ci.checks?.commandRetry?.({
        run: scope.run,
        jobPath: scope.jobPath,
        attempt,
        of: attempts,
        error,
      });
    }
  }

  private failure(
    scope: CiJobScope,
    result: CommandResult,
  ): CommandFailedError {
    return new CommandFailedError({
      command: this.state.argv,
      exitCode: result.exitCode,
      stdoutTail: result.stdout,
      stderrTail: result.stderr,
      jobPath: scope.path,
    });
  }

  /** One attempt, which never throws for a non-zero exit. */
  private async runOnce(
    scope: CiJobScope,
    stepId: string,
  ): Promise<CommandResult> {
    const machine = await ensureMachine(scope);

    const timeoutMs = this.state.timeoutMs;

    // Short commands with an explicit timeout run as one captured step, which
    // is cheaper and keeps the trace tidy.
    if (timeoutMs !== undefined && timeoutMs <= capturedExecLimitMs) {
      return this.runCaptured(scope, machine, stepId, timeoutMs);
    }

    return this.runManaged(scope, machine, stepId, timeoutMs);
  }

  private async runCaptured(
    scope: CiJobScope,
    machine: MachineHandle,
    stepId: string,
    timeoutMs: number,
  ): Promise<CommandResult> {
    const secrets = this.secretValues(scope);
    const { command, ...options } = this.spawnOptions(scope);

    try {
      const result = await machine.sandbox.commands.run(
        ciStep(stepId, traceName.runAndReadOutput),
        command,
        { ...options, timeout: timeoutMs },
      );

      return {
        exitCode: result.exitCode,
        stdout: maskSecrets(result.stdout, secrets),
        stderr: maskSecrets(result.stderr, secrets),
        // No `durationMs`: the sandbox doesn't time a captured exec, and a clock
        // read out here would span a replay, not the command.
        truncated: result.output?.truncated === true,
      };
    } catch (error) {
      // The sandbox answers an exec that outlives its timeout with an error,
      // not a result, so it's mapped onto the same error a managed process's
      // timeout gives.
      if (getSandboxError(error)?.code !== "sandbox_exec_timed_out") {
        throw error;
      }

      await this.state.onTimeout?.();

      throw this.timeoutError(scope);
    }
  }

  private async runManaged(
    scope: CiJobScope,
    machine: MachineHandle,
    stepId: string,
    timeoutMs: number | undefined,
  ): Promise<CommandResult> {
    // The start follows the process for a while, then polling follows on from
    // where it left off.
    const windowMs =
      timeoutMs === undefined
        ? startWindowMs
        : Math.min(startWindowMs, timeoutMs);

    const started = await startProcess({
      scope,
      machine,
      stepId,
      options: this.spawnOptions(scope),
      windowMs,
    });

    const polled = await pollUntilTerminal({
      scope,
      machine,
      process: started,
      stepId,
      nextWait: counter(),
      timeoutMs,
      elapsedMs: windowMs,
    });

    if (polled.timedOut) {
      await this.state.onTimeout?.();

      await signalProcess(scope, machine, steps.stopAfterTimeout(stepId), {
        id: started.id,
        signal: 9,
      });

      throw this.timeoutError(scope);
    }

    const result = await readResult({
      scope,
      machine,
      process: polled.process,
      stepId,
      secrets: this.secretValues(scope),
    });

    await publishOutput(scope, stepId, "stdout", result.stdout);
    await publishOutput(scope, stepId, "stderr", result.stderr);

    return result;
  }
}

const counter = (): (() => number) => {
  let count = 0;

  return () => {
    return ++count;
  };
};

/**
 * Record that a run of a command failed, as a step that fails without retrying.
 * The sandbox steps before it all succeed, since a non-zero exit is a result,
 * so this step is what shows the run as failed in the trace. Its error is
 * caught: the caller decides whether to retry or throw.
 */
const recordFailure = async (
  scope: CiJobScope,
  stepId: string,
  failure: CommandFailedError,
): Promise<void> => {
  try {
    await ciRun(
      scope.run,
      steps.recordCommandFailure(stepId, failure.exitCode),
      () => {
        throw new NonRetriableError(failure.message);
      },
    );
  } catch (error) {
    if (!(error instanceof StepError)) {
      throw error;
    }
  }
};

/** The metadata kind the SDK's own sandbox steps carry, which the trace reads. */
const sandboxMetadataKind = "inngest.sandbox";

/** Longest command, in characters, a trace entry keeps. */
const maxCommandMetadataChars = 1024;

/** How a sandbox step reads in the trace: what it did, and to what. */
interface StepTrace<T> {
  machine: MachineHandle;
  /** The sandbox API action, as in `process.start`. */
  action: string;
  /** The method a user would have called, as in `processes.start`. */
  method: string;
  /** What the step knows before it runs. */
  base?: Record<string, unknown>;
  /** What its result adds. */
  of?: (result: T) => Record<string, unknown>;
}

/**
 * Attach the metadata the SDK puts on its sandbox steps, so these steps read
 * in the trace as those do. Each attempt sends its whole entry. Tracing never
 * fails a step.
 */
const traceStep = async <T>(
  trace: StepTrace<T>,
  outcome: { result: T } | { code?: string | undefined },
): Promise<void> => {
  try {
    const execution = (await getAsyncCtx())?.execution;
    const stepId = execution?.executingStep?.id;

    if (!execution || !stepId) {
      return;
    }

    const values = {
      version: 1,
      action: trace.action,
      method: trace.method,
      sandbox_id: trace.machine.id,
      ...trace.base,
      ...("result" in outcome
        ? trace.of?.(outcome.result)
        : { error_code: outcome.code }),
    };

    const entry = Object.fromEntries(
      Object.entries(values).filter(([, value]) => {
        return value !== undefined;
      }),
    );

    execution.instance.addMetadata(
      stepId,
      sandboxMetadataKind,
      "step",
      "merge",
      entry,
    );
  } catch {
    // The step is what matters.
  }
};

/** A command as a trace keeps it: cut short, with a script shown as written. */
const commandMetadata = (argv: readonly string[]): Record<string, unknown> => {
  let remaining = maxCommandMetadataChars;
  const command: string[] = [];

  for (const argument of argv) {
    if (remaining <= 0) {
      break;
    }

    command.push(argument.slice(0, remaining));

    remaining -= argument.length;
  }

  const isScript =
    command.length === 3 && command[0] === "/bin/sh" && command[1] === "-c";

  return {
    command,
    command_display: isScript ? command[2] : undefined,
    command_truncated:
      remaining < 0 || command.length < argv.length || undefined,
  };
};

/** What a process view adds to a trace entry. */
const viewMetadata = (view: ProcessView): Record<string, unknown> => {
  return {
    process_id: view.id,
    process_state: view.state,
    exit_code: view.exitCode,
    output_truncated: view.output?.truncated || undefined,
  };
};

/**
 * Run a sandbox step of CI's own. An error the sandbox API says is not safe to
 * repeat is final, as it is for a durable `step.sandbox` call, so a retry
 * never starts a command a second time.
 */
const sandboxStep = <T>(
  scope: CiJobScope,
  spec: StepSpec,
  trace: StepTrace<T>,
  fn: () => Promise<T>,
): Promise<T> => {
  return ciRun(scope.run, spec, async () => {
    try {
      const result = await fn();

      await traceStep(trace, { result });

      return result;
    } catch (error) {
      const sandboxError = getSandboxError(error);

      await traceStep(trace, { code: sandboxError?.code });

      if (!sandboxError || sandboxError.retryable) {
        throw error;
      }

      throw new NonRetriableError(sandboxError.message, {
        cause: {
          action: sandboxError.action,
          code: sandboxError.code,
          message: sandboxError.message,
          ambiguous: sandboxError.ambiguous,
        },
      });
    }
  });
};

/** A process's output, cut to its tails. */
interface ProcessOutput {
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/**
 * A managed process as a step last saw it. It is plain data because a step's
 * result is stored, and it is all a replay has to go on.
 */
interface ProcessView {
  id: string;
  state: string;
  exitCode?: number;
  startedAt?: string;
  endedAt?: string;
  /** Set when the process ended and the same step could read its output. */
  output?: ProcessOutput;
}

const viewOf = (process: SandboxProcess): ProcessView => {
  return {
    id: process.id,
    state: process.state,
    exitCode: process.exitCode,
    startedAt: process.startedAt,
    endedAt: process.endedAt,
  };
};

const readProcessOutput = async (
  process: SandboxProcess,
  tailBytes = outputTailBytes,
): Promise<ProcessOutput> => {
  const decoded = decodeChunks(await process.getOutput({ tailBytes }));
  const stdout = tail(decoded.stdout, tailBytes);
  const stderr = tail(decoded.stderr, tailBytes);

  return {
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
  };
};

/**
 * Follow a process for up to `windowMs`, and read its output if it ends. A
 * wait that outlasts the window ends in an error, which only means the
 * process is still running. Output that can't be read is left for a step of
 * its own.
 */
const follow = async (
  sandbox: Awaited<ReturnType<typeof directSandbox>>,
  process: SandboxProcess,
  windowMs: number,
): Promise<ProcessView> => {
  let current = process;

  if (windowMs > 0) {
    try {
      current = await process.wait({ timeout: windowMs });

      // A wait answers with the exit but not the end time.
      if (terminalStates.has(current.state) && !current.endedAt) {
        current = (await sandbox.processes.get(process.id)) ?? current;
      }
    } catch {
      current = (await sandbox.processes.get(process.id)) ?? process;
    }
  }

  if (!terminalStates.has(current.state)) {
    return viewOf(current);
  }

  try {
    return { ...viewOf(current), output: await readProcessOutput(current) };
  } catch {
    return viewOf(current);
  }
};

/** A process by ID, as the sandbox API's own client has it. */
const processById = async (
  sandbox: Awaited<ReturnType<typeof directSandbox>>,
  id: string,
): Promise<SandboxProcess> => {
  const process = await sandbox.processes.get(id);

  if (!process) {
    throw new Error(`Process ${id} is gone`);
  }

  return process;
};

/**
 * Start a managed process, and follow it for up to `windowMs` in the same
 * step, so a command that ends in that time takes one step in all. Without a
 * window the step only starts it.
 *
 * The process starts once: its start is a step, so a replay gets the stored
 * result. Once it has started, nothing in the step fails it, since a retry
 * would start the command a second time. An ambiguous start ends the step
 * early, and a step of its own looks for the process that did start, so only
 * that lookup is retried.
 */
const startProcess = async (opts: {
  scope: CiJobScope;
  machine: MachineHandle;
  stepId: string;
  options: {
    command: string[];
    environment: Record<string, string>;
    cwd: string;
  };
  windowMs: number;
}): Promise<ProcessView> => {
  const { scope, machine } = opts;

  machine.claimedProcessIds ??= new Set<string>();

  const claimed = machine.claimedProcessIds;

  const base = {
    ...commandMetadata(opts.options.command),
    cwd: opts.options.cwd,
  };

  const started = await sandboxStep(
    scope,
    steps.startProcess(opts.stepId, opts.windowMs > 0),
    {
      machine,
      action: "process.start",
      method: "processes.start",
      base,
      of: (result) => {
        return "ambiguous" in result ? {} : viewMetadata(result);
      },
    },
    async (): Promise<ProcessView | AmbiguousStart> => {
      const sandbox = await directSandbox(scope.run, machine);

      let process: SandboxProcess;

      try {
        process = await sandbox.processes.start(opts.options);
      } catch (error) {
        if (isAmbiguousStart(error)) {
          return { ambiguous: true };
        }

        throw error;
      }

      return followAfterStart(sandbox, process, opts.windowMs);
    },
  );

  if (!("ambiguous" in started)) {
    claimed.add(started.id);

    return started;
  }

  const view = await sandboxStep(
    scope,
    steps.findStartedProcess(opts.stepId),
    {
      machine,
      action: "process.list",
      method: "processes.list",
      base,
      of: viewMetadata,
    },
    async () => {
      const sandbox = await directSandbox(scope.run, machine);

      const adopted = await findAmbiguousStart(
        sandbox,
        opts.options.command,
        claimed,
      );

      return followAfterStart(sandbox, adopted, opts.windowMs);
    },
  );

  claimed.add(view.id);

  return view;
};

/** The result of a start step that can't tell whether the process started. */
interface AmbiguousStart {
  ambiguous: true;
}

/** Follow a process that has just started, whatever goes wrong doing so. */
const followAfterStart = async (
  sandbox: Awaited<ReturnType<typeof directSandbox>>,
  process: SandboxProcess,
  windowMs: number,
): Promise<ProcessView> => {
  try {
    return await follow(sandbox, process, windowMs);
  } catch {
    // The next step finds out what is wrong with the process.
    return viewOf(process);
  }
};

/**
 * WORKAROUND (Sandboxes API): Cloud can answer a `process.start` that
 * succeeded with `409 operation_ambiguous`, and the error says to list
 * processes and reconcile before starting another. Delete this, and the
 * `claimedProcessIds` bookkeeping on `MachineHandle`, once starts are no
 * longer ambiguous.
 */
const isAmbiguousStart = (error: unknown): boolean => {
  const sandboxError = getSandboxError(error);

  return (
    sandboxError?.code === "operation_ambiguous" &&
    sandboxError.action === "process.start"
  );
};

/**
 * List processes and return the newest one running the same command that this
 * run hasn't already claimed.
 */
const findAmbiguousStart = async (
  sandbox: Awaited<ReturnType<typeof directSandbox>>,
  command: readonly string[],
  claimed: ReadonlySet<string>,
): Promise<SandboxProcess> => {
  const listed = await sandbox.processes.list({ limit: 250 });

  const [match] = listed.items
    .filter((process: SandboxProcess) => {
      return (
        !claimed.has(process.id) &&
        process.command.length === command.length &&
        process.command.every((arg: string, index: number) => {
          return arg === command[index];
        })
      );
    })
    .sort((a: SandboxProcess, b: SandboxProcess) => {
      return (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
    });

  if (!match) {
    throw new NonRetriableError(
      "operation_ambiguous: the command may have started, but no started process was found",
    );
  }

  return match;
};

/**
 * Follow a managed process until it reaches a terminal state, or until
 * `timeoutMs` has passed.
 *
 * Each step follows it for a window, blocking on the sandbox API's
 * `process.wait`, and reads its output when it ends. That is one step per
 * window rather than a durable sleep and a check per tick.
 *
 * `process.wait` raises an error when its window passes with the process still
 * running, and blocks for at most five minutes, so a window is shorter than
 * that and its error is only a signal to look again.
 */
const pollUntilTerminal = async (opts: {
  scope: CiJobScope;
  machine: MachineHandle;
  process: ProcessView;
  stepId: string;
  /** Numbers each poll, so step IDs stay unique across calls. */
  nextWait: () => number;
  timeoutMs?: number | undefined;
  /** How much of the timeout the steps before this have used. */
  elapsedMs?: number;
}): Promise<{ process: ProcessView; timedOut: boolean }> => {
  const { scope, machine } = opts;

  let current = opts.process;
  let elapsed = opts.elapsedMs ?? 0;

  while (!terminalStates.has(current.state)) {
    if (opts.timeoutMs !== undefined && elapsed >= opts.timeoutMs) {
      return { process: current, timedOut: true };
    }

    const windowMs =
      opts.timeoutMs === undefined
        ? pollWindowMs
        : Math.min(pollWindowMs, opts.timeoutMs - elapsed);

    const id = current.id;

    current = await sandboxStep(
      scope,
      steps.pollProcess(opts.stepId, opts.nextWait()),
      {
        machine,
        action: "process.wait",
        method: "process.wait",
        base: { process_id: id },
        of: viewMetadata,
      },
      async () => {
        const sandbox = await directSandbox(scope.run, machine);

        return follow(sandbox, await processById(sandbox, id), windowMs);
      },
    );

    elapsed += windowMs;
  }

  return { process: current, timedOut: false };
};

/** Send a signal to a process, as a step. */
const signalProcess = async (
  scope: CiJobScope,
  machine: MachineHandle,
  spec: StepSpec,
  opts: { id: string; signal: number },
): Promise<void> => {
  const trace = {
    machine,
    action: "process.signal",
    method: "process.signal",
    base: { process_id: opts.id },
  };

  await sandboxStep(scope, spec, trace, async () => {
    const sandbox = await directSandbox(scope.run, machine);
    const process = await processById(sandbox, opts.id);

    await process.signal({ signal: opts.signal });
  });
};

/** Read a process's output, as a step. */
const readOutputStep = (
  scope: CiJobScope,
  machine: MachineHandle,
  spec: StepSpec,
  opts: { id: string; tailBytes?: number | undefined },
): Promise<ProcessOutput> => {
  const trace = {
    machine,
    action: "process.output",
    method: "process.getOutput",
    base: { process_id: opts.id },
  };

  return sandboxStep(scope, spec, trace, async () => {
    const sandbox = await directSandbox(scope.run, machine);

    return readProcessOutput(
      await processById(sandbox, opts.id),
      opts.tailBytes,
    );
  });
};

const readResult = async (opts: {
  scope: CiJobScope;
  machine: MachineHandle;
  process: ProcessView;
  stepId: string;
  secrets: string[];
}): Promise<CommandResult> => {
  const { process } = opts;

  const output =
    process.output ??
    (await readOutputStep(
      opts.scope,
      opts.machine,
      steps.readOutput(opts.stepId),
      { id: process.id },
    ));

  return {
    exitCode: process.exitCode ?? (process.state === "EXITED" ? 0 : 1),
    stdout: maskSecrets(output.stdout, opts.secrets),
    stderr: maskSecrets(output.stderr, opts.secrets),
    truncated: output.truncated,
    ...processDuration(process),
  };
};

/**
 * How long a process ran, from the timestamps the sandbox gives it. Reading
 * the clock here instead would measure replays, not the process, since the
 * handler re-runs from the top on every step.
 */
const processDuration = (process: {
  startedAt?: string;
  endedAt?: string;
}): { durationMs?: number } => {
  if (!process.startedAt || !process.endedAt) {
    return {};
  }

  return {
    durationMs:
      new Date(process.endedAt).getTime() -
      new Date(process.startedAt).getTime(),
  };
};

/**
 * Publish a command's output to the run's realtime channel, so a UI can follow
 * along.
 *
 * This is best effort and deliberately not memoized, which matches the
 * realtime guidance for high-frequency updates: a failure here must never fail
 * the command it was describing.
 */
const publishOutput = async (
  scope: CiJobScope,
  stepId: string,
  stream: "stdout" | "stderr",
  text: string,
): Promise<void> => {
  if (!text) {
    return;
  }

  try {
    await scope.run.ci.client?.realtime?.publish?.(
      {
        channel: `ci:${scope.run.runId}`,
        topic: "output",
        config: {},
      },
      { jobPath: scope.path, stepId, stream, text },
    );
  } catch {
    // Best effort.
  }
};

const decoder = new TextDecoder();

const decodeChunks = (output: {
  chunks?: Array<{ stream: string; data: unknown }>;
}): { stdout: string; stderr: string } => {
  let stdout = "";
  let stderr = "";

  for (const chunk of output?.chunks ?? []) {
    const text =
      typeof chunk.data === "string"
        ? chunk.data
        : decoder.decode(chunk.data as Uint8Array);

    if (chunk.stream === "STDERR") {
      stderr += text;
    } else {
      stdout += text;
    }
  }

  return { stdout, stderr };
};

/**
 * Build a command from an argv array, for helpers that assemble their own.
 */
export const createRawCommand = (
  getScope: () => CiJobScope,
  argv: string[],
  /** How the command reads, when not as its arguments. */
  display: Pick<CommandState, "text" | "label"> = {},
): Command => {
  return new CommandBuilder(getScope, {
    argv,
    ...display,
    env: {},
    retries: 0,
    nothrow: false,
  });
};

/** Whether a value is a command, as `$` makes. */
export const isCommand = (value: unknown): value is Command => {
  return value instanceof CommandBuilder;
};

/** What a job's output stores of a command it returns. */
export const stateOfCommand = (command: Command): CommandState => {
  if (!(command instanceof CommandBuilder)) {
    throw new CiUsageError("Only a command made by `$` can be stored.");
  }

  return command.toState();
};

/** A command stored in a job's output, made again to run on `getScope`'s machine. */
export const commandFromJson = (
  getScope: () => CiJobScope,
  state: CommandState,
): Command => {
  return new CommandBuilder(getScope, { ...state, env: { ...state.env } });
};

/**
 * Build a `$` tag bound to a particular scope's machine.
 */
export const createCommandTag = (
  getScope: () => CiJobScope,
): CommandTag & { sh: CommandTag } => {
  const tag = ((strings: TemplateStringsArray, ...values: CommandValue[]) => {
    return createRawCommand(getScope, buildArgv([...strings], values));
  }) as unknown as CommandTag & { sh: CommandTag };

  tag.sh = (strings: TemplateStringsArray, ...values: CommandValue[]) => {
    const rendered = buildShellString([...strings], values);

    return createRawCommand(getScope, ["/bin/sh", "-c", rendered], {
      text: truncateLabel(rendered),
    });
  };

  return tag;
};

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Run a command on the current job's machine.
 *
 * Each command is a step: it never runs twice, it's retried if the machine
 * disappears, and it shows in the trace. A non-zero exit fails the job.
 *
 * ```ts
 * await $`pnpm test`;
 * ```
 *
 * Interpolated values are passed as arguments rather than pasted into a
 * string, so there's nothing to quote and nothing to escape:
 *
 * ```ts
 * await $`pnpm --filter ${pkg} test`;     // one argument, spaces and all
 * await $`pnpm test ${["--bail", "1"]}`;  // arrays spread
 * await $`pnpm test ${verbose && "-v"}`;  // false and null are dropped
 * ```
 *
 * The command is lazy until you await it, so the options chain:
 *
 * ```ts
 * await $`pnpm test`.retries(1).timeout("10m").env({ CI: "true" });
 * const sha = await $`git rev-parse HEAD`.text();
 * const server = await $`pnpm start`.background();
 * ```
 *
 * For pipes, redirects, or `&&`, use `$.sh`, which runs `/bin/sh -c` and
 * escapes what you interpolate:
 *
 * ```ts
 * await $.sh`pnpm build && pnpm test | tee test.log`;
 * ```
 *
 * @throws {CiUsageError} When called outside a job, since there's no machine
 * to run on.
 * @throws {CommandFailedError} When the command exits non-zero, unless
 * `.nothrow()` was used.
 * @throws {CommandTimeoutError} When `.timeout()` passes.
 */
export const $: CommandTag & { sh: CommandTag } = createCommandTag(() => {
  return requireJobScope("$");
});
