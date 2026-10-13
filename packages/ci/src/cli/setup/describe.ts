/**
 * Saying what detection found, and what to do when `inngest-ci` can't carry on
 * from it: the facts shown to a person, and the error that gives an agent the
 * exact `inngest.json` to write. Pure text.
 *
 * @module
 */

import { posix } from "node:path";

import { SetupError } from "../setupError.ts";
import type { CiInstance } from "./analyze.ts";
import type { Candidate, Detection } from "./detect.ts";
import type { Fact } from "./review.ts";

const quickStart =
  "https://github.com/inngest/inngest-js/tree/main/packages/ci#quick-start";

/** What detection found for one server, as the lines setup shows. */
export const factsOf = (candidate: Candidate): Fact[] => {
  return [
    { label: "CI", value: `${candidate.ci.file} (${candidate.ci.name})` },
    { label: "Server", value: candidate.file },
    { label: "Start", value: candidate.start },
    { label: "Path", value: candidate.path },
    ...candidate.warnings.map((value): Fact => {
      return { label: "Warning", value, warn: true };
    }),
  ];
};

/** The `inngest.json` that makes `inngest-ci` run `start` and sync at `path`. */
const configSnippet = (ci: { start: string; path: string }): string => {
  return JSON.stringify({ ci: { start: ci.start, path: ci.path } }, null, 2);
};

const formatFacts = (facts: Fact[]): string => {
  const width = Math.max(
    ...facts.map((fact) => {
      return fact.label.length;
    }),
  );

  return facts
    .map((fact) => {
      return `  ${fact.label.padEnd(width)}  ${fact.value}`;
    })
    .join("\n");
};

/** The minimal server of the Quick start, importing `instance` from its file. */
const standaloneServer = (instance: CiInstance): string => {
  const from = posix
    .relative("ci", instance.file)
    .replace(/\.[cm]?[jt]sx?$/, "");

  return [
    'import { createServer } from "inngest/node";',
    `import { ${instance.client}, ${instance.name} } from "${from.startsWith(".") ? from : `./${from}`}";`,
    "",
    `const server = createServer({ client: ${instance.client}, functions: ${instance.name}.functions() });`,
    "",
    "server.listen(Number(process.env.PORT ?? 3000));",
  ].join("\n");
};

/**
 * Why a project with no `ci` config can't be set up without a person: what
 * detection found and what to write, or how to get to something it can find.
 */
export const missingConfigError = (
  detection: Detection,
  opts: { claude: boolean },
): SetupError => {
  const [first, ...others] = detection.candidates;
  const [instance] = detection.instances;

  if (!instance) {
    return new SetupError("@inngest/ci isn't set up in this project.", {
      fix: [
        `Follow the Quick start: ${quickStart}`,
        ...(opts.claude ? ["Or ask Claude to set up Inngest CI."] : []),
      ].join("\n"),
    });
  }

  if (!first) {
    const [connect] = detection.connects;

    return new SetupError(
      connect
        ? `${connect} serves ${instance.name}.functions() with connect(), which inngest-ci can't run yet.`
        : `Nothing serves ${instance.name}.functions().`,
      {
        fix: `Add ci/server.ts, which inngest-ci starts without any config. Import your pipelines there too.\n\n${standaloneServer(instance)}`,
      },
    );
  }

  return new SetupError("There is no ci config in inngest.json.", {
    fix: [
      `Found\n${formatFacts(factsOf(first))}`,
      ...(others.length > 0
        ? [
            `Also found servers in ${others
              .map((other) => {
                return other.file;
              })
              .join(", ")}. Use one of those instead if it is the right one.`,
          ]
        : []),
      `Add this to inngest.json, then run inngest-ci again:\n\n${configSnippet(first)}`,
    ].join("\n\n"),
  });
};
