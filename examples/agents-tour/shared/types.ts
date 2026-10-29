/**
 * @module
 * The shapes the tour server and the site agree on.
 */

export interface StartMessage {
  agent: string;
  thread: string;
  message: string;
}

export interface StartEvent {
  event: { name: string; data: Record<string, unknown> };
}

// A message typed in the fake Slack, as the person would.
export interface StartSlack {
  slack: { channel: string; text: string };
}

export type Start = StartMessage | StartEvent | StartSlack;

export interface Manifest {
  // Pages without code (the welcome pages) hide the right side.
  code?: boolean;
  // The tabs of the play pane: `message`, and later `slack`, `github`, `events`.
  panels?: string[];
  start?: Start[];
  // The message box sends to this agent and thread.
  message?: { agent: string; thread: string };
}

export interface PageFile {
  name: string;
  content: string;
  editable: boolean;
}

export interface PageSummary {
  id: string;
  number: number;
  lesson: string;
  lessonTitle: string;
  title: string;
}

export interface Page extends PageSummary {
  markdown: string;
  files: PageFile[];
  manifest: Manifest;
}

export interface Lesson {
  id: string;
  title: string;
  blurb: string;
  pages: PageSummary[];
}

export interface TourIndex {
  lessons: Lesson[];
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
  // The event that started the run: the inbox's first message.
  trigger: { name: string; data: Record<string, unknown> } | null;
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
  | { type: "fakes"; topic: "slack" | "github" };
