/**
 * Reading `biome check --reporter=json`: diagnostics with a category, a
 * severity and a byte span in the file.
 *
 * @module
 */

import { type Found, isRecord } from "./found.ts";

/** The 1-based line of a UTF-8 byte offset into `source`. */
const lineAt = (source: string, offset: number): number => {
  let line = 1;

  for (const byte of new TextEncoder().encode(source).subarray(0, offset)) {
    if (byte === 10) {
      line++;
    }
  }

  return line;
};

/** `noExplicitAny` as the docs name it: `no-explicit-any`. */
const kebab = (name: string): string => {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
};

/** The problems in biome's JSON. Anything else gives nothing. */
export const parseBiome = (json: unknown): Found[] => {
  const diagnostics = isRecord(json) ? json.diagnostics : undefined;

  if (!Array.isArray(diagnostics)) {
    return [];
  }

  const found: Found[] = [];

  for (const diagnostic of diagnostics) {
    if (!isRecord(diagnostic) || !isRecord(diagnostic.location)) {
      continue;
    }

    const path = diagnostic.location.path;
    const file = isRecord(path) ? path.file : path;

    if (typeof file !== "string") {
      continue;
    }

    const span = diagnostic.location.span;
    const source = diagnostic.location.sourceCode;

    // Spans are byte offsets, so the line is only known with the source, and
    // its newlines are counted in the UTF-8 bytes the offset is into.
    const line =
      Array.isArray(span) && typeof source === "string"
        ? lineAt(source, Number(span[0]))
        : 1;

    const category =
      typeof diagnostic.category === "string" ? diagnostic.category : "";
    const rule = category.split("/").at(-1) ?? "";

    found.push({
      tool: "biome",
      file,
      line,
      level:
        diagnostic.severity === "error"
          ? "failure"
          : diagnostic.severity === "warning"
            ? "warning"
            : "notice",
      ...(category ? { rule: category } : {}),
      title: category ? `biome ${category}` : "biome",
      message:
        typeof diagnostic.description === "string"
          ? diagnostic.description
          : "",
      ...(category.startsWith("lint/") && rule
        ? { details: `https://biomejs.dev/linter/rules/${kebab(rule)}` }
        : {}),
    });
  }

  return found;
};
