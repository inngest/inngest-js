/**
 * Reading what tools report about a job's code: the JSON a command wrote or
 * printed, a file the job names with `report.results`, and the type errors in
 * the output of a command that failed. What is found goes on the job's scope,
 * and never changes whether a command or job passed.
 *
 * @module
 */

import { CiUsageError } from "../errors.ts";
import { ciStep } from "../pipeline/names.ts";
import type { CiJobScope } from "../pipeline/scope.ts";
import { defaultCwd, joinId, nextStepId } from "../pipeline/scope.ts";
import { parseBiome } from "../report/biome.ts";
import { declaredReport, type ReportFormat } from "../report/detect.ts";
import { parseEslint } from "../report/eslint.ts";
import { type Found, jsonIn } from "../report/found.ts";
import { repoPathOf } from "../report/paths.ts";
import { parseTsc } from "../report/tsc.ts";
import { parseTestResults } from "../report/vitest.ts";
import type { CommandResult } from "../types.ts";
import { ensureMachine } from "./machine.ts";

/** A report larger than this is left alone. */
const maxReportBytes = 5_000_000;

/** What a report of this format holds, given its text. */
export const parseReport = (format: ReportFormat, text: string): Found[] => {
  switch (format) {
    case "tsc":
      return parseTsc(text);
    case "eslint":
      return parseEslint(jsonIn(text));
    case "biome":
      return parseBiome(jsonIn(text));
    default:
      return parseTestResults(jsonIn(text));
  }
};

/** What was found, with each file as a path in the repository. */
const inRepository = (found: Found[], cwd: string): Found[] => {
  return found.flatMap((item) => {
    const file = repoPathOf(item.file, cwd);

    return file ? [{ ...item, file }] : [];
  });
};

const readText = async (
  scope: CiJobScope,
  id: string,
  path: string,
  cwd: string,
): Promise<string | undefined> => {
  const machine = await ensureMachine(scope);

  const bytes: Uint8Array = await machine.sandbox.files.read(
    ciStep(id, "Read report"),
    path.startsWith("/") ? path : `${cwd}/${path}`,
  );

  return bytes.byteLength > maxReportBytes
    ? undefined
    : new TextDecoder().decode(bytes);
};

/**
 * Look for what a finished command reported: the JSON a known tool was asked
 * to write or print, or else type errors in the output of one that failed.
 * Returns it for the caller to keep, since a command that is retried keeps
 * only what its last attempt found.
 */
export const collectReports = async (
  scope: CiJobScope,
  command: { argv: string[]; stepId: string; cwd?: string },
  result: CommandResult,
): Promise<Found[]> => {
  const cwd = command.cwd ?? scope.cwd ?? defaultCwd;

  try {
    const declared = declaredReport(command.argv);
    let found: Found[] = [];

    if (declared) {
      const text = declared.file
        ? await readText(
            scope,
            joinId(command.stepId, "report"),
            declared.file,
            cwd,
          )
        : result.stdout;

      found = text ? parseReport(declared.format, text) : [];
    }

    if (found.length === 0 && result.exitCode !== 0) {
      found = parseTsc(result.merged ?? `${result.stderr}\n${result.stdout}`);
    }

    return inRepository(found, cwd);
  } catch {
    // A report that can't be read is not a reason to fail the job.
    return [];
  }
};

/**
 * Read a report file the job names, and keep what is in it: for a tool the job
 * runs through a script, which `collectReports` can't see.
 */
export const readReportFile = async (
  scope: CiJobScope,
  format: ReportFormat,
  path: string,
): Promise<void> => {
  const cwd = scope.cwd ?? defaultCwd;

  const text = await readText(
    scope,
    nextStepId(scope.run, scope.path, `report:${format}`),
    path,
    cwd,
  );

  if (text === undefined) {
    throw new CiUsageError(
      `\`${path}\` is over ${maxReportBytes} bytes, more than a report can be.`,
    );
  }

  scope.found.push(...inRepository(parseReport(format, text), cwd));
};
