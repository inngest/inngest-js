/**
 * @module
 * Turns what went wrong with the reader's code into plain English that names
 * the real files and identifiers. It reads TypeScript diagnostics (the editor
 * checks the page before Run) and the errors Node throws when `run.ts` runs.
 * Identifiers in a headline are in backticks.
 */
import type { RunFailure } from "./types.ts";

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  length: number;
  // The TypeScript error code, such as 2305; 0 for a runtime error.
  code: number;
  message: string;
}

const quoted = (text: string) => {
  return [...text.matchAll(/'([^']+)'/g)].map((match) => match[1] as string);
};

// "./agent" or "../setup.ts" becomes "agent.ts" or "setup.ts".
const fileOfSpecifier = (specifier: string) => {
  const name = specifier.replace(/^.*\//, "");

  return /\.[cm]?[jt]sx?$/.test(name)
    ? name.replace(/\.js$/, ".ts")
    : `${name}.ts`;
};

// The first sentence of a TypeScript message, kept short.
const trimmed = (message: string) => {
  const first = message.split("\n")[0]?.trim() ?? "";

  return first.length > 160 ? `${first.slice(0, 157)}...` : first;
};

const missingExport = (
  importer: string,
  name: string,
  from: string,
  suggestion?: string,
  localOnly = false,
) => {
  const head = `\`${importer}\` can't find \`${name}\` in \`${from}\`.`;

  if (localOnly) {
    return `${head} \`${from}\` declares \`${name}\` but does not export it, so \`${from}\` needs \`export const ${name}\`.`;
  }

  return `${head} \`${importer}\` imports \`${name}\`, so \`${from}\` needs \`export const ${name}\`.${
    suggestion ? ` Did you mean \`${suggestion}\`?` : ""
  }`;
};

/**
 * Says what one TypeScript diagnostic means, in plain English.
 */
export const describeDiagnostic = (diagnostic: Diagnostic): RunFailure => {
  const { file, code, message } = diagnostic;
  const names = quoted(message);
  const where = {
    file,
    line: diagnostic.line,
    column: diagnostic.column,
    length: diagnostic.length,
  };
  const make = (headline: string): RunFailure => {
    return { headline, detail: `${file}:${diagnostic.line}`, ...where };
  };

  if (code === 2305 || code === 2724) {
    // 2305: Module '"./agent"' has no exported member 'hello'.
    // 2724: '"./agent"' has no exported member named 'hello'. Did you mean 'hi'?
    const [module, name, suggestion] = names;

    if (module && name) {
      return make(
        missingExport(
          file,
          name,
          fileOfSpecifier(module.replace(/"/g, "")),
          suggestion,
        ),
      );
    }
  }

  if (code === 2459 || code === 2460) {
    // Module '"./agent"' declares 'hello' locally, but it is not exported.
    const [module, name] = names;

    if (module && name) {
      return make(
        missingExport(
          file,
          name,
          fileOfSpecifier(module.replace(/"/g, "")),
          undefined,
          true,
        ),
      );
    }
  }

  if (code === 2307 && names[0]) {
    return make(
      `\`${file}\` imports \`${names[0]}\`, but there is no such file. Check the name, or add the file.`,
    );
  }

  if (code === 2304 || code === 2552 || code === 2580) {
    const [name, suggestion] = names;

    if (name) {
      return make(
        `\`${name}\` is not defined in \`${file}\`. Declare it or import it${suggestion ? `, or use \`${suggestion}\`` : ""}.`,
      );
    }
  }

  if (code === 2339 && names.length >= 2) {
    return make(
      `\`${file}\` uses \`${names[0]}\`, but \`${names[1]}\` has no such property.`,
    );
  }

  if (code === 2345 || code === 2322 || code === 2769) {
    return make(
      `\`${file}\` passes the wrong kind of value: ${trimmed(message)}`,
    );
  }

  if (code > 0 && code < 2000) {
    return make(`\`${file}\` has a syntax error: ${trimmed(message)}`);
  }

  return make(`\`${file}\` does not typecheck: ${trimmed(message)}`);
};

/**
 * Finds `file:line:column` of one of the page's files in an error's text and
 * stack. `files` are the names, such as `run.ts`.
 */
export const locate = (text: string, files: string[]) => {
  for (const name of files) {
    const escaped = name.replace(/\./g, "\\.");
    const match = new RegExp(
      `(?:^|[/\\\\:(\\s])${escaped}(?:\\?[^:\\s)]*)?:(\\d+)(?::(\\d+))?`,
    ).exec(text);

    if (match) {
      return {
        file: name,
        line: Number(match[1]),
        column: match[2] ? Number(match[2]) : 1,
      };
    }
  }

  return undefined;
};

/**
 * Says what an error thrown while `run.ts` ran (or the app loaded) means.
 * `text` is its message and stack; `files` the page's file names.
 */
export const describeRuntimeError = (
  text: string,
  files: string[],
  runner?: string,
): RunFailure => {
  const where = locate(text, files);
  const first = text.split("\n").find((line) => line.trim()) ?? text;
  const message = first.replace(/^(\w*Error): /, "").trim();
  const missing =
    /does not provide an export named '([^']+)'/.exec(text) ??
    /does not provide an export named "([^"]+)"/.exec(text);
  const from = /requested module '([^']+)'/.exec(text);
  const who = runner ?? where?.file;
  let headline = `${who ? `\`${who}\`` : "Your code"} failed: ${message}`;

  if (missing?.[1] && from?.[1]) {
    headline = missingExport(
      runner ?? where?.file ?? "run.ts",
      missing[1],
      fileOfSpecifier(from[1]),
    );
  } else if (/SyntaxError|Transform failed|Unexpected/.test(text)) {
    headline = `${who ? `\`${who}\`` : "Your code"} has a syntax error: ${message.replace(/^.*ERROR: /, "")}`;
  }

  return {
    headline,
    detail: where ? `${where.file}:${where.line}` : undefined,
    ...where,
  };
};
