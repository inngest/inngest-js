/**
 * What the CLI's session tells its renderers: the app's messages, plus the
 * CLI's own progress while it starts the Dev Server and the app. Renderers
 * only ever see these, so the interactive and plain views stay in step.
 *
 * @module
 */

import type { LocalMessage } from "../local/protocol.ts";
import type { Prompter } from "./prompter.ts";

/** A step the CLI takes before the run starts, and on the way out. */
export type SessionStage =
  | "config"
  | "dev-server"
  | "app"
  | "sync"
  | "send"
  | "start"
  | "cleanup";

export type SessionEvent =
  | LocalMessage
  | {
      kind: "stage";
      stage: SessionStage;
      status: "running" | "done" | "failed";
      /** One line to show beside the stage, like a URL or a port. */
      detail?: string;
      at: number;
    }
  | {
      kind: "project";
      /** The absolute directory of the project's `inngest.json`. */
      root: string;
      at: number;
    }
  | {
      kind: "setup-error";
      /** What went wrong, in one sentence. */
      message: string;
      /** What to do about it, such as a config snippet or a command. */
      fix?: string;
      /** The end of the app's or Dev Server's log, when one of them failed. */
      logTail?: string;
      at: number;
    }
  | {
      kind: "ready";
      /** The Dev Server's UI, like `http://127.0.0.1:24288`. */
      devServerUrl: string;
      /** The Dev Server's database, which keeps this session's runs. */
      devServerDir: string;
      /** The working tree the runs use, for the header. */
      repo: { fullName: string; ref: string; sha: string; dirty: boolean };
      at: number;
    }
  | {
      /** What's about to run. Starts a new set of runs, like after `r`. */
      kind: "targets";
      targets: {
        kind: "pipeline" | "job";
        id: string;
        trigger?: string;
      }[];
      at: number;
    }
  | {
      /** Every run the session started has ended, or it couldn't go on. */
      kind: "done";
      conclusion: SessionConclusion;
      at: number;
    };

export type SessionConclusion =
  | "passed"
  | "failed"
  | "cancelled"
  | "setup-error";

/** Draws a session. The interactive and plain views both implement this. */
export interface Renderer {
  handle(event: SessionEvent): void;
  /** Resolves once the final frame is drawn and the terminal is restored. */
  close(): Promise<void>;
}

/** The interactive view, which also takes keys and asks the questions. */
export interface InteractiveRenderer extends Renderer, Prompter {
  /** Called on `q` or Ctrl-C. */
  onQuit(callback: () => void): void;
}
