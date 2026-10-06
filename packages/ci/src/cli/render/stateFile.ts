/**
 * The state-file renderer: publishes the session as a JSON file that editor
 * integrations read to show every running `inngest-ci` session. It builds the
 * file from the same model the other renderers draw. The shape and the rules
 * for writing it are a contract with those readers, version 1.
 *
 * @module
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { LocalStatus } from "../../local/protocol.ts";
import type { Renderer, SessionConclusion, SessionEvent } from "../events.ts";
import { displayActivity, initialModel, type Model, reduce } from "./model.ts";

/** The most often the file is written. */
const throttleMs = 250;

/** How often an idle session touches its file, so readers see it's alive. */
const heartbeatMs = 15_000;

export interface SessionState {
  v: 1;
  sessionId: string;
  pid: number;
  startedAt: number;
  updatedAt: number;
  /** When the runs finished. The Dev Server may stay up after this. */
  endedAt?: number;
  /** When the CLI exited: the Dev Server is down and run URLs no longer work. */
  closedAt?: number;
  startedBy: { kind: "claude"; sessionId?: string } | { kind: "user" };
  project: { root: string; name: string };
  repo?: { fullName: string; ref: string; sha: string; dirty: boolean };
  target?: { kind: "pipeline" | "job"; id: string; trigger?: string };
  devServerUrl?: string;
  /** The Dev Server's database, for `inngest-ci open`. */
  devServerDir?: string;
  conclusion: SessionConclusion | "running";
  setupError?: string;
  runs: {
    runId: string;
    pipelineId: string;
    url: string;
    status: LocalStatus;
    /** Why the run failed or was skipped, when it says. */
    reason?: string;
    startedAt: number;
    endedAt?: number;
    jobs: {
      id: string;
      status: LocalStatus;
      parentId?: string;
      startedAt: number;
      endedAt?: number;
      command?: { name: string; attempt: number; status: string };
      /** What the job is doing while no command runs, like `creating machine…`. */
      activity?: string;
      title?: string;
    }[];
  }[];
}

/** Who launched the CLI: Claude Code sets these in the shell it runs. */
export const describeStarter = (
  env: NodeJS.ProcessEnv,
): SessionState["startedBy"] => {
  const sessionId = env.CLAUDE_CODE_SESSION_ID;

  if (sessionId) {
    return { kind: "claude", sessionId };
  }

  return env.CLAUDECODE ? { kind: "claude" } : { kind: "user" };
};

/** Who and where the session is, which no event says. */
export interface SessionMeta {
  sessionId: string;
  pid: number;
  startedBy: SessionState["startedBy"];
  /** The project root until the session finds the real one. */
  cwd: string;
}

/**
 * What the file calls the target: with several, their IDs joined, so a reader
 * that only knows one target still has something to show.
 */
const targetOf = (model: Model): SessionState["target"] => {
  const targets = model.targets?.targets ?? [];
  const [first] = targets;

  if (!first) {
    return undefined;
  }

  return {
    kind: first.kind,
    id: targets
      .map((target) => {
        return target.id;
      })
      .join(", "),
    trigger: targets.length === 1 ? first.trigger : undefined,
  };
};

/** Map the model to the file's shape. */
export const toSessionState = (
  model: Model,
  meta: SessionMeta,
  now: number,
): SessionState => {
  const root = model.projectRoot ?? meta.cwd;

  return {
    v: 1,
    sessionId: meta.sessionId,
    pid: meta.pid,
    startedAt: model.startedAt ?? now,
    updatedAt: now,
    endedAt: model.endedAt,
    startedBy: meta.startedBy,
    project: { root, name: basename(root) },
    repo: model.header?.repo,
    target: targetOf(model),
    devServerUrl: model.header?.devServerUrl,
    devServerDir: model.header?.devServerDir,
    conclusion: model.conclusion ?? "running",
    setupError: model.setupError?.message,
    runs: model.runs.map((run) => {
      return {
        runId: run.runId,
        pipelineId: run.name,
        url: run.url,
        status: run.status,
        reason: run.reason,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        jobs: run.jobs.map((job) => {
          const command = job.commands.at(-1);

          return {
            id: job.jobId,
            status: job.status,
            parentId: job.parentId,
            startedAt: job.startedAt,
            endedAt: job.endedAt,
            command: command && {
              name: command.name,
              attempt: command.attempt,
              status: command.status,
            },
            activity: displayActivity(run, job),
            title: job.title,
          };
        }),
      };
    }),
  };
};

/** Write through a temporary file so a reader never sees half of one. */
export const writeFileAtomic = async (
  file: string,
  content: string,
): Promise<void> => {
  const temporary = `${file}.tmp`;

  await mkdir(dirname(file), { recursive: true });
  await writeFile(temporary, content);
  await rename(temporary, file);
};

export interface StateFileOptions extends SessionMeta {
  /** The file to keep up to date, `<state dir>/sessions/<sessionId>.json`. */
  file: string;
  /** Replaces the atomic write, for tests. */
  write?: (file: string, content: string) => Promise<void>;
}

/**
 * Keep `file` current with the session. Writes at most once per 250ms with a
 * trailing write, so the last state always lands, and every 15s when idle.
 * A failed write is dropped: the file is a convenience, never a reason to
 * fail a run. `close()` waits for the final write.
 */
export const createStateFileRenderer = (opts: StateFileOptions): Renderer => {
  const { file, write = writeFileAtomic } = opts;
  let model = initialModel;
  let lastWrite = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();

  const flush = (closedAt?: number) => {
    timer = undefined;
    lastWrite = Date.now();

    const content = JSON.stringify({
      ...toSessionState(model, opts, lastWrite),
      closedAt,
    });

    pending = pending.then(() => {
      return write(file, content).catch(() => {
        return undefined;
      });
    });
  };

  const schedule = () => {
    if (timer) {
      return;
    }

    timer = setTimeout(flush, Math.max(0, lastWrite + throttleMs - Date.now()));
  };

  const heartbeat = setInterval(schedule, heartbeatMs);

  heartbeat.unref();
  schedule();

  return {
    handle: (event: SessionEvent) => {
      model = reduce(model, event);

      schedule();
    },

    close: async () => {
      clearInterval(heartbeat);
      clearTimeout(timer);
      flush(Date.now());

      await pending;
    },
  };
};

/** The file for a session inside the state directory. */
export const sessionFile = (dir: string, sessionId: string): string => {
  return join(dir, "sessions", `${sessionId}.json`);
};
