/**
 * Live Tap Pull, test mode: write a fixture and an `@inngest/test` scaffold
 * from a recorded run.
 *
 * @module
 */

import { rm, writeFile } from "node:fs/promises";
import type { RecordedRun } from "./pull.ts";

/**
 * Write a JSON fixture and an `@inngest/test` scaffold. The test mocks every
 * recorded step except the target by its real ID, and runs the target on your
 * code with the production event.
 */
export const writeTestScaffold = async (opts: {
  recorded: RecordedRun;
  testPath: string;
  step?: string;
}): Promise<{ fixturePath: string; target: string }> => {
  const { recorded } = opts;
  const targetStep =
    recorded.steps.find((step) => {
      return step.id === opts.step;
    }) ??
    recorded.steps.find((step) => {
      return step.failed;
    }) ??
    recorded.steps[recorded.steps.length - 1];
  const target = targetStep?.id ?? "";
  const fixturePath = `${opts.testPath.replace(/\.[cm]?[jt]sx?$/, "")}.fixture.json`;
  const fixtureFile = fixturePath.split(/[\\/]/).pop();

  const fixture = {
    runId: recorded.runId,
    function: recorded.functionSlug,
    target,
    events: recorded.events,
    steps: recorded.steps.map((step) => {
      return { id: step.id, data: step.data, failed: step.failed };
    }),
  };

  const oneLine = (value: unknown) => {
    return (JSON.stringify(value) ?? "undefined")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
  };
  const recordedNote = targetStep?.failed
    ? `Production failed this step with: ${oneLine((targetStep.data as { message?: unknown } | undefined)?.message)}`
    : `Production recorded this for the target:\n    // expect(result).toEqual(${oneLine(targetStep?.data)});`;

  const test = `import { InngestTestEngine } from "@inngest/test";
import { describe, expect, it } from "vitest";
import fixture from "./${fixtureFile}";
// Edit this import: point it at the function with id ${JSON.stringify(recorded.functionSlug)}.
// Importing JSON needs "resolveJsonModule" in your tsconfig.
import { fn } from "./path-to-your-function";

describe(${JSON.stringify(`run ${recorded.runId}`)}, () => {
  it(${JSON.stringify(`${target} with production inputs`)}, async () => {
    const t = new InngestTestEngine({ function: fn });

    const { result, error } = await t.executeStep(fixture.target, {
      events: fixture.events,
      steps: fixture.steps
        .filter((step) => {
          return step.id !== fixture.target && !step.failed;
        })
        .map((step) => {
          return {
            id: step.id,
            handler() {
              return step.data;
            },
          };
        }),
    });

    expect(error).toBeUndefined();

    // Pin the behaviour you want. ${recordedNote}
  });
});
`;

  // `wx`: never overwrite your code or an earlier fixture.
  await writeFile(opts.testPath, test, { flag: "wx" });
  try {
    await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, {
      flag: "wx",
    });
  } catch (err) {
    await rm(opts.testPath);

    throw err;
  }

  return { fixturePath, target };
};
