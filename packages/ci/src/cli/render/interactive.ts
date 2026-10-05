/**
 * The interactive renderer: a live tree redrawn in place on a terminal, with
 * spinners, a highlighted row and a few keys. When the session is done it
 * leaves a still frame behind and gives the terminal back.
 *
 * @module
 */

import { emitKeypressEvents, type Key } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import type { InteractiveRenderer } from "../events.ts";
import {
  createPaint,
  spinnerAt,
  spinnerInterval,
  supportsColor,
} from "./format.ts";
import { initialModel, reduce } from "./model.ts";
import { openUrl } from "./open.ts";
import { frame, selectableRunIds } from "./view.ts";

/** The fastest events redraw the screen, so a burst of them draws once. */
const minRedrawInterval = 50;

const hint = "↑↓ select · enter open trace · q quit";

const hideCursor = "\x1b[?25l";
const showCursor = "\x1b[?25h";

/** Hold the screen still while a frame is written, in terminals that can. */
const beginUpdate = "\x1b[?2026h";
const endUpdate = "\x1b[?2026l";

export const createInteractiveRenderer = (): InteractiveRenderer => {
  const { stdin, stdout } = process;
  const paint = createPaint(supportsColor(stdout));
  let model = initialModel;
  let selected = 0;
  let quit = (): void => {};
  let lastDrawAt = 0;
  let previous: string[] = [];
  let previousKey = "";
  let finished: Promise<void> | undefined;

  /** Draw a frame over the last one, or skip it if nothing changed. */
  const draw = (final = false): string => {
    const now = Date.now();
    const columns = stdout.columns ?? 80;
    const lines = frame(model, {
      // One short of the terminal, so a full line never leaves the cursor in
      // the pending-wrap state, where clearing the line eats its last cell.
      width: columns - 1,
      now,
      spinner: final ? undefined : spinnerAt(now),
      selected: final ? undefined : selected,
      hint: final ? undefined : hint,
      paint,
    });
    const visible = final
      ? lines
      : lines.slice(-Math.max(1, (stdout.rows ?? 24) - 1));
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

  const onKeypress = (_: string | undefined, key: Key | undefined): void => {
    if (key?.name === "q" || (key?.ctrl && key.name === "c")) {
      quit();

      return;
    }

    const runIds = selectableRunIds(model);

    if (key?.name === "up") {
      selected = Math.max(0, selected - 1);
    }

    if (key?.name === "down") {
      selected = Math.max(0, Math.min(runIds.length - 1, selected + 1));
    }

    if (key?.name === "return") {
      const run = model.runs.find((item) => {
        return item.runId === runIds[selected];
      });

      if (run) {
        openUrl(run.url);
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

      model = reduce(model, event);

      if (event.kind === "done") {
        void finish();
      } else if (Date.now() - lastDrawAt >= minRedrawInterval) {
        redraw();
      }
    },

    close() {
      return finish();
    },

    onQuit(callback) {
      quit = callback;
    },
  };
};
