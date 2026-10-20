/**
 * Tests of a matrix whose `axes` is an async function: it is called once per
 * run, in a step, with what is known before any job runs, and a combination
 * built in a run of its own is handed its values rather than the function.
 *
 * @module
 */

import { describe, expect, expectTypeOf, test } from "vitest";
import { consoleReporter, githubToken } from "../github/auth.ts";
import { github } from "../github/index.ts";
import { $ } from "../machine/command.ts";
import { createCiTestClient } from "../testing/client.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeGitHub } from "../testing/fakeGitHub.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { invokedRunCount, runFunction } from "../testing/runFunction.ts";
import { createCi } from "./createCi.ts";

const setup = () => {
  const api = createFakeSandboxApi();
  const ci = createCi(createCiTestClient(api), {
    github: consoleReporter(),
  });

  return { api, ci };
};

const commands = (api: ReturnType<typeof setup>["api"]): string[] => {
  return api.commands
    .map((argv) => {
      return argv.join(" ");
    })
    .filter((command) => {
      return command.startsWith("test ");
    })
    .sort();
};

describe("a matrix with async axes", () => {
  test("runs a combination for each value the function returns, typed by what it returns", async () => {
    const { api, ci } = setup();

    const examples = ci.matrix(
      {
        id: "examples",
        axes: async () => {
          return { example: ["next", "remix"], mode: ["a"] };
        },
      },
      async ({ matrix }) => {
        expectTypeOf(matrix.example).toBeString();

        await $`test ${matrix.example} ${matrix.mode}`;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await examples();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(commands(api)).toEqual(["test next a", "test remix a"]);
  });

  test("the function is called once per run, however often the matrix is called, with the run's commit", async () => {
    const { api, ci } = setup();
    const calls: (string | undefined)[] = [];

    const examples = ci.matrix(
      {
        id: "examples",
        axes: async ({ repo }) => {
          calls.push(repo?.sha);

          return { example: ["next", "remix"] };
        },
      },
      async ({ matrix }) => {
        await $`test ${matrix.example}`;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await examples();
      await examples({ example: "next" });
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(calls).toEqual(["abc1234"]);

    expect(
      result.stepIds.filter((id) => {
        return id === "matrix › examples › axes";
      }),
    ).toHaveLength(1);

    expect(commands(api)).toEqual(["test next", "test next", "test remix"]);
  });

  test("a combination built in a run of its own runs with the values it was given, ", async () => {
    const { api, ci } = setup();
    let calls = 0;

    const examples = ci.matrix(
      {
        id: "examples",
        cache: { key: "v1" },
        axes: async () => {
          calls += 1;

          return { example: ["next", "remix"] };
        },
      },
      async ({ matrix }) => {
        await $`test ${matrix.example}`;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await examples();
    });

    const before = invokedRunCount();
    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(invokedRunCount() - before).toBe(2);
    expect(calls).toBe(1);
    expect(commands(api)).toEqual(["test next", "test remix"]);
  });

  test("an axis with no values fails the run without retrying", async () => {
    const { ci } = setup();
    let calls = 0;

    const examples = ci.matrix(
      {
        id: "examples",
        axes: async () => {
          calls += 1;

          return { example: [] as string[] };
        },
      },
      async () => {},
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await examples();
    });

    const result = await runFunction(pipeline, { event: prEvent, retries: 3 });

    expect(result.type).toBe("function-rejected");
    expect(result.retriable).toBe(false);
    expect(calls).toBe(1);

    expect((result.error as Error).message).toContain(
      'The `example` axis of matrix "examples" has no values.',
    );
  });
});

describe("a matrix whose axes list a directory at the run's commit", () => {
  test("reads it through the GitHub API in the axes step, once", async () => {
    const gh = createFakeGitHub();
    const api = createFakeSandboxApi();

    const ci = createCi(createCiTestClient(api), {
      github: githubToken({
        token: "gh-test-token",
        baseUrl: "https://api.github.test",
        fetch: gh.fetch,
      }),
    });

    gh.route("GET /repos/inngest/inngest-js/contents/examples", [
      { name: "framework-next", type: "dir" },
      { name: "README.md", type: "file" },
      { name: "bun-sync", type: "dir" },
    ]);

    const examples = ci.matrix(
      {
        id: "examples",
        axes: async ({ repo }) => {
          const entries = await github.rest.repos.getContent({
            path: "examples",
            ref: repo?.sha ?? "",
          });

          return {
            example: (Array.isArray(entries) ? entries : [])
              .filter((entry) => {
                return entry.type === "dir";
              })
              .map((entry) => {
                return entry.name;
              }),
          };
        },
      },
      async ({ matrix }) => {
        await $`test ${matrix.example}`;
      },
    );

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, check: false },
      async () => {
        await examples();
      },
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(commands(api)).toEqual(["test bun-sync", "test framework-next"]);

    expect(gh.requests).toHaveLength(1);
    expect(gh.requests[0]?.path).toBe(
      "/repos/inngest/inngest-js/contents/examples",
    );
  });
});

describe("a matrix's async axes", () => {
  test("only hold values that are saved as they are", () => {
    const { ci } = setup();

    ci.matrix(
      {
        id: "dates",
        // @ts-expect-error a `Date` is saved as a string
        axes: async () => {
          return { day: [new Date()] };
        },
      },
      async () => {},
    );
  });
});
