import { CiUsageError } from "./errors.ts";
import type { CiJobScope, CiRunScope, MachineHandle } from "./scope.ts";
import { getJobScope, requireJobScope, scopeSeparator } from "./scope.ts";
import type { AnyJob, Job, MachineConfig } from "./types.ts";
import { boundedName, slug, warnOnce } from "./util.ts";

/**
 * Memory is paired with vCPU count, so a job only picks one number.
 */
const memoryForVcpu = { 1: 1024, 2: 2048, 4: 4096 } as const;

export const resolveMachineConfig = (
  config: MachineConfig | undefined,
  // biome-ignore lint/suspicious/noExplicitAny: any logger-ish
  logger?: { warn: (...args: any[]) => void },
): { vcpu: 1 | 2 | 4; memoryMb: number } => {
  if (config?.image) {
    warnOnce(
      logger,
      "ci:machine.image",
      "`machine.image` is ignored: custom images aren't supported by Inngest Sandboxes yet.",
    );
  }

  if (config?.arch) {
    warnOnce(
      logger,
      "ci:machine.arch",
      "`machine.arch` is ignored: architecture selection isn't supported by Inngest Sandboxes yet.",
    );
  }

  const vcpu = config?.vcpu ?? 2;
  return { vcpu, memoryMb: memoryForVcpu[vcpu] };
};

/**
 * The name a machine is created with. It carries the run ID so orphaned
 * machines can be found and destroyed by the cleanup function.
 */
export const machineName = (runId: string, path: string): string =>
  boundedName(`ci-${runId}-${slug(path)}`);

/**
 * Create this scope's machine if it doesn't have one yet.
 *
 * Machines are lazy: a job that never runs a command never gets one, and
 * concurrent first commands share a single creation promise.
 */
export const ensureMachine = (scope: CiJobScope): Promise<MachineHandle> => {
  scope.machine ??= createMachine(scope);
  return scope.machine;
};

const createMachine = async (scope: CiJobScope): Promise<MachineHandle> => {
  const { run } = scope;
  const tools = run.sandboxTools;

  if (!tools) {
    throw new CiUsageError(
      "This pipeline has no `step.sandbox` tools. `createCi` adds `sandboxMiddleware()` to the functions it creates, so this usually means the function was created another way.",
    );
  }

  const name = machineName(run.runId, scope.path);
  const stepId = `${scope.path}${scopeSeparator}machine`;
  const machineConfig = resolveMachineConfig(
    scope.config.machine ?? run.ci.defaultMachine,
    run.ci.logger,
  );

  const sandbox = scope.fromSnapshotId
    ? await tools.create(stepId, {
        name,
        snapshotId: scope.fromSnapshotId,
      })
    : await tools.create(stepId, { name, ...machineConfig });

  run.sandboxes.add(sandbox.id);
  const handle: MachineHandle = { sandbox, name, id: sandbox.id };
  run.machines.set(scope.path, Promise.resolve(handle));

  return handle;
};

/**
 * Pause a finished job's machine rather than destroying it, so a later
 * `from()` can still snapshot it. Everything is destroyed at the end of the
 * run.
 */
export const pauseMachine = async (scope: CiJobScope): Promise<void> => {
  if (!scope.machine) {
    return;
  }

  try {
    const machine = await scope.machine;
    await machine.sandbox.pause(`${scope.path}${scopeSeparator}pause`);
  } catch (error) {
    // Pausing is an optimisation; a machine that can't pause is still
    // destroyed at the end of the run.
    scope.run.warnings.push(
      `Could not pause \`${scope.path}\`: ${errorMessage(error)}`,
    );
  }
};

/**
 * Snapshot a job's machine, once per parent per run.
 *
 * Returns `undefined` when the job had no machine, or when snapshots aren't
 * available in this environment, in which case callers fall back to a fresh
 * machine.
 */
export const snapshotJob = (
  run: CiRunScope,
  jobPath: string,
): Promise<string | undefined> => {
  const existing = run.snapshots.get(jobPath);
  if (existing) {
    return existing;
  }

  const created = createSnapshot(run, jobPath);
  run.snapshots.set(jobPath, created);
  return created;
};

const createSnapshot = async (
  run: CiRunScope,
  jobPath: string,
): Promise<string | undefined> => {
  const cached = run.cacheEntries.get(jobPath);
  if (cached?.snapshotId) {
    return cached.snapshotId;
  }

  const handle = await run.machines.get(jobPath);
  if (!handle) {
    return undefined;
  }

  try {
    // A paused machine has to be running again before it can be snapshotted.
    await handle.sandbox.resume(`${jobPath}${scopeSeparator}resume`);
  } catch {
    // Already running, or resume isn't supported here. The snapshot below
    // decides whether this actually mattered.
  }

  try {
    const snapshot = await handle.sandbox.snapshot(
      `${jobPath}${scopeSeparator}snapshot`,
    );
    return snapshot.id;
  } catch (error) {
    if (!isSnapshotUnavailable(error)) {
      throw error;
    }

    run.snapshotsUnavailable = true;
    run.warnings.push(
      `fell back: snapshots unavailable (\`${jobPath}\`), so jobs started from it ran on fresh machines`,
    );
    return undefined;
  }
};

/**
 * Snapshot endpoints may be missing in some environments, like an older Dev
 * Server. Those failures fall back to a fresh machine rather than failing the
 * run; real failures still surface.
 */
const isSnapshotUnavailable = (error: unknown): boolean => {
  const message = errorMessage(error).toLowerCase();
  const code = (error as { cause?: { code?: string; status?: number } })?.cause;

  if (code?.status === 404 || code?.status === 501) {
    return true;
  }

  return (
    message.includes("not implemented") ||
    message.includes("unsupported") ||
    message.includes("not supported") ||
    message.includes("404") ||
    message.includes("no route") ||
    message.includes("unknown action")
  );
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Start this job on a copy of another job's machine.
 *
 * Runs the parent job if it hasn't run, takes a snapshot of where it finished,
 * and returns the parent's result. The copy is made when this job runs its
 * first command.
 */
export async function from<TResult>(job: Job<TResult>): Promise<TResult>;
export async function from<TResult, TInput>(
  job: Job<TResult, TInput>,
  input: TInput,
): Promise<TResult>;
export async function from(job: AnyJob, input?: unknown): Promise<unknown> {
  const scope = requireJobScope("from");

  if (scope.machine) {
    throw new CiUsageError(
      "`from()` must come before this job's first command, and can only be called once.",
    );
  }

  if (scope.fromCalled) {
    throw new CiUsageError(
      "`from()` must come before this job's first command, and can only be called once.",
    );
  }

  scope.fromCalled = true;
  scope.fromJobIds.push(job.id);

  const result = await job(input as never);

  const snapshotId = await snapshotJob(scope.run, job.id);
  if (snapshotId) {
    scope.fromSnapshotId = snapshotId;
  }

  return result;
}

/**
 * Destroy every machine this run created. Tolerates machines that are already
 * gone, because cleanup also runs after failures.
 */
export const destroyRunMachines = async (run: CiRunScope): Promise<void> => {
  const ids = [...run.sandboxes];
  if (ids.length === 0) {
    return;
  }

  await run.step.run(
    { id: `pipeline${scopeSeparator}cleanup`, name: "cleanup" },
    async () => {
      const destroyed: string[] = [];

      for (const id of ids) {
        try {
          const sandbox = await run.ci.client.sandboxes.get(id);
          if (sandbox) {
            await sandbox.destroy();
            destroyed.push(id);
          }
        } catch {
          // Already gone, or gone by the time we asked.
        }
      }

      return { destroyed };
    },
  );
};

/**
 * The current job's machine, for helpers that need it directly.
 */
export const currentMachine = async (
  api: string,
): Promise<{ scope: CiJobScope; machine: MachineHandle }> => {
  const scope = requireJobScope(api);
  return { scope, machine: await ensureMachine(scope) };
};

export const currentJobPath = (): string | undefined => getJobScope()?.path;
