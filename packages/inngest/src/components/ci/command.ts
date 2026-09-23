import { CommandFailedError, CommandTimeoutError } from "./errors.ts";
import { ensureMachine } from "./machine.ts";
import type { CiJobScope, MachineHandle } from "./scope.ts";
import { nextStepId, requireJobScope, scopeSeparator } from "./scope.ts";
import type {
  BackgroundProcess,
  Command,
  CommandResult,
  CommandTag,
  CommandValue,
  Duration,
} from "./types.ts";
import {
  durationToMs,
  maskSecrets,
  shellEscape,
  tail,
  truncateLabel,
  warnOnce,
} from "./util.ts";

/**
 * Captured `commands.run` is capped at five minutes, so anything longer runs
 * as a managed process instead.
 */
export const capturedExecLimitMs = 5 * 60 * 1000;

/** How much of each stream is kept on a `CommandResult`. */
export const outputTailBytes = 64 * 1024;

/** The default working directory, which is where `checkout()` puts the repo. */
export const defaultCwd = "/work";

const terminalStates = new Set(["EXITED", "KILLED", "FAILED", "LOST"]);

/**
 * Poll intervals for the managed-process loop, in milliseconds. The last one
 * repeats. There are no process exit events yet, so the loop is how a command
 * longer than the captured-exec cap is followed.
 */
const pollIntervalsMs = [1000, 2000, 5000, 10_000, 15_000];

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
  let openToken = false;

  const push = (token: string, joinable: boolean) => {
    if (joinable && openToken && argv.length > 0) {
      argv[argv.length - 1] = `${argv[argv.length - 1]}${token}`;
      return;
    }
    argv.push(token);
  };

  for (const [index, chunk] of strings.entries()) {
    const tokens = chunk.split(/\s+/);
    for (const [tokenIndex, token] of tokens.entries()) {
      if (token === "") {
        // Whitespace closes the current argument.
        if (tokenIndex > 0 || chunk.length > 0) {
          openToken = false;
        }
        continue;
      }
      push(token, tokenIndex === 0);
      openToken = true;
    }

    // Trailing whitespace closes the current argument.
    if (chunk !== "" && /\s$/.test(chunk)) {
      openToken = false;
    }

    if (index < values.length) {
      const value = values[index];

      if (value === null || value === undefined || value === false) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          argv.push(String(item));
        }
        openToken = false;
        continue;
      }

      push(String(value), openToken);
      openToken = true;
    }
  }

  return argv.filter((token) => token !== "");
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

    if (index < values.length) {
      const value = values[index];
      if (value === null || value === undefined || value === false) {
        continue;
      }
      if (Array.isArray(value)) {
        out += value.map((item) => shellEscape(String(item))).join(" ");
        continue;
      }
      out += shellEscape(String(value));
    }
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
    const scope = this.getScope();
    warnOnce(
      scope.run.ci.logger,
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

  async background(): Promise<BackgroundProcess> {
    const scope = this.getScope();
    const stepId = this.stepId(scope);
    const machine = await ensureMachine(scope);

    const process = await startProcess(machine, stepId, {
      command: this.state.argv,
      environment: this.environment(scope),
      cwd: this.state.cwd ?? scope.cwd ?? defaultCwd,
    });

    const argv = this.state.argv;
    const secrets = this.secretValues(scope);
    let waits = 0;

    return {
      id: process.id,
      exited: async () => {
        const terminal = await pollUntilTerminal({
          scope,
          machine,
          process,
          stepId,
          nextWait: () => ++waits,
        });
        return readResult({
          process: terminal,
          stepId,
          argv,
          secrets,
        });
      },
      kill: async (signal = 15) => {
        await process.signal(
          {
            id: `${stepId}${scopeSeparator}kill`,
            name: `${stepId}${scopeSeparator}kill`,
          },
          { signal },
        );
      },
      output: async (opts) => {
        const result = await process.getOutput(
          {
            id: `${stepId}${scopeSeparator}output #${++waits}`,
            name: `${stepId}${scopeSeparator}output #${waits}`,
          },
          { tailBytes: opts?.tailBytes ?? outputTailBytes },
        );
        const decoded = decodeChunks(result);
        return maskSecrets(`${decoded.stdout}${decoded.stderr}`, secrets);
      },
    };
  }

  then<TResult1 = CommandResult, TResult2 = never>(
    onfulfilled?:
      | ((value: CommandResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
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
        this.state.secrets.map((secret) => [secret.name, secret.value]),
      ),
    };
  }

  private secretValues(scope: CiJobScope): string[] {
    return [...scope.secrets, ...this.state.secrets.map((s) => s.value)];
  }

  private exec(): Promise<CommandResult> {
    this.started ??= this.run();
    return this.started;
  }

  private async run(): Promise<CommandResult> {
    const scope = this.getScope();
    const stepId = this.stepId(scope);
    const attempts = Math.max(0, this.state.retries) + 1;

    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const attemptId =
        attempts === 1 ? stepId : `${stepId} #attempt-${attempt}`;

      try {
        const result = await this.runOnce(scope, attemptId);

        if (result.exitCode !== 0 && !this.state.nothrow) {
          throw new CommandFailedError({
            command: this.state.argv,
            exitCode: result.exitCode,
            stdoutTail: result.stdout,
            stderrTail: result.stderr,
            jobPath: scope.path,
          });
        }

        return result;
      } catch (error) {
        lastError = error;

        const retriable =
          error instanceof CommandFailedError && attempt < attempts;
        if (!retriable) {
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

    throw lastError;
  }

  private async runOnce(
    scope: CiJobScope,
    stepId: string,
  ): Promise<CommandResult> {
    const machine = await ensureMachine(scope);
    const started = Date.now();
    const timeoutMs = this.state.timeout
      ? durationToMs(this.state.timeout)
      : undefined;
    const secrets = this.secretValues(scope);

    // Short commands with an explicit timeout run as one captured step, which
    // is cheaper and keeps the trace tidy.
    if (timeoutMs !== undefined && timeoutMs <= capturedExecLimitMs) {
      const result = await machine.sandbox.commands.run(
        { id: stepId, name: stepId },
        this.state.argv,
        {
          environment: this.environment(scope),
          cwd: this.state.cwd ?? scope.cwd ?? defaultCwd,
          timeout: timeoutMs,
        },
      );

      return {
        exitCode: result.exitCode,
        stdout: maskSecrets(result.stdout, secrets),
        stderr: maskSecrets(result.stderr, secrets),
        truncated: result.output?.truncated === true,
        durationMs: Date.now() - started,
      };
    }

    const process = await startProcess(machine, stepId, {
      command: this.state.argv,
      environment: this.environment(scope),
      cwd: this.state.cwd ?? scope.cwd ?? defaultCwd,
    });

    let waits = 0;
    const terminal = await pollUntilTerminal({
      scope,
      machine,
      process,
      stepId,
      nextWait: () => ++waits,
      timeoutMs,
      onTimeout: async () => {
        if (this.state.onTimeout) {
          await this.state.onTimeout();
        }

        await process.signal(
          {
            id: `${stepId}${scopeSeparator}timeout-kill`,
            name: `${stepId}${scopeSeparator}timeout-kill`,
          },
          { signal: 9 },
        );

        throw new CommandTimeoutError({
          command: this.state.argv,
          timeout: this.state.timeout ?? "",
          jobPath: scope.path,
        });
      },
    });

    const result = await readResult({
      process: terminal,
      stepId,
      argv: this.state.argv,
      secrets,
      startedAt: started,
    });

    await publishOutput(scope, {
      jobPath: scope.path,
      stepId,
      stream: "stdout",
      text: result.stdout,
    });

    await publishOutput(scope, {
      jobPath: scope.path,
      stepId,
      stream: "stderr",
      text: result.stderr,
    });

    return result;
  }
}

interface StartedProcess {
  id: string;
  command: readonly string[];
  startedAt?: string;
}

const isAmbiguousStart = (error: unknown): boolean => {
  const { code, action } = (error ?? {}) as { code?: string; action?: string };
  return code === "operation_ambiguous" && action === "process.start";
};

const sameArgv = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((arg, i) => arg === b[i]);

/**
 * Start a managed process, reconciling an ambiguous start.
 *
 * Cloud can answer a start that succeeded with `409 operation_ambiguous`, and
 * the error says to list processes and reconcile before starting another. So
 * this lists them, as a step, and adopts the newest process running the same
 * command that this run hasn't already claimed. It never starts the command a
 * second time; with nothing to adopt, the original error stands.
 */
const startProcess = async (
  machine: MachineHandle,
  stepId: string,
  options: {
    command: string[];
    environment?: Record<string, string>;
    cwd: string;
  },
  // biome-ignore lint/suspicious/noExplicitAny: DurableSandboxProcess, loose like MachineHandle
): Promise<any> => {
  machine.claimedProcessIds ??= new Set<string>();
  const claimed = machine.claimedProcessIds;
  const claim = <T extends { id: string }>(process: T): T => {
    claimed.add(process.id);
    return process;
  };

  try {
    return claim(
      await machine.sandbox.processes.start(
        {
          id: `${stepId}${scopeSeparator}start`,
          name: `${stepId}${scopeSeparator}start`,
        },
        options,
      ),
    );
  } catch (error) {
    if (!isAmbiguousStart(error)) {
      throw error;
    }

    const listed = (await machine.sandbox.processes.list(
      {
        id: `${stepId}${scopeSeparator}reconcile`,
        name: `${stepId}${scopeSeparator}reconcile`,
      },
      { limit: 250 },
    )) as { items: StartedProcess[] };

    const [match] = listed.items
      .filter(
        (process) =>
          !claimed.has(process.id) &&
          sameArgv(process.command, options.command),
      )
      .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));

    if (!match) {
      throw error;
    }

    return claim(match);
  }
};

/**
 * Follow a managed process until it reaches a terminal state.
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
  // biome-ignore lint/suspicious/noExplicitAny: MachineHandle
  machine: any;
  // biome-ignore lint/suspicious/noExplicitAny: DurableSandboxProcess
  process: any;
  stepId: string;
  nextWait: () => number;
  timeoutMs?: number;
  onTimeout?: () => Promise<never>;
  // biome-ignore lint/suspicious/noExplicitAny: DurableSandboxProcess
}): Promise<any> => {
  let current = opts.process;
  let elapsed = 0;

  while (!terminalStates.has(current.state)) {
    if (opts.timeoutMs !== undefined && elapsed >= opts.timeoutMs) {
      if (opts.onTimeout) {
        await opts.onTimeout();
      }
      return current;
    }

    const index = opts.nextWait();
    const interval =
      pollIntervalsMs[Math.min(index - 1, pollIntervalsMs.length - 1)] ??
      15_000;

    await opts.scope.run.step.sleep(
      {
        id: `${opts.stepId}${scopeSeparator}wait #${index}`,
        name: `${opts.stepId}${scopeSeparator}wait #${index}`,
      },
      interval,
    );
    elapsed += interval;

    const refreshed = await opts.machine.sandbox.processes.get(
      {
        id: `${opts.stepId}${scopeSeparator}check #${index}`,
        name: `${opts.stepId}${scopeSeparator}check #${index}`,
      },
      current.id,
    );

    if (refreshed) {
      current = refreshed;
    }
  }

  return current;
};

const readResult = async (opts: {
  // biome-ignore lint/suspicious/noExplicitAny: DurableSandboxProcess
  process: any;
  stepId: string;
  argv: string[];
  secrets: string[];
  startedAt?: number;
}): Promise<CommandResult> => {
  const output = await opts.process.getOutput(
    {
      id: `${opts.stepId}${scopeSeparator}output`,
      name: `${opts.stepId}${scopeSeparator}output`,
    },
    { tailBytes: outputTailBytes },
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
export const publishOutput = async (
  scope: CiJobScope,
  payload: {
    jobPath: string;
    stepId: string;
    stream: "stdout" | "stderr";
    text: string;
  },
): Promise<void> => {
  if (!payload.text) {
    return;
  }

  try {
    await scope.run.ci.client?.realtime?.publish?.(
      {
        channel: `ci:${scope.run.runId}`,
        topic: "output",
        config: {},
      },
      payload,
    );
  } catch {
    // Best effort.
  }
};

const decoder = new TextDecoder();

export const decodeChunks = (output: {
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
): Command =>
  new CommandBuilder(getScope, {
    argv,
    ...(label === undefined ? {} : { label }),
    env: {},
    retries: 0,
    nothrow: false,
    secrets: [],
  });

/**
 * Build a `$` tag bound to a particular scope's machine.
 */
export const createCommandTag = (
  getScope: () => CiJobScope,
): CommandTag & { sh: CommandTag } => {
  const tag = ((strings: TemplateStringsArray, ...values: CommandValue[]) =>
    new CommandBuilder(getScope, {
      argv: buildArgv([...strings], values),
      env: {},
      retries: 0,
      nothrow: false,
      secrets: [],
    })) as unknown as CommandTag & { sh: CommandTag };

  tag.sh = (strings: TemplateStringsArray, ...values: CommandValue[]) => {
    const rendered = buildShellString([...strings], values);
    return new CommandBuilder(getScope, {
      argv: ["/bin/sh", "-c", rendered],
      label: truncateLabel(rendered),
      env: {},
      retries: 0,
      nothrow: false,
      secrets: [],
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
export const $: CommandTag & { sh: CommandTag } = createCommandTag(() =>
  requireJobScope("$"),
);
