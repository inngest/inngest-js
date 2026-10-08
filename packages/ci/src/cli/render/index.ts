/**
 * The renderers the CLI picks between: a live view for terminals and plain
 * lines for everything else.
 *
 * @module
 */

export { createInteractiveRenderer } from "./interactive.ts";
export { createPlainRenderer } from "./plain.ts";
