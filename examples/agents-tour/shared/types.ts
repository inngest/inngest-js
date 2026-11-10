/**
 * @module
 * The shapes the tour server and the site agree on.
 */

// Run starts the agent with `agent.start(content, { thread })`, through the
// host's `tour-start` function, so the run ends after its answer. `agent` is
// the agent's id.
export interface StartMessage {
  agent: string;
  thread: string;
  content: string;
}

export interface StartEvent {
  event: { name: string; data: Record<string, unknown> };
}

// A message typed in the fake Slack, as the person would.
export interface StartSlack {
  slack: { channel: string; text: string };
}

export type Start = StartMessage | StartEvent | StartSlack;

export interface Exercise {
  // The check script in the page's folder.
  check: string;
  // One line shown on request, nudging without giving the answer away.
  hint?: string;
  // Folders in the page's folder holding one file per editable file.
  stub: string;
  solution: string;
}

// A run `tour:verify` expects to see after the page's action.
export interface ExpectedRun {
  // The function's name: the agent's id.
  fn: string;
  // Default: any status but FAILED or CANCELLED.
  status?: string;
  // Compared to what the run returned, when given.
  output?: unknown;
}

// What `tour:verify` does on a page, beyond running its starting code.
export interface Verify {
  // More of the page's promised action, done after Run's start entries.
  then?: Start[];
  // The runs that must exist once the action has settled.
  runs?: ExpectedRun[];
  // What the scripted model says, one step per turn (`say` or `call`).
  model?: unknown[];
}

export interface Manifest {
  // Pages without code (the welcome pages) hide the right side.
  code?: boolean;
  // Files the reader edits, from the page's folder. Default: `agent.ts`.
  editable?: string[];
  // Read-only files shown on the page, found in the page's folder, then the
  // module's `_shared` folder, then the tour-wide one. Default: `setup.ts`.
  // A page whose files include `run.ts` runs that file on Run.
  readOnly?: string[];
  // The tabs of the play pane, by the id a panel registered with.
  panels?: string[];
  // What Run sends, after `run.ts` if the page has one.
  start?: Start[];
  // The chat sends what the reader types to this agent and thread.
  // `threads` adds a thread switcher; the first is the default. `prompts`
  // are things the page suggests asking, shown as buttons under the box.
  chat?: {
    agent: string;
    thread: string;
    threads?: string[];
    prompts?: string[];
  };
  // The concepts and APIs this page introduces.
  concepts?: string[];
  apis?: string[];
  // Present on an exercise page.
  exercise?: Exercise;
  // What `tour:verify` checks. Without it a page must start, and none of its
  // runs may fail.
  verify?: Verify;
}

export interface PageFile {
  name: string;
  content: string;
  editable: boolean;
}

export interface PageSummary {
  id: string;
  // `3` for a core page, `3a` for a Go deeper page (from the folder name).
  label: string;
  kind: "core" | "deeper";
  module: string;
  moduleTitle: string;
  title: string;
  // The module's exercise, which ends its core path.
  exercise: boolean;
}

export interface Page extends PageSummary {
  markdown: string;
  files: PageFile[];
  manifest: Manifest;
}

export interface Module {
  id: string;
  title: string;
  // The opening line shown under the module's title in the left nav.
  opening: string;
  pages: PageSummary[];
}

export interface TourIndex {
  modules: Module[];
}

export type PageState = "opened" | "ran" | "passed";

export interface ProgressSnapshot {
  pages: Record<string, Partial<Record<PageState, boolean>>>;
  // Collected concepts: the page that taught each, and its definition.
  concepts: Record<string, { page: string; definition: string }>;
  totalConcepts: number;
}

export interface ProgressMark {
  // Concepts this mark collected for the first time.
  collected: string[];
  // The module whose exercise this mark passed.
  moduleDone: string | null;
}

export interface TraceStep {
  id: string;
  name: string;
  op: string | null;
  status: string;
  attempts: number | null;
  duration: number | null;
  startedAt: string | null;
  endedAt: string | null;
  outputID: string | null;
  userland: boolean;
  // The span's step type and, for a group span, its kind.
  type: string | null;
  group: string | null;
  children: TraceStep[];
}

export interface TraceRun {
  id: string;
  fn: string;
  status: string;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  // The ID of the run's output, read with /api/output.
  output: string | null;
  // The event that started the run, as it arrived: the inbox's first message.
  trigger: {
    id: string;
    name: string;
    data: Record<string, unknown>;
    ts: number;
    seq: number;
  } | null;
  steps: TraceStep[];
}

export type TourEvent =
  | {
      type: "log";
      kind: "info" | "out" | "err";
      text: string;
    }
  | { type: "clear" }
  | {
      type: "status";
      state: "idle" | "starting" | "live" | "failed";
      text: string;
    }
  | { type: "runs"; runs: TraceRun[] }
  // What `tour-start` did with the page's `run.ts` (or an app that did not
  // start): it finished, or failed with this.
  | { type: "run-result"; ok: true }
  | ({ type: "run-result"; ok: false } & RunFailure)
  | { type: "fakes"; topic: "slack" | "github" }
  | { type: "progress"; mark: ProgressMark; page: string }
  // Any area's own topic: the site turns it into a `tour:area` window event.
  | { type: "area"; area: string; topic: string; data?: unknown };

// What Check answers. A failure carries one sentence saying why; `broken`
// marks a check script that threw instead of judging.
export type CheckResult =
  | { pass: true }
  | { pass: false; reason: string; broken?: boolean };

// Why a Run did not produce a run: the headline is plain English with the
// real names in backticks; `file` and `line` say where, when known.
export interface RunFailure {
  headline: string;
  detail?: string;
  file?: string;
  line?: number;
  column?: number;
  length?: number;
}
