/**
 * @module
 * The moments the tour sounds, and how a change in the runs makes them: a
 * run finishing or failing, an agent finishing, a message arriving and a tool
 * being called. Plain functions, so they are tested without a browser.
 */
import type { TraceRun, TraceStep } from "../../../shared/types.ts";

export type Moment =
  | "run"
  | "runDone"
  | "runFail"
  | "checkPass"
  | "checkFail"
  | "next"
  | "prev"
  | "moduleDone"
  | "message"
  | "tool"
  | "reply"
  | "agentDone"
  | "enable"
  | "disable";

export const allMoments: readonly Moment[] = [
  "run",
  "runDone",
  "runFail",
  "checkPass",
  "checkFail",
  "next",
  "prev",
  "moduleDone",
  "message",
  "tool",
  "reply",
  "agentDone",
  "enable",
  "disable",
];

export const isMoment = (name: string): name is Moment => {
  return (allMoments as readonly string[]).includes(name);
};

const finished = new Set(["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"]);

const toolIds = (steps: TraceStep[]): string[] => {
  return steps.flatMap((step) => {
    return [
      ...(/^tool\b/i.test(step.name) ? [step.id] : []),
      ...toolIds(step.children),
    ];
  });
};

/**
 * The moments between two snapshots of the runs. `before` is null on the
 * first snapshot, which only records what is already there.
 */
export const momentsOf = (
  before: TraceRun[] | null,
  after: TraceRun[],
): Moment[] => {
  if (before === null) {
    return [];
  }

  const out: Moment[] = [];

  for (const run of after) {
    const old = before.find((entry) => {
      return entry.id === run.id;
    });
    const fromMessage = run.trigger?.name === "agent/message";

    if (!old) {
      if (run.trigger) {
        out.push("message");
      }
    }

    const seen = new Set(toolIds(old?.steps ?? []));

    for (const id of toolIds(run.steps)) {
      if (!seen.has(id)) {
        out.push("tool");
      }
    }

    const wasDone = old ? finished.has(old.status) : false;

    if (finished.has(run.status) && !wasDone && old) {
      if (run.status === "FAILED") {
        out.push("runFail");
      } else if (run.status === "COMPLETED") {
        out.push(fromMessage ? "agentDone" : "runDone");
      }
    }
  }

  return out;
};
