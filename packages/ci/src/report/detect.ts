/**
 * Finding out, from a command's arguments, whether it is a tool that reports
 * as JSON and where it writes that report. Only a direct call is recognised:
 * a script that wraps a tool hides it, and gets the job's own `report` call.
 *
 * @module
 */

export type ReportFormat = "vitest" | "jest" | "eslint" | "biome" | "tsc";

/** A report the command asked for: its format, and the file it goes to. */
export interface Declared {
  format: ReportFormat;
  /** Missing when the report goes to stdout. */
  file?: string;
}

/** Every value given to one of the flags, as `--flag value` or `--flag=value`. */
const flagValues = (tokens: string[], ...flags: string[]): string[] => {
  const values: string[] = [];

  for (const [index, token] of tokens.entries()) {
    for (const flag of flags) {
      const next = tokens[index + 1];

      if (token === flag && next !== undefined) {
        values.push(next);
      } else if (token.startsWith(`${flag}=`)) {
        values.push(token.slice(flag.length + 1));
      }
    }
  }

  return values;
};

const base = (token: string): string => {
  return (token.split("/").at(-1) ?? token).replace(/\.[cm]?js$/, "");
};

/** The report a command writes or prints as JSON, if it is a known tool. */
export const declaredReport = (argv: string[]): Declared | undefined => {
  const tokens = argv.flatMap((token) => {
    return token.split(/\s+/).filter(Boolean);
  });

  const tool = tokens.map(base).find((name) => {
    return ["vitest", "jest", "eslint", "biome"].includes(name);
  });

  if (tool === "vitest" || tool === "jest") {
    const json =
      tokens.includes("--json") ||
      flagValues(tokens, "--reporter").includes("json");

    const [file] = flagValues(tokens, "--outputFile", "--outputFile.json");

    return json ? { format: tool, ...(file ? { file } : {}) } : undefined;
  }

  if (tool === "eslint") {
    const json =
      flagValues(tokens, "-f", "--format").includes("json") ||
      tokens.includes("-fjson");

    const [file] = flagValues(tokens, "-o", "--output-file");

    return json ? { format: "eslint", ...(file ? { file } : {}) } : undefined;
  }

  if (tool === "biome" && flagValues(tokens, "--reporter").includes("json")) {
    return { format: "biome" };
  }

  return undefined;
};
