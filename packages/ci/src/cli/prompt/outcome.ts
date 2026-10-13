/**
 * What every prompt ends with, and the key that backs out of any of them.
 *
 * @module
 */

import type { Key } from "node:readline";

/** How a prompt ended: with an answer, or because the person backed out. */
export type Outcome<T> = { kind: "submit"; value: T } | { kind: "cancel" };

/** `esc` or Ctrl-C. Prompts that take no typing also cancel on `q`. */
export const isCancel = (key: Key): boolean => {
  return key.name === "escape" || Boolean(key.ctrl && key.name === "c");
};
