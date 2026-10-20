/**
 * The live view of a run: a tree of its jobs redrawn in place with
 * `log-update` while a terminal is attached, one plain line per event
 * otherwise. What the tree looks like is `liveFrame.ts`.
 *
 * @module
 */

import { createLogUpdate } from "log-update";

import type { LocalMessage } from "../local/protocol.ts";
import {
  apply,
  createState,
  formatDuration,
  frame,
  isOpen,
  type LiveState,
} from "./liveFrame.ts";

const redrawMs = 100;

export interface LiveView {
  /** Show what the run is doing. Messages are those of the one run shown. */
  handle(message: LocalMessage): void;

  /** Say what is happening before any job reports. */
  status(text: string): void;

  /** Name the run being watched. */
  start(name: string): void;

  /** Say where to open the run. */
  link(url: string): void;

  /** Note why the run failed, for the summary. */
  fail(reason: string): void;

  /** Stop drawing. With a conclusion, leave the final tree and summary. */
  stop(conclusion?: NonNullable<LiveState["conclusion"]>["status"]): void;
}

export const createLiveView = (): LiveView => {
  const out = process.stdout;
  const tty = Boolean(out.isTTY);
  const color = tty && !process.env.NO_COLOR;
  const state = createState(Date.now());
  const draw = createLogUpdate(out, { showCursor: false });
  let timer: NodeJS.Timeout | undefined;
  let tick = 0;
  let reason: string | undefined;

  const render = (): void => {
    tick += 1;

    draw(
      frame(state, {
        now: Date.now(),
        width: out.columns ?? 80,
        tick,
        color,
      }).join("\n"),
    );
  };

  /** Redraw now, and keep redrawing so spinners and timers move. */
  const show = (): void => {
    if (!tty) {
      return;
    }

    render();

    timer ??= setInterval(render, redrawMs);
  };

  const plain = (message: LocalMessage): void => {
    const job = state.jobs.find((candidate) => {
      return "jobId" in message && candidate.id === message.jobId;
    });

    if (message.kind === "job" && message.status !== job?.status) {
      const took = isOpen(message.status)
        ? ""
        : ` (${formatDuration(message.at - (job?.startedAt ?? message.at))})`;

      console.log(
        `${message.jobId}: ${message.status}${took}${message.title ? ` - ${message.title}` : ""}`,
      );
    }

    if (message.kind === "command" && message.status !== "passed") {
      console.log(
        `${message.jobId}: $ ${message.name}${message.status === "failed" ? ` exited with ${message.exitCode}` : ""}`,
      );

      if (message.status === "failed" && message.outputTail) {
        console.log(message.outputTail.replace(/^/gm, "    "));
      }
    }

    if (message.kind === "warning") {
      console.log(`warning: ${message.text}`);
    }
  };

  return {
    handle: (message) => {
      if (!tty) {
        plain(message);
      }

      apply(state, message);

      show();
    },
    status: (text) => {
      if (state.conclusion) {
        return;
      }

      state.status = text;

      if (tty) {
        show();
      } else {
        console.log(text);
      }
    },
    start: (name) => {
      state.name = name;
    },
    link: (url) => {
      state.url = url;

      if (!tty) {
        console.log(`Run: ${url}`);
      }

      show();
    },
    fail: (text) => {
      reason = text;
    },
    stop: (conclusion) => {
      clearInterval(timer);

      timer = undefined;

      if (!conclusion) {
        draw.clear();

        return;
      }

      state.endedAt = Date.now();
      state.conclusion = { status: conclusion, reason };

      if (tty) {
        render();

        draw.done();
      } else {
        console.log(
          `${state.name ?? "run"} ${conclusion} in ${formatDuration(state.endedAt - state.startedAt)}${reason ? `: ${reason}` : ""}`,
        );
      }
    },
  };
};
