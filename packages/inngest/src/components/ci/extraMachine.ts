import { createCommandTag } from "./command.ts";
import { CiNotSupportedError } from "./errors.ts";
import { waitForHttp, waitForPort } from "./helpers.ts";
import { ensureMachine } from "./machine.ts";
import type { CiJobScope } from "./scope.ts";
import { requireJobScope, scopeSeparator } from "./scope.ts";
import type { Duration, ExtraMachine, MachineConfig } from "./types.ts";

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Create another machine for this job, for work that needs several machines
 * alive at the same time.
 *
 * `$` on its own still means the job's own machine. Extra machines are
 * destroyed with the pipeline.
 */
export const sandbox = async (
  name: string,
  config: MachineConfig = {},
): Promise<ExtraMachine> => {
  const job = requireJobScope("sandbox");
  const path = `${job.jobPath}${scopeSeparator}${name}`;

  const existing = job.extras?.get(name);
  const scope: CiJobScope =
    existing ??
    ({
      run: job.run,
      path,
      jobPath: job.jobPath,
      config: { ...job.config, id: path, machine: config },
      fromCalled: false,
      fromJobIds: [],
      annotations: [],
      summaries: [],
      checkStarted: false,
      env: {},
      secrets: [],
    } satisfies CiJobScope);

  job.extras ??= new Map();
  job.extras.set(name, scope);

  // The machine is created up front here, because callers asked for it by
  // name rather than by running a command.
  await ensureMachine(scope);

  return {
    name,
    $: createCommandTag(() => scope),
    waitForPort: (port: number, opts?: { timeout?: Duration }) =>
      waitForPort(port, opts ?? {}, scope),
    waitForHttp: (
      url: string,
      opts?: { timeout?: Duration; status?: number },
    ) => waitForHttp(url, opts ?? {}, scope),
    url: (_port: number): string => {
      throw new CiNotSupportedError(
        "ExtraMachine.url",
        "Machines can't reach each other yet, so there's no URL to give you. Run the server on the job's own machine and use `127.0.0.1` for now.",
      );
    },
  };
};
