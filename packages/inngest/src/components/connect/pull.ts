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
import { _internals } from "../execution/engine.ts";
import type { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { prepareConnectionConfig } from "./config.ts";
import { replayRun } from "./pullReplay.ts";
import { writeTestScaffold } from "./pullTest.ts";
import { createReporter, detectOutput } from "./tapOutput.ts";
import type { ConnectApp } from "./types.ts";

type Json = Record<string, unknown>;

export interface PullSettings {
  runId: string;

  /** Stop after this step (its real, unhashed ID). */
  step?: string;

  /** Write a fixture and test scaffold at this path instead of replaying. */
  testPath?: string;
}

export interface RecordedStep {
  id: string;
  hashed: string;
  data?: unknown;
  failed: boolean;
}

export interface RecordedRun {
  runId: string;
  functionSlug: string;
  events: Json[];
  steps: RecordedStep[];
}

export interface StepDiff {
  id: string;

  /**
   * `new` and `failed` steps were not recorded as completed, so replay stops
   * there instead of running them. `fixed` is a recorded failure that now
   * passes; `missing` is a recorded step the new code never reached.
   */
  status:
    | "same"
    | "changed"
    | "fixed"
    | "new"
    | "failed"
    | "missing"
    | "unsupported";
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

/**
 * Repeated step IDs (loops) are hashed by the SDK as `id:1`, `id:2`, ... so
 * count occurrences the same way.
 */
const stepFromSpan = (
  span: TraceSpan,
  seen: Map<string, number>,
): RecordedStep | undefined => {
  if (!span.stepId) {
    return undefined;
  }

  let hashed = span.stepId;
  if (!isHashed(span.stepId)) {
    const count = seen.get(span.stepId) ?? 0;
    seen.set(span.stepId, count + 1);
    hashed = _internals.hashId(
      count > 0 ? `${span.stepId}:${count}` : span.stepId,
    );
  }

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

  const seen = new Map<string, number>();
  const steps = flattenSpans(trace.rootSpan)
    .map((span) => {
      return stepFromSpan(span, seen);
    })
    .filter((step): step is RecordedStep => {
      return step !== undefined;
    });

  if (steps.every((step) => step.data === undefined)) {
    throw new PullDataError(
      `The trace for run ${opts.runId} has no recorded step outputs. The server may not store outputs, or the run has no steps.`,
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

    const app =
      apps.find((candidate) => {
        const fns = (candidate.functions ??
          candidate.client.funcs) as InngestFunction.Any[];

        return fns.some((fn) => {
          return fn.id(candidate.client.id) === recorded.functionSlug;
        });
      }) ?? (apps.length === 1 ? apps[0] : undefined);
    const appName = app?.client.id;
    const handler = appName
      ? prepareConnectionConfig(apps, client).requestHandlers[appName]
      : undefined;
    if (!appName || !handler) {
      throw new PullDataError(
        `No connected app has the function "${recorded.functionSlug}" to replay the run on`,
      );
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
      return diff.status !== "same" && diff.status !== "fixed";
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
