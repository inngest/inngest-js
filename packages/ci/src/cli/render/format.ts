/**
 * Small pure helpers shared by both renderers: colour, durations, truncation
 * and the status icons.
 *
 * @module
 */

import { stripVTControlCharacters, styleText } from "node:util";
import type { LocalStatus } from "../../local/protocol.ts";
import type { SessionEvent } from "../events.ts";

type Style = "bold" | "dim" | "green" | "red" | "yellow";

/** Applies a style to text, or returns it as is when colour is off. */
export type Paint = (style: Style, text: string) => string;

/** True when the stream is a terminal and `NO_COLOR` isn't set. */
export const supportsColor = (stream: { isTTY?: boolean }): boolean => {
  return Boolean(stream.isTTY) && !process.env.NO_COLOR;
};

export const createPaint = (color: boolean): Paint => {
  return (style, text) => {
    return color ? styleText(style, text, { validateStream: false }) : text;
  };
};

/**
 * A duration like `0.8s`, `22s` or `1m 12s`. Rounds down so a running timer
 * never runs ahead of the clock.
 */
export const formatElapsed = (ms: number): string => {
  const seconds = Math.floor(Math.max(0, ms) / 1000);

  if (seconds < 10) {
    return `${(Math.floor(Math.max(0, ms) / 100) / 10).toFixed(1)}s`;
  }

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/** Cut text to `max` characters, ending in an ellipsis when it was cut. */
export const truncate = (text: string, max: number): string => {
  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, Math.max(0, max - 1))}…`;
};

/**
 * Make text safe to draw on one line: no colour codes from a command's
 * output, no tabs and no line breaks.
 */
export const oneLine = (text: string): string => {
  return stripVTControlCharacters(text).replace(/\s+/g, " ").trim();
};

type Ready = Extract<SessionEvent, { kind: "ready" }>;
type Targets = Extract<SessionEvent, { kind: "targets" }>["targets"];

/**
 * What the runs are of, like `pull_request.opened · main @ 70f798f +
 * uncommitted`. The trigger is only said for a single target.
 */
export const describeTargets = (
  repo: Ready["repo"],
  targets: Targets = [],
): string => {
  const sha = repo.sha.slice(0, 7);

  return [
    targets.length === 1 ? targets[0]?.trigger : undefined,
    `${repo.ref} @ ${sha}${repo.dirty ? " + uncommitted" : ""}`,
  ]
    .filter(Boolean)
    .join(" · ");
};

/** Fit styled segments to `width`, cutting the last one that overflows. */
export const compose = (
  width: number,
  paint: Paint,
  segments: { text: string; style?: Style }[],
): string => {
  let remaining = width;
  let line = "";

  for (const { text, style } of segments) {
    if (remaining <= 0) {
      break;
    }

    const fitted = truncate(text, remaining);

    line += style ? paint(style, fitted) : fitted;
    remaining -= fitted.length;
  }

  return line;
};

/** Spinner frames, picked by the clock so every spinner turns in step. */
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const spinnerInterval = 80;

export const spinnerAt = (now: number): string => {
  return spinnerFrames[
    Math.floor(now / spinnerInterval) % spinnerFrames.length
  ] as string;
};

/**
 * The icon for a status. `spinner` is the current frame for a running status;
 * leave it out for a frame that won't animate, which shows a still circle.
 */
export const statusIcon = (
  status: LocalStatus,
  spinner: string | undefined,
  paint: Paint,
): string => {
  switch (status) {
    case "passed":
    case "cached": {
      return paint("green", "✓");
    }

    case "failed": {
      return paint("red", "✕");
    }

    case "running": {
      return paint("yellow", spinner ?? "◌");
    }

    case "cancelled": {
      return paint("yellow", "⊘");
    }

    case "skipped": {
      return paint("dim", "–");
    }

    case "queued": {
      return paint("dim", "○");
    }
  }
};
