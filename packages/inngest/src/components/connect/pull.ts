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
 * Replay runs every step for real on this machine, with your credentials, to
 * produce the replayed results. Use test mode when that is not safe.
 *
 * The shape of the v2 run and trace responses was checked against a Dev Server:
 * camelCase, step outputs are the raw values (no wrapper), step IDs are the
 * hashed ones with the real name in `name`, and retries show up as extra spans
 * of the same step. A response that does not match fails loudly instead of
 * being guessed at.
 *
 * @module
 */

import { envKeys, headerKeys } from "../../helpers/consts.ts";
import { getProcessEnv, type Mode } from "../../helpers/env.ts";
import { hashSigningKey } from "../../helpers/strings.ts";
import { resolveApiBaseUrl } from "../../helpers/url.ts";
import type { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { prepareConnectionConfig } from "./config.ts";
import { replayRun } from "./pullReplay.ts";
import { writeTestScaffold } from "./pullTest.ts";
import { readTapSettings } from "./tap.ts";
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

  /** The function ID as the API reports it, without the app prefix. */
  functionSlug: string;
  appId?: string;
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
    throw new Error(`GET ${url} failed (${resp.status}): ${await resp.text()}`);
  }

  return ((await resp.json()) as { data?: unknown }).data;
};

const flattenSpans = (span: TraceSpan): TraceSpan[] => {
  return [span, ...(span.children ?? []).flatMap(flattenSpans)];
};

/** Retries are child spans named "Attempt 0", "Attempt 1" of the step span. */
const isAttempt = (span: TraceSpan) => {
  return /^Attempt \d+$/.test(span.name ?? "");
};

/**
 * One recorded step per hashed step ID. The trace repeats a step once per
 * request and nests its retries, so spans are grouped: a step that ever
 * completed is recorded with that output, otherwise with its last (failed)
 * output.
 */
const recordedSteps = (root: TraceSpan): RecordedStep[] => {
  const groups = new Map<string, TraceSpan[]>();

  for (const span of flattenSpans(root)) {
    if (span.stepId && !isAttempt(span)) {
      groups.set(span.stepId, [...(groups.get(span.stepId) ?? []), span]);
    }
  }

  const settled = [...groups].filter(([, spans]) => {
    return spans.some((span) => {
      return (
        span.status === "COMPLETED" || (span.status ?? "").includes("FAIL")
      );
    });
  });

  return settled.map(([hashed, spans]) => {
    const done = spans.find((span) => {
      return span.status === "COMPLETED";
    });
    const last = done ?? spans[spans.length - 1];

    return {
      id: spans[0]?.name ?? hashed,
      hashed,
      data: last?.output,
      failed: !done && (last?.status ?? "").includes("FAIL"),
    };
  });
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
  )) as {
    app?: { id?: string };
    function?: { id?: string };
    trigger?: { eventIds?: string[] };
  };
  const trace = (await getJson(
    `${v2}/runs/${opts.runId}/trace?include_output=true`,
    headers,
  )) as { rootSpan?: TraceSpan };

  if (!run?.function?.id || !run.trigger?.eventIds || !trace?.rootSpan) {
    throw new Error(
      `Unexpected API response for run ${opts.runId}: ${JSON.stringify({ run, trace }).slice(0, 300)}`,
    );
  }

  const events = await Promise.all(
    run.trigger.eventIds.map(async (id) => {
      return (await getJson(`${base}/v1/events/${id}`, headers)) as Json;
    }),
  );

  const steps = recordedSteps(trace.rootSpan);

  const completed = steps.filter((step) => {
    return !step.failed;
  });
  if (
    completed.length > 0 &&
    completed.every((step) => {
      return step.data === undefined;
    })
  ) {
    throw new Error(
      `The trace for run ${opts.runId} has no recorded step outputs. The server may not store outputs, or the run has no steps.`,
    );
  }

  return {
    runId: opts.runId,
    functionSlug: run.function.id,
    appId: run.app?.id,
    events,
    steps,
  };
};

/**
 * The app and function slug that the recorded run belongs to. The API reports
 * the function without its app prefix and the app separately.
 */
const findFunction = (
  apps: ConnectApp[],
  recorded: RecordedRun,
): { appName: string; functionSlug: string } | undefined => {
  for (const app of apps) {
    const fns = (app.functions ?? app.client.funcs) as InngestFunction.Any[];
    const fn = fns.find((candidate) => {
      const slug = candidate.id(app.client.id);

      return (
        slug === recorded.functionSlug ||
        (candidate.id() === recorded.functionSlug &&
          (!recorded.appId || recorded.appId === app.client.id))
      );
    });

    if (fn) {
      return { appName: app.client.id, functionSlug: fn.id(app.client.id) };
    }
  }

  return undefined;
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
    if (readTapSettings()) {
      throw new Error("Pull and tap mode cannot be combined");
    }

    const recorded = await fetchRecordedRun({
      runId: settings.runId,
      apiBaseUrl: client.apiBaseUrl,
      mode: client["mode"],
      signingKey: client.signingKey,
      env: client.env ?? undefined,
    });

    if (
      settings.step &&
      !recorded.steps.some((step) => {
        return step.id === settings.step;
      })
    ) {
      throw new Error(`Step "${settings.step}" is not in the recorded run`);
    }

    if (settings.testPath) {
      if (recorded.steps.length === 0) {
        throw new Error("The run has no steps to build a test from");
      }

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

    const match = findFunction(apps, recorded);
    const handler = match
      ? prepareConnectionConfig(apps, client).requestHandlers[match.appName]
      : undefined;
    if (!match || !handler) {
      throw new Error(
        `No connected app has the function "${recorded.functionSlug}" to replay the run on`,
      );
    }

    const diffs = await replayRun({
      recorded,
      handler,
      appName: match.appName,
      functionSlug: match.functionSlug,
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

    // A run that stopped at a failure never reached the steps after it, so
    // those are expected to be new once the failure is fixed.
    const stoppedAtFailure = recorded.steps.some((step) => {
      return step.failed;
    });
    const changed = diffs.filter((diff) => {
      return (
        diff.status !== "same" &&
        diff.status !== "fixed" &&
        !(diff.status === "new" && stoppedAtFailure)
      );
    }).length;
    reporter.emit(
      "done",
      `pull: ${changed} of ${diffs.length} steps need a look`,
      { changed, total: diffs.length },
    );
    process.exitCode = changed > 0 ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reporter.emit("error", `pull: ${message}`, { message });
    process.exitCode = 2;
  }
};
