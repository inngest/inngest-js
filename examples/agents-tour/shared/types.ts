/**
 * @module
 * The shapes the tour server and the site agree on.
 */

export interface StartMessage {
  agent: string;
  thread: string;
  text: string;
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
  // Folders in the page's folder holding one file per editable file.
  stub: string;
  solution: string;
}

export interface Manifest {
  // Pages without code (the welcome pages) hide the right side.
  code?: boolean;
  // Files the reader edits, from the page's folder. Default: `agent.ts`.
  editable?: string[];
  // Read-only files shown on the page, found in the module's `_shared`
  // folder, then in the tour-wide one. Default: `setup.ts`.
  readOnly?: string[];
  // The tabs of the play pane, by the id a panel registered with.
  panels?: string[];
  // What Run sends.
  start?: Start[];
  // The message box sends to this agent and thread.
  // `threads` adds one button per thread; the first is the default.
  message?: { agent: string; thread: string; threads?: string[] };
  // The concepts and APIs this page introduces.
  concepts?: string[];
  apis?: string[];
  // Present on an exercise page.
  exercise?: Exercise;
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
}

export interface Page extends PageSummary {
  markdown: string;
  files: PageFile[];
  manifest: Manifest;
}

export interface Module {
  id: string;
  title: string;
  // The opening line shown in Contents.
  opening: string;
  pages: PageSummary[];
}

export interface TourIndex {
  modules: Module[];
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
  | { type: "fakes"; topic: "slack" | "github" }
  // Any area's own topic: the site turns it into a `tour:area` window event.
  | { type: "area"; area: string; topic: string; data?: unknown };
