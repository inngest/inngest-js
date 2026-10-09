/**
 * Running commands on a job's machine: the `$` tag, its builder methods and
 * the raw command helper other APIs reuse. Process plumbing for the sandbox
 * API (start, poll, read output) lives here too.
 *
 * @module
 */

import { NonRetriableError, StepError } from "inngest";
import { getSandboxError } from "inngest/experimental";
import {
  CiUsageError,
  CommandFailedError,
  CommandTimeoutError,
} from "../errors.ts";
import { ciSpan, ciStep, traceName } from "../pipeline/names.ts";
import type { CiJobScope, MachineHandle } from "../pipeline/scope.ts";
import {
  countApi,
  defaultCwd,
  nextStepId,
  requireJobScope,
  scopeSeparator,
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
  maskSecrets,
  shellEscape,
  tail,
  truncateLabel,
} from "../util.ts";
import { ensureMachine, inMachineSpan } from "./machine.ts";

/**
 * Captured `commands.run` is capped at five minutes, so anything longer runs
 * as a managed process instead.
 */
const capturedExecLimitMs = 5 * 60 * 1000;

/** How much of each stream is kept on a `CommandResult`. */
const outputTailBytes = 64 * 1024;

const terminalStates = new Set(["EXITED", "KILLED", "FAILED", "LOST"]);

/**
 * Poll intervals for the managed-process loop, in milliseconds. The last one
 * repeats. There are no process exit events yet, so the loop is how a command
 * longer than the captured-exec cap is followed.
 */
const pollIntervalsMs = [1000, 2000, 5000, 10_000];
const maxPollIntervalMs = 15_000;

// biome-ignore lint/suspicious/noExplicitAny: DurableSandboxProcess, loose like MachineHandle
type SandboxProcess = any;

interface CommandState {
  argv: string[];
  /** What the command reads as, when that isn't its argv, as for `$.sh`. */
  text?: string;
  /** A name for the command, from `.as()` or the helper that made it. */
  label?: string;
  env: Record<string, string>;
  cwd?: string;
  retries: number;
  nothrow: boolean;
  timeout?: Duration;
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

/**
 * A step nested under `stepId`, named for what it does. It's CI's work: the
 * command's span is yours, but how CI runs it isn't.
 */
const subStep = (stepId: string, suffix: string, name: string) => {
  return ciStep(`${stepId}${scopeSeparator}${suffix}`, name);
};

class CommandBuilder implements Command {
  private readonly getScope: () => CiJobScope;
  private readonly state: CommandState;
  private started?: Promise<CommandResult>;

  constructor(getScope: () => CiJobScope, state: CommandState) {
    this.getScope = getScope;

    this.state = state;
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
    this.state.timeout = duration;

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

    // Each call back into the process re-enters the command's span.
    const process = await this.inSpan(scope, stepId, () => {
      return startProcess(machine, stepId, this.spawnOptions(scope));
    });

    const argv = this.state.argv;
    const secrets = this.secretValues(scope);
    // Numbers the follow-up steps, so calling `exited()` or `output()` more
    // than once never reuses a step ID.
    const nextWait = counter();

    return {
      id: process.id,
      exited: () => {
        return this.inSpan(scope, stepId, async () => {
          const polled = await pollUntilTerminal({
            scope,
            machine,
            process,
            stepId,
            nextWait,
          });

          return readResult({ process: polled.process, stepId, argv, secrets });
        });
      },
      kill: async (signal = 15) => {
        await this.inSpan(scope, stepId, () => {
          return process.signal(
            subStep(stepId, "kill", traceName.stopProcess),
            { signal },
          );
        });
      },
      output: async (opts) => {
        const output = await this.inSpan(scope, stepId, () => {
          return process.getOutput(
            subStep(stepId, `output #${nextWait()}`, traceName.readOutput),
            {
              tailBytes: opts?.tailBytes ?? outputTailBytes,
            },
          );
        });

        const decoded = decodeChunks(output);

        return maskSecrets(`${decoded.stdout}${decoded.stderr}`, secrets);
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
      timeout: this.state.timeout ?? "",
      jobPath: scope.path,
    });
  }

  /** Run `fn` in the command's span, in its machine's span if it's an extra. */
  private inSpan<T>(scope: CiJobScope, stepId: string, fn: () => T): T {
    const span = {
      id: stepId,
      name: traceName.command(this.commandText(), this.state.label),
    };

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
          await recordFailure(scope, attemptId, result.exitCode);
        }

        return result;
      };

      const result = await this.inSpan(scope, stepId, () => {
        return attempts === 1
          ? runAttempt()
          : inSpan(
              ciSpan(`attempt-${attempt}`, traceName.attempt(attempt)),
              runAttempt,
            );
      });

      scope.run.ci.hooks.commandFinished(scope, attemptInfo, result);

      scope.run.ci.hooks.commandFinished(scope, attemptInfo, result);

      if (result.exitCode === 0 || this.state.nothrow) {
        return result;
      }

      const error = new CommandFailedError({
        command: this.state.argv,
        exitCode: result.exitCode,
        stdoutTail: result.stdout,
        stderrTail: result.stderr,
        jobPath: scope.path,
      });

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

  /** One attempt, which never throws for a non-zero exit. */
  private async runOnce(
    scope: CiJobScope,
    stepId: string,
  ): Promise<CommandResult> {
    const machine = await ensureMachine(scope);

    const timeoutMs = this.state.timeout
      ? durationToMs(this.state.timeout)
      : undefined;

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
    const process = await startProcess(
      machine,
      stepId,
      this.spawnOptions(scope),
    );

    const polled = await pollUntilTerminal({
      scope,
      machine,
      process,
      stepId,
      nextWait: counter(),
      timeoutMs,
    });

    if (polled.timedOut) {
      await this.state.onTimeout?.();

      await process.signal(
        subStep(stepId, "timeout-kill", traceName.stopAfterTimeout),
        { signal: 9 },
      );

      throw this.timeoutError(scope);
    }

    const result = await readResult({
      process: polled.process,
      stepId,
      argv: this.state.argv,
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
  exitCode: number,
): Promise<void> => {
  try {
    await scope.run.step.run(
      subStep(stepId, "exit", traceName.exited(exitCode)),
      () => {
        throw new NonRetriableError(`exit ${exitCode}`);
      },
    );
  } catch (error) {
    if (!(error instanceof StepError)) {
      throw error;
    }
  }
};

/**
 * Start a managed process. Cloud can answer a start that succeeded with an
 * ambiguous error, in which case the process that did start is adopted
 * instead of starting the command a second time.
 */
const startProcess = async (
  machine: MachineHandle,
  stepId: string,
  options: {
    command: string[];
    environment: Record<string, string>;
    cwd: string;
  },
): Promise<SandboxProcess> => {
  machine.claimedProcessIds ??= new Set<string>();

  const claimed = machine.claimedProcessIds;

  try {
    const process = await machine.sandbox.processes.start(
      subStep(stepId, "start", traceName.startProcess),
      options,
    );

    claimed.add(process.id);

    return process;
  } catch (error) {
    const adopted = await adoptAmbiguousStart(
      machine,
      stepId,
      options.command,
      claimed,
      error,
    );

    claimed.add(adopted.id);

    return adopted;
  }
};

/**
 * WORKAROUND (Sandboxes API): Cloud can answer a `process.start` that
 * succeeded with `409 operation_ambiguous`, and the error says to list
 * processes and reconcile before starting another. Delete this, and the
 * `claimedProcessIds` bookkeeping on `MachineHandle`, once starts are no
 * longer ambiguous.
 *
 * This lists processes, as a step, and returns the newest one running the
 * same command that this run hasn't already claimed. With nothing to adopt,
 * or any other error, the original error is rethrown.
 */
const adoptAmbiguousStart = async (
  machine: MachineHandle,
  stepId: string,
  command: readonly string[],
  claimed: ReadonlySet<string>,
  error: unknown,
): Promise<SandboxProcess> => {
  const sandboxError = getSandboxError(error);

  if (
    sandboxError?.code !== "operation_ambiguous" ||
    sandboxError.action !== "process.start"
  ) {
    throw error;
  }

  const listed = (await machine.sandbox.processes.list(
    subStep(stepId, "reconcile", traceName.findStartedProcess),
    { limit: 250 },
  )) as {
    items: Array<{
      id: string;
      command: readonly string[];
      startedAt?: string;
    }>;
  };

  const [match] = listed.items
    .filter((process) => {
      return (
        !claimed.has(process.id) &&
        process.command.length === command.length &&
        process.command.every((arg, index) => {
          return arg === command[index];
        })
      );
    })
    .sort((a, b) => {
      return (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
    });

  if (!match) {
    throw error;
  }

  return match;
};

/**
 * Follow a managed process until it reaches a terminal state, or until
 * `timeoutMs` of polling has passed.
 *
 * Each check is its own step, with a durable sleep between them, so a command
 * can run for as long as it needs without holding a worker.
 *
 * The sandbox API's `process.wait` blocks server-side for at most five minutes
 * and raises an error when that passes, which would spend the function's
 * retries on a healthy long-running command. Sleeping between `process.get`
 * calls never errors and has no upper bound.
 */
const pollUntilTerminal = async (opts: {
  scope: CiJobScope;
  machine: MachineHandle;
  process: SandboxProcess;
  stepId: string;
  /** Numbers each wait, so step IDs stay unique across calls. */
  nextWait: () => number;
  timeoutMs?: number | undefined;
}): Promise<{ process: SandboxProcess; timedOut: boolean }> => {
  let current = opts.process;
  let elapsed = 0;

  while (!terminalStates.has(current.state)) {
    if (opts.timeoutMs !== undefined && elapsed >= opts.timeoutMs) {
      return { process: current, timedOut: true };
    }

    const index = opts.nextWait();
    const interval = pollIntervalsMs[index - 1] ?? maxPollIntervalMs;

    await opts.scope.run.step.sleep(
      subStep(opts.stepId, `wait #${index}`, traceName.wait(interval)),
      interval,
    );

    elapsed += interval;

    current =
      (await opts.machine.sandbox.processes.get(
        subStep(opts.stepId, `check #${index}`, traceName.pollProcess),
        current.id,
      )) ?? current;
  }

  return { process: current, timedOut: false };
};

const readResult = async (opts: {
  process: SandboxProcess;
  stepId: string;
  argv: string[];
  secrets: string[];
}): Promise<CommandResult> => {
  const output = await opts.process.getOutput(
    subStep(opts.stepId, "output", traceName.readOutput),
    {
      tailBytes: outputTailBytes,
    },
  );

  const decoded = decodeChunks(output);
  const stdout = tail(decoded.stdout, outputTailBytes);
  const stderr = tail(decoded.stderr, outputTailBytes);

  return {
    exitCode:
      opts.process.exitCode ?? (opts.process.state === "EXITED" ? 0 : 1),
    stdout: maskSecrets(stdout.text, opts.secrets),
    stderr: maskSecrets(stderr.text, opts.secrets),
    truncated: stdout.truncated || stderr.truncated,
    ...processDuration(opts.process),
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
