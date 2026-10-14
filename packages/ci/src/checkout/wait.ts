/**
 * Waiting for something on a machine to come up: `waitForHttp` and
 * `waitForPort`.
 *
 * @module
 */

import { createRawCommand } from "../machine/command.ts";
import type { CiJobScope } from "../pipeline/scope.ts";
import { countApi, requireJobScope } from "../pipeline/scope.ts";
import type { Duration } from "../types.ts";
import { durationToMs, shellEscape } from "../util.ts";

/**
 * How much longer the command running a wait loop is given than the loop
 * itself, so the loop's own deadline decides and its failure is the one seen.
 */
const waitHeadroomMs = 15_000;

/** The script that polls `url` until it answers with `expected`. */
export const httpWaitScript = (
  url: string,
  expected: number,
  timeoutMs: number,
): string => {
  return waitScript(
    `[ "$(curl -s -o /dev/null -w '%{http_code}' ${shellEscape(url)})" = "${expected}" ]`,
    timeoutMs,
  );
};

const waitScript = (check: string, timeoutMs: number): string => {
  return [
    `deadline=$(( $(date +%s) + ${Math.ceil(timeoutMs / 1000)} ))`,
    "while [ $(date +%s) -lt $deadline ]; do",
    `  if ${check}; then exit 0; fi`,
    "  sleep 1",
    "done",
    "exit 1",
  ].join("\n");
};

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Wait for a URL on the machine to answer, instead of sleeping and hoping.
 *
 * The retry loop runs on the machine rather than from your app, so it's one
 * step however long it takes, and the URL is one the machine can reach,
 * usually `127.0.0.1`.
 *
 * ```ts
 * await $`pnpm start`.background();
 * await waitForHttp("http://127.0.0.1:3000/health");
 * ```
 *
 */
export const waitForHttp = async (
  /** The URL to request, from the machine's point of view. */
  url: string,
  opts: {
    /** How long to keep trying. Defaults to `"2m"`. */
    timeout?: Duration;
    /** The status code to wait for. Defaults to 200. */
    status?: number;
  } = {},
  /** Internal: the machine to run on. `sandbox()` passes its own. */
  scope?: CiJobScope,
): Promise<void> => {
  const target = scope ?? requireJobScope("waitForHttp");

  countApi("waitFor");
  const timeoutMs = durationToMs(opts.timeout ?? "2m");
  const expected = opts.status ?? 200;

  const script = httpWaitScript(url, expected, timeoutMs);

  await createRawCommand(
    () => {
      return target;
    },
    ["/bin/sh", "-c", script],
    { label: `waitForHttp ${url}` },
  ).timeout(`${timeoutMs + waitHeadroomMs}ms`);
};

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Wait for a port on the machine to accept connections.
 *
 * ```ts
 * await $`pnpm start`.background();
 * await waitForPort(3000);
 * ```
 *
 * Note: there are no port events yet, so this is a loop inside the machine
 * rather than a durable wait. It's still one step.
 *
 */
export const waitForPort = async (
  /** The port to connect to on `127.0.0.1`. */
  port: number,
  opts: {
    /** How long to keep trying. Defaults to `"2m"`. */
    timeout?: Duration;
  } = {},
  /** Internal: the machine to run on. `sandbox()` passes its own. */
  scope?: CiJobScope,
): Promise<void> => {
  const target = scope ?? requireJobScope("waitForPort");

  countApi("waitFor");
  const timeoutMs = durationToMs(opts.timeout ?? "2m");

  const script = waitScript(
    `(command -v nc >/dev/null && nc -z 127.0.0.1 ${port}) || (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null`,
    timeoutMs,
  );

  await createRawCommand(
    () => {
      return target;
    },
    ["/bin/sh", "-c", script],
    { label: `waitForPort ${port}` },
  ).timeout(`${timeoutMs + waitHeadroomMs}ms`);
};
