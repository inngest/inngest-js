/**
 * @module
 * EXPERIMENTAL: where an agent or a tool was defined, read from the stack at
 * definition time. Runtimes that apply source maps (tsx, Node with
 * `--enable-source-maps`) already put the original `.ts` position in the
 * stack, so nothing here reads a source map.
 */

import { fileURLToPath } from "node:url";

/**
 * EXPERIMENTAL: a position in a source file.
 */
export interface SourceLocation {
  /**
   * An absolute path.
   */
  file: string;

  /**
   * 1-based.
   */
  line: number;

  /**
   * 1-based.
   */
  column?: number;
}

const frameRegex = /^\s*at (?:.*? \()?(.+?):(\d+):(\d+)\)?\s*$/;

/**
 * The directory of the SDK, found from this file's own frame: everything under
 * it is not the caller.
 */
const sdkRootOf = (file: string): string => {
  const marked = file.search(/[\\/]components[\\/]sandbox[\\/][^\\/]*$/);

  if (marked >= 0) {
    return file.slice(0, marked);
  }

  return file.slice(0, Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")));
};

const toPath = (file: string): string => {
  if (file.startsWith("file://")) {
    try {
      return fileURLToPath(file);
    } catch {
      return file;
    }
  }

  return file;
};

/**
 * EXPERIMENTAL: the file, line and column of the code that called the SDK:
 * the first stack frame outside the SDK. Undefined when there is none, or
 * when the first frame outside the SDK is Node's own (the SDK defining its
 * own tools while it loads). Never throws.
 */
export const callSite = (): SourceLocation | undefined => {
  const limit = Error.stackTraceLimit;

  try {
    Error.stackTraceLimit = 40;

    const lines = (new Error().stack ?? "").split("\n").slice(1);
    let root: string | undefined;

    for (const text of lines) {
      const match = frameRegex.exec(text);

      if (!match) {
        continue;
      }

      const file = toPath(match[1] ?? "");

      if (root === undefined) {
        // The first frame is this function's own.
        root = sdkRootOf(file);
      }

      // The SDK's own tests live under its root and are callers.
      if (file.startsWith(root) && !/\.test\.[cm]?[jt]sx?$/.test(file)) {
        continue;
      }

      if (file.startsWith("node:") || file.startsWith("internal/")) {
        return undefined;
      }

      return {
        file,
        line: Number(match[2]),
        column: Number(match[3]),
      };
    }
  } catch {
    // No location is fine.
  } finally {
    Error.stackTraceLimit = limit;
  }

  return undefined;
};

const toolSources = new WeakMap<object, SourceLocation>();

/**
 * Remembers where a tool was defined, keyed by the tool object.
 */
export const rememberToolSource = <T extends object>(
  entry: T,
  source: SourceLocation | undefined,
): T => {
  if (source) {
    toolSources.set(entry, source);
  }

  return entry;
};

/**
 * Where a tool was defined, when `tool()` and its siblings captured it.
 */
export const toolSourceOf = (entry: unknown): SourceLocation | undefined => {
  return typeof entry === "object" && entry !== null
    ? toolSources.get(entry)
    : undefined;
};
