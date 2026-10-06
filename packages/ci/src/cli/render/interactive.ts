/**
 * The interactive renderer: a live tree redrawn in place on a terminal, with
 * spinners, a highlighted row and a few keys. It also asks the session's
 * questions (the picker, a choice, a line of text) in the same frame, and
 * when everything has run it stays open, with the Dev Server still up, until
 * `q`. It gives the terminal back and leaves a still frame when it closes.
 *
 * @module
 */

import { emitKeypressEvents, type Key } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import type { InteractiveRenderer } from "../events.ts";
import { choiceLines, createChoice, reduceChoice } from "../prompt/choice.ts";
import { createForm, reduceForm } from "../prompt/form.ts";
import { formLines } from "../prompt/formView.ts";
import type { Outcome } from "../prompt/outcome.ts";
import { createPicker, reducePicker } from "../prompt/picker.ts";
import { pickerLines } from "../prompt/pickerView.ts";
import { createText, reduceText, textLines } from "../prompt/text.ts";
import { PromptCancelled } from "../prompter.ts";
import { reviewLines } from "../setup/review.ts";
import {
  createPaint,
  spinnerAt,
  spinnerInterval,
  supportsColor,
} from "./format.ts";
import { initialModel, reduce } from "./model.ts";
import { openUrl } from "./open.ts";
import { frame, headerLines, maxWidth, selectableRunIds } from "./view.ts";

/** The fastest events redraw the screen, so a burst of them draws once. */
const minRedrawInterval = 50;

/** How long a message about a link that wouldn't open stays in the footer. */
const noticeMs = 6000;

const hideCursor = "\x1b[?25l";
const showCursor = "\x1b[?25h";

/** Hold the screen still while a frame is written, in terminals that can. */
const beginUpdate = "\x1b[?2026h";
const endUpdate = "\x1b[?2026l";

/** A question on screen, which takes the keys until it's answered. */
interface Modal {
  /** Replaces the live view under the header, rather than sitting below it. */
  replacesView: boolean;
  lines(size: { width: number; height: number }): string[];
  key(key: Key): void;
}

/** `signal` aborts the questions too, so quitting never waits on an answer. */
export const createInteractiveRenderer = (
  signal: AbortSignal,
): InteractiveRenderer => {
  const { stdin, stdout } = process;
  const paint = createPaint(supportsColor(stdout));
  let model = initialModel;
  let selected = 0;
  let quit = (): void => {};
  let lastDrawAt = 0;
  let previous: string[] = [];
  let previousKey = "";
  let finished: Promise<void> | undefined;
  let modal: Modal | undefined;
  /** Set once everything has run and the view is waiting for `r` or `q`. */
  let waiting: { again: boolean; resolve(again: boolean): void } | undefined;
  let notice: { text: string; until: number } | undefined;

  const hint = (now: number): string | undefined => {
    if (notice && now < notice.until) {
      return notice.text;
    }

    if (waiting) {
      return `↑↓ select · enter open trace · ${waiting.again ? "r pick again · " : ""}q quit`;
    }

    return "↑↓ select · enter open trace · q cancel";
  };

  /** The lines of the current screen. */
  const compose = (now: number, final: boolean): string[] => {
    const columns = stdout.columns ?? 80;
    // One short of the terminal, so a full line never leaves the cursor in
    // the pending-wrap state, where clearing the line eats its last cell.
    const width = columns - 1;
    const rows = Math.max(1, (stdout.rows ?? 24) - 1);
    const live = frame(model, {
      width,
      now,
      spinner: final ? undefined : spinnerAt(now),
      selected: final || modal ? undefined : selected,
      hint: final || modal || model.runs.length === 0 ? undefined : hint(now),
      paint,
    });

    if (!modal) {
      return final ? live : live.slice(-rows);
    }

    if (!modal.replacesView) {
      return [...live, "", ...modal.lines({ width, height: rows })].slice(
        -rows,
      );
    }

    // The picker comes before the next targets, so it doesn't name the last ones.
    const header = headerLines(
      { ...model, targets: undefined },
      Math.min(width, maxWidth),
      paint,
    );

    return [
      ...header,
      "",
      ...modal.lines({
        width: Math.min(width, maxWidth),
        height: rows - header.length - 1,
      }),
    ];
  };

  /** Draw a frame over the last one, or skip it if nothing changed. */
  const draw = (final = false): string => {
    const now = Date.now();
    const columns = stdout.columns ?? 80;
    const visible = compose(now, final);
    const key = `${columns}\n${visible.join("\n")}`;

    lastDrawAt = now;

    if (key === previousKey) {
      return "";
    }

    // After a narrower resize the terminal has re-wrapped what we drew.
    const rows = previous.reduce((total, line) => {
      const width = stripVTControlCharacters(line).length;

      return total + Math.max(1, Math.ceil(width / columns));
    }, 0);
    const up = rows > 0 ? `\x1b[${rows}A` : "";

    previous = visible;
    previousKey = key;

    return [
      beginUpdate,
      up,
      "\r",
      ...visible.map((line) => {
        return `${line}\x1b[K\n`;
      }),
      "\x1b[J",
      endUpdate,
    ].join("");
  };

  const redraw = (): void => {
    stdout.write(draw());
  };

  /** Show a question and resolve with its answer, or reject if it's backed out of. */
  const ask = <S extends { outcome?: Outcome<T> }, T>(opts: {
    state: S;
    reduce(state: S, key: Key): S;
    lines(state: S, size: { width: number; height: number }): string[];
    replacesView?: boolean;
  }): Promise<T> => {
    return new Promise((resolve, reject) => {
      let state = opts.state;

      modal = {
        replacesView: opts.replacesView ?? false,
        lines: (size) => {
          return opts.lines(state, size);
        },
        key: (key) => {
          state = opts.reduce(state, key);

          const { outcome } = state;

          if (!outcome) {
            return;
          }

          modal = undefined;

          if (outcome.kind === "submit") {
            resolve(outcome.value);
          } else {
            reject(new PromptCancelled());
          }
        },
      };

      redraw();
    });
  };

  const stopWaiting = (again: boolean): void => {
    waiting?.resolve(again);
    waiting = undefined;
  };

  const openRun = (url: string): void => {
    void openUrl(url).then((opened) => {
      if (!opened) {
        notice = {
          text: `couldn't open the browser; URL: ${url}`,
          until: Date.now() + noticeMs,
        };
      }
    });
  };

  const onKeypress = (_: string | undefined, key: Key | undefined): void => {
    if (!key) {
      return;
    }

    if (key.ctrl && key.name === "c") {
      quit();

      return;
    }

    if (modal) {
      modal.key(key);
      redraw();

      return;
    }

    if (waiting && key.name === "q") {
      stopWaiting(false);

      return;
    }

    if (waiting?.again && key.name === "r") {
      stopWaiting(true);

      return;
    }

    if (key.name === "q") {
      quit();

      return;
    }

    const runIds = selectableRunIds(model);

    if (key.name === "up") {
      selected = Math.max(0, selected - 1);
    }

    if (key.name === "down") {
      selected = Math.max(0, Math.min(runIds.length - 1, selected + 1));
    }

    if (key.name === "return") {
      const run = model.runs.find((item) => {
        return item.runId === runIds[selected];
      });

      if (run) {
        openRun(run.url);
      }
    }

    redraw();
  };

  /** Safe to call more than once, and from an `exit` handler. */
  const restore = (): void => {
    stdout.write(showCursor);

    if (stdin.isTTY) {
      stdin.setRawMode(false);
    }
  };

  const timer = setInterval(redraw, spinnerInterval);

  signal.addEventListener("abort", () => {
    modal?.key({ ctrl: true, name: "c" });
    stopWaiting(false);
  });

  stdout.write(hideCursor);
  stdout.on("resize", redraw);
  process.on("exit", restore);

  if (stdin.isTTY) {
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.on("keypress", onKeypress);
    stdin.resume();
  }

  const finish = (): Promise<void> => {
    finished ??= new Promise((resolve) => {
      clearInterval(timer);
      stdout.off("resize", redraw);
      stdin.off("keypress", onKeypress);
      process.off("exit", restore);

      if (stdin.isTTY) {
        stdin.pause();
      }

      stdout.write(draw(true));
      restore();
      stdout.write("", () => {
        resolve();
      });
    });

    return finished;
  };

  return {
    handle(event) {
      if (finished) {
        return;
      }

      if (event.kind === "targets") {
        selected = 0;
      }

      model = reduce(model, event);

      if (Date.now() - lastDrawAt >= minRedrawInterval) {
        redraw();
      }
    },

    close() {
      return finish();
    },

    onQuit(callback) {
      quit = callback;
    },

    pick(targets) {
      return ask({
        state: createPicker(targets),
        reduce: reducePicker,
        lines: (state, { width, height }) => {
          return pickerLines(state, { width, height, paint });
        },
        replacesView: true,
      });
    },

    choose(question, options) {
      return ask({
        state: createChoice(question, options),
        reduce: reduceChoice,
        lines: (state, { width }) => {
          return choiceLines(state, { width, paint });
        },
      });
    },

    review(question, options, facts) {
      return ask({
        state: createChoice(question, options),
        reduce: reduceChoice,
        lines: (state, { width }) => {
          return reviewLines(state, facts, { width, paint });
        },
      });
    },

    line(question, check, initial = "") {
      return ask({
        state: { ...createText(question, check), text: initial },
        reduce: reduceText,
        lines: (state, { width }) => {
          return textLines(state, { width, paint });
        },
      });
    },

    form(opts) {
      return ask({
        state: createForm(opts),
        reduce: reduceForm,
        lines: (state, { width, height }) => {
          return formLines(state, { width, height, paint });
        },
        replacesView: true,
      });
    },

    linger(again) {
      return new Promise((resolve) => {
        waiting = { again, resolve };

        redraw();
      });
    },
  };
};
