/**
 * Running commands on a job's machine: the `$` tag, its builder methods and
 * the raw command helper other APIs reuse. Process plumbing for the sandbox
 * API (start, poll, read output) lives here too.
 *
 * @module
 */

import { getSandboxError } from "inngest/experimental";
import { CommandFailedError, CommandTimeoutError } from "../errors.ts";
import type { CiJobScope, MachineHandle } from "../pipeline/scope.ts";
import {
  defaultCwd,
  nextStepId,
  requireJobScope,
  scopeSeparator,
} from "../pipeline/scope.ts";
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
  warnOnce,
} from "../util.ts";
import { ensureMachine } from "./machine.ts";

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
  label?: string;
  env: Record<string, string>;
  cwd?: string;
  retries: number;
  nothrow: boolean;
  timeout?: Duration;
  onTimeout?: () => Promise<unknown>;
  secrets: Array<{ name: string; value: string }>;
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

/** The id and name of a step nested under `stepId`. */
const subStep = (stepId: string, suffix: string) => {
  const id = `${stepId}${scopeSeparator}${suffix}`;
  return { id, name: id };
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

  withSecret(name: string, value: string): Command {
    warnOnce(
      this.getScope().run.ci.logger,
      "ci:withSecret",
      "`withSecret()` passes the value as an environment variable from inside the step handler. It never appears in step input or output, but it isn't isolated from code running on the machine.",
    );
    this.state.secrets.push({ name, value });
    return this;
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
    const stepId = this.stepId(scope);
    const machine = await ensureMachine(scope);
    const process = await startProcess(
      machine,
      stepId,
      this.spawnOptions(scope),
    );

    const argv = this.state.argv;
    const secrets = this.secretValues(scope);
    // Numbers the follow-up steps, so calling `exited()` or `output()` more
    // than once never reuses a step ID.
    const nextWait = counter();

    return {
      id: process.id,
      exited: async () => {
        const polled = await pollUntilTerminal({
          scope,
          machine,
          process,
          stepId,
          nextWait,
        });
        return readResult({ process: polled.process, stepId, argv, secrets });
      },
      kill: async (signal = 15) => {
        await process.signal(subStep(stepId, "kill"), { signal });
      },
      output: async (opts) => {
        const output = await process.getOutput(
          subStep(stepId, `output #${nextWait()}`),
          { tailBytes: opts?.tailBytes ?? outputTailBytes },
        );
        const decoded = decodeChunks(output);
        return maskSecrets(`${decoded.stdout}${decoded.stderr}`, secrets);
      },
    };
  }

  /** Runs once however many times the command is awaited. */
  private exec(): Promise<CommandResult> {
    this.started ??= this.runWithRetries();
    return this.started;
  }

  private labelText(): string {
    return this.state.label ?? truncateLabel(this.state.argv.join(" "));
  }

  private stepId(scope: CiJobScope): string {
    return nextStepId(scope.run, scope.path, this.labelText());
  }

  private environment(scope: CiJobScope): Record<string, string> {
    return {
      ...scope.env,
      ...this.state.env,
      ...Object.fromEntries(
        this.state.secrets.map((secret) => {
          return [secret.name, secret.value];
        }),
      ),
    };
  }

  private secretValues(scope: CiJobScope): string[] {
    return [
      ...scope.secrets,
      ...this.state.secrets.map((secret) => {
        return secret.value;
      }),
    ];
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

  private async runWithRetries(): Promise<CommandResult> {
    const scope = this.getScope();
    const stepId = this.stepId(scope);
    const attempts = Math.max(0, this.state.retries) + 1;

    for (let attempt = 1; ; attempt++) {
      const attemptId =
        attempts === 1 ? stepId : `${stepId} #attempt-${attempt}`;
      const result = await this.runOnce(scope, attemptId);

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
    const started = Date.now();
    const secrets = this.secretValues(scope);
    const { command, ...options } = this.spawnOptions(scope);

    try {
      const result = await machine.sandbox.commands.run(
        { id: stepId, name: stepId },
        command,
        { ...options, timeout: timeoutMs },
      );

      return {
        exitCode: result.exitCode,
        stdout: maskSecrets(result.stdout, secrets),
        stderr: maskSecrets(result.stderr, secrets),
        truncated: result.output?.truncated === true,
        durationMs: Date.now() - started,
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
    const started = Date.now();
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
      await process.signal(subStep(stepId, "timeout-kill"), { signal: 9 });
      throw this.timeoutError(scope);
    }

    const result = await readResult({
      process: polled.process,
      stepId,
      argv: this.state.argv,
      secrets: this.secretValues(scope),
      startedAt: started,
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
      subStep(stepId, "start"),
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
    subStep(stepId, "reconcile"),
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
      subStep(opts.stepId, `wait #${index}`),
      interval,
    );
    elapsed += interval;

    current =
      (await opts.machine.sandbox.processes.get(
        subStep(opts.stepId, `check #${index}`),
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
  startedAt?: number;
}): Promise<CommandResult> => {
  const output = await opts.process.getOutput(subStep(opts.stepId, "output"), {
    tailBytes: outputTailBytes,
  });

  const decoded = decodeChunks(output);
  const stdout = tail(decoded.stdout, outputTailBytes);
  const stderr = tail(decoded.stderr, outputTailBytes);

  return {
    exitCode:
      opts.process.exitCode ?? (opts.process.state === "EXITED" ? 0 : 1),
    stdout: maskSecrets(stdout.text, opts.secrets),
    stderr: maskSecrets(stderr.text, opts.secrets),
    truncated: stdout.truncated || stderr.truncated,
    durationMs: processDurationMs(opts.process, opts.startedAt),
  };
};

const processDurationMs = (
  process: { startedAt?: string; endedAt?: string },
  fallbackStart?: number,
): number => {
  if (process.startedAt && process.endedAt) {
    return (
      new Date(process.endedAt).getTime() -
      new Date(process.startedAt).getTime()
    );
  }
  return fallbackStart ? Date.now() - fallbackStart : 0;
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
  label?: string,
): Command => {
  return new CommandBuilder(getScope, {
    argv,
    ...(label === undefined ? {} : { label }),
    env: {},
    retries: 0,
    nothrow: false,
    secrets: [],
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
    return createRawCommand(
      getScope,
      ["/bin/sh", "-c", rendered],
      truncateLabel(rendered),
    );
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
