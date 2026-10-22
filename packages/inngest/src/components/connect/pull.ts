/**
 * Live Tap Pull: bring a recorded run to your code, without touching
 * production.
 *
 * Both modes read the same data (the run, its trace with step outputs, and its
 * events) and commit nothing to production:
 *
 * - replay: run the function on the current code with the recorded events and
 *   step results, and print which step results differ from what was recorded.
 * - test: write a fixture and an `@inngest/test` scaffold that mocks the
 *   recorded steps by their real IDs and runs the target step, so the failure
 *   shows up in your normal test runner.
 *
 * Switched on by `INNGEST_TAP_PULL` (set by `inngest tap --pull`). If the
 * server did not keep the outputs, Pull says so and stops; it never invents
 * data.
 *
 * Replay runs every step that was not recorded for real on this machine, with
 * your credentials, so it stops at the first such step. Use test mode when
 * even that is not safe.
 *
 * UNVERIFIED: the shape of the v2 run and trace responses comes from
 * `proto/api/v2/service.proto` (camelCase JSON), not from a live server. A
 * response that does not match fails loudly instead of being guessed at.
 *
 * @module
 */

import { envKeys, headerKeys } from "../../helpers/consts.ts";
import { getProcessEnv, type Mode } from "../../helpers/env.ts";
import { hashSigningKey } from "../../helpers/strings.ts";
import { resolveApiBaseUrl } from "../../helpers/url.ts";
import {
  GatewayExecutorRequestData,
  SDKResponseStatus,
} from "../../proto/src/components/connect/protobuf/connect.ts";
import { _internals } from "../execution/engine.ts";
import type { Inngest } from "../Inngest.ts";
import { prepareConnectionConfig } from "./config.ts";
import type { RequestHandler } from "./strategies/index.ts";
import { createReporter, detectOutput } from "./tap.ts";
import type { ConnectApp } from "./types.ts";

type Json = Record<string, unknown>;

export interface PullSettings {
  runId: string;

  /** Stop after this step (its real, unhashed ID). */
  step?: string;

  /** Write a fixture and test scaffold at this path instead of replaying. */
  testPath?: string;
}

interface RecordedStep {
  id: string;
  hashed: string;
  data?: unknown;
  failed: boolean;
}

interface RecordedRun {
  runId: string;
  functionSlug: string;
  events: Json[];
  steps: RecordedStep[];
}

interface StepDiff {
  id: string;

  /**
   * `new` and `failed` steps were not recorded as completed, so replay stops
   * there instead of running them.
   */
  status: "same" | "changed" | "new" | "failed" | "unsupported";
  recorded?: unknown;
  replayed?: unknown;
}

/** Thrown when the server cannot give Pull what it needs. */
export class PullDataError extends Error {}

export const readPullSettings = (
  env: Record<string, string | undefined> = getProcessEnv(),
): PullSettings | undefined => {
  const runId = env[envKeys.InngestTapPull];
  if (!runId) {
    return undefined;
  }

  return {
    runId,
    step: env[envKeys.InngestTapPullStep] || undefined,
    testPath: env[envKeys.InngestTapPullTest] || undefined,
  };
};

interface TraceSpan {
  name?: string;
  stepId?: string;
  status?: string;
  output?: unknown;
  children?: TraceSpan[];
}

const getJson = async (url: string, headers: Record<string, string>) => {
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new PullDataError(
      `GET ${url} failed (${resp.status}): ${await resp.text()}`,
    );
  }

  return ((await resp.json()) as { data?: unknown }).data;
};

const flattenSpans = (span: TraceSpan): TraceSpan[] => {
  return [span, ...(span.children ?? []).flatMap(flattenSpans)];
};

const isHashed = (id: string) => {
  return /^[0-9a-f]{40}$/.test(id);
};

/** Step outputs may be wrapped as `{ data: value }`. */
const unwrapOutput = (output: unknown): unknown => {
  const keys = Object.keys((output as Json | null) ?? {});

  return keys.length === 1 && keys[0] === "data"
    ? (output as Json).data
    : output;
};

const stepFromSpan = (span: TraceSpan): RecordedStep | undefined => {
  if (!span.stepId) {
    return undefined;
  }

  const hashed = isHashed(span.stepId)
    ? span.stepId
    : _internals.hashId(span.stepId);

  return {
    id: isHashed(span.stepId) && span.name ? span.name : span.stepId,
    hashed,
    data: unwrapOutput(span.output),
    failed: (span.status ?? "").includes("FAIL"),
  };
};

/**
 * Read the run, its step outputs and its events from the API.
 */
export const fetchRecordedRun = async (opts: {
  runId: string;
  apiBaseUrl: string | undefined;
  mode: Mode;
  signingKey: string | undefined;
  env: string | undefined;
}): Promise<RecordedRun> => {
  const base = resolveApiBaseUrl({
    apiBaseUrl: opts.apiBaseUrl,
    mode: opts.mode,
  }).replace(/\/$/, "");
  const v2 = opts.mode === "dev" ? `${base}/api/v2` : `${base}/v2`;
  const headers: Record<string, string> = {
    ...(opts.signingKey
      ? { Authorization: `Bearer ${hashSigningKey(opts.signingKey)}` }
      : {}),
    ...(opts.env ? { [headerKeys.Environment]: opts.env } : {}),
  };

  const run = (await getJson(
    `${v2}/runs/${opts.runId}?include_output=true`,
    headers,
  )) as { function?: { id?: string }; trigger?: { eventIds?: string[] } };
  const trace = (await getJson(
    `${v2}/runs/${opts.runId}/trace?include_output=true`,
    headers,
  )) as { rootSpan?: TraceSpan };

  if (!run?.function?.id || !run.trigger?.eventIds || !trace?.rootSpan) {
    throw new PullDataError(
      `Unexpected API response for run ${opts.runId}: ${JSON.stringify({ run, trace }).slice(0, 300)}`,
    );
  }

  const events = await Promise.all(
    run.trigger.eventIds.map(async (id) => {
      return (await getJson(`${base}/v1/events/${id}`, headers)) as Json;
    }),
  );

  const steps = flattenSpans(trace.rootSpan)
    .map(stepFromSpan)
    .filter((step): step is RecordedStep => {
      return step !== undefined;
    });

  const missing = steps.filter((step) => {
    return step.data === undefined && !step.failed;
  });
  if (steps.length === 0 || missing.length > 0) {
    throw new PullDataError(
      steps.length === 0
        ? `The trace for run ${opts.runId} has no steps with recorded outputs. The server may not store outputs, or the run has none.`
        : `The server returned no output for step(s) ${missing
            .map((step) => {
              return step.id;
            })
            .join(
              ", ",
            )} of run ${opts.runId}. Outputs may be missing or truncated, so Pull cannot reproduce this run.`,
    );
  }

  return {
    runId: opts.runId,
    functionSlug: run.function.id,
    events,
    steps,
  };
};

/**
 * Replay the recorded run on the current code. Each step result is compared to
 * the recorded one, then the recorded one is fed forward so a difference does
 * not cascade into later steps. Stops at the first step that was not recorded
 * as completed, without running it again.
 */
export const replayRun = async (opts: {
  recorded: RecordedRun;
  handler: RequestHandler;
  appName: string;
  functionSlug: string;
  stopAfter?: string;
}): Promise<StepDiff[]> => {
  const { recorded } = opts;
  const byHash = new Map(
    recorded.steps.map((step) => {
      return [step.hashed, step];
    }),
  );
  const memo: Record<string, { data: unknown }> = {};
  const stack: string[] = [];
  const diffs: StepDiff[] = [];
  const queue: Array<string | undefined> = [undefined];
  let requests = 0;

  const request = (stepId: string | undefined) => {
    requests += 1;

    return GatewayExecutorRequestData.create({
      requestId: `pull-${requests}`,
      appName: opts.appName,
      functionSlug: opts.functionSlug,
      stepId,
      runId: recorded.runId,
      leaseId: "pull",
      requestPayload: new TextEncoder().encode(
        JSON.stringify({
          event: recorded.events[0] ?? {},
          events: recorded.events,
          steps: memo,
          ctx: {
            run_id: recorded.runId,
            attempt: 0,
            stack: { stack, current: stack.length - 1 },
          },
          version: 1,
        }),
      ),
    });
  };

  while (queue.length > 0) {
    const response = await opts.handler(request(queue.shift()));

    if (response.status !== SDKResponseStatus.NOT_COMPLETED) {
      break;
    }

    const ops = JSON.parse(new TextDecoder().decode(response.body)) as Json[];
    for (const op of ops) {
      const id = String(op.id);
      const rec = byHash.get(id);

      if (op.op === "StepPlanned") {
        queue.push(id);
        continue;
      }

      const replayed = op.op === "StepRun" ? op.data : (op.error ?? op.op);
      const status = !rec
        ? "new"
        : rec.failed
          ? "failed"
          : op.op !== "StepRun"
            ? "unsupported"
            : JSON.stringify(replayed) === JSON.stringify(rec.data)
              ? "same"
              : "changed";
      diffs.push({
        id: rec?.id ?? String(op.displayName ?? op.name ?? id),
        status,
        recorded: rec?.data,
        replayed,
      });

      if (!rec || rec.failed) {
        return diffs;
      }

      memo[id] = { data: rec.data ?? null };
      stack.push(id);

      if (opts.stopAfter === rec.id) {
        return diffs;
      }
    }

    if (queue.length === 0 && ops.length > 0) {
      queue.push(undefined);
    }
  }

  return diffs;
};

/**
 * Write a JSON fixture and an `@inngest/test` scaffold. The test mocks every
 * recorded step except the target by its real ID, and runs the target on your
 * code with the production event.
 */
export const writeTestScaffold = async (opts: {
  recorded: RecordedRun;
  testPath: string;
  step?: string;
}): Promise<{ fixturePath: string; target: string }> => {
  const { recorded } = opts;
  const targetStep =
    recorded.steps.find((step) => {
      return step.id === opts.step;
    }) ??
    recorded.steps.find((step) => {
      return step.failed;
    }) ??
    recorded.steps[recorded.steps.length - 1];
  const target = targetStep?.id ?? "";
  const fixturePath = `${opts.testPath.replace(/\.[cm]?[jt]sx?$/, "")}.fixture.json`;
  const fixtureFile = fixturePath.split(/[\\/]/).pop();

  const fixture = {
    runId: recorded.runId,
    function: recorded.functionSlug,
    target,
    events: recorded.events,
    steps: recorded.steps.map((step) => {
      return { id: step.id, data: step.data, failed: step.failed };
    }),
  };

  const test = `import { InngestTestEngine } from "@inngest/test";
import { describe, expect, it } from "vitest";
import fixture from "./${fixtureFile}";
// Edit this import: point it at the function with id "${recorded.functionSlug}".
// Importing JSON needs "resolveJsonModule" in your tsconfig.
import { fn } from "./path-to-your-function";

describe("run ${recorded.runId}", () => {
  it("${target} with production inputs", async () => {
    const t = new InngestTestEngine({ function: fn });

    const { result } = await t.executeStep(fixture.target, {
      events: fixture.events,
      steps: fixture.steps
        .filter((step) => {
          return step.id !== fixture.target && !step.failed;
        })
        .map((step) => {
          return {
            id: step.id,
            handler() {
              return step.data;
            },
          };
        }),
    });

    expect(result).not.toHaveProperty("error");

    // Pin the behaviour you want. Production recorded this for the target:
    // expect(result).toEqual(${JSON.stringify(targetStep?.data) ?? "undefined"});
  });
});
`;

  const { writeFile } = await import("node:fs/promises");
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  await writeFile(opts.testPath, test);

  return { fixturePath, target };
};

/**
 * Run Pull for the configured apps (the first app's client talks to the API).
 * Sets a non-zero exit code when a replay differs from the recording.
 */
export const runPull = async (
  settings: PullSettings,
  apps: ConnectApp[],
  client: Inngest.Any,
): Promise<void> => {
  const output = detectOutput(getProcessEnv());
  const reporter = createReporter(output);

  reporter.guide();

  try {
    const recorded = await fetchRecordedRun({
      runId: settings.runId,
      apiBaseUrl: client.apiBaseUrl,
      mode: client["mode"],
      signingKey: client.signingKey,
      env: client.env ?? undefined,
    });

    if (settings.testPath) {
      const { fixturePath, target } = await writeTestScaffold({
        recorded,
        testPath: settings.testPath,
        step: settings.step,
      });
      reporter.emit(
        "scaffold",
        `pull: wrote ${settings.testPath} and ${fixturePath} (target step: ${target})\npull: the fixture is production data. Review or redact it before committing.`,
        { test: settings.testPath, fixture: fixturePath, target },
      );

      return;
    }

    const { requestHandlers } = prepareConnectionConfig(apps, client);
    const appName = client.id;
    const handler = requestHandlers[appName];
    if (!handler) {
      throw new PullDataError(`No app "${appName}" to replay the run on`);
    }

    const diffs = await replayRun({
      recorded,
      handler,
      appName,
      functionSlug: recorded.functionSlug,
      stopAfter: settings.step,
    });

    for (const diff of diffs) {
      reporter.emit(
        "step",
        `pull ${diff.status.padEnd(11)} ${diff.id}${
          diff.status === "changed"
            ? `\n  recorded: ${JSON.stringify(diff.recorded)}\n  replayed: ${JSON.stringify(diff.replayed)}`
            : ""
        }`,
        { ...diff },
      );
    }

    const changed = diffs.filter((diff) => {
      return diff.status !== "same";
    }).length;
    reporter.emit(
      "done",
      `pull: ${changed} of ${diffs.length} steps differ from the recording`,
      { changed, total: diffs.length },
    );
    process.exitCode = changed > 0 ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reporter.emit("error", `pull: ${message}`, { message });
    process.exitCode = 2;
  }
};
