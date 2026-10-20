/**
 * Tests for what a job handler is given: the resolved cache key, what the job
 * started from, and the matrix combination, whether the job ran in the
 * pipeline's run, in a build run of its own, or was found cached.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { deployedRepo } from "../github/deployRepo.ts";
import { image } from "../image.ts";
import { $, createRawCommand, stateOfCommand } from "../machine/command.ts";
import { outputsFrom, storeOutput } from "../machine/outputs.ts";
import { createCiTestClient } from "../testing/client.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import type { RepoContext } from "../types.ts";
import { createCi } from "./createCi.ts";
import type { CiJobScope } from "./scope.ts";

vi.mock("../github/deployRepo.ts", () => {
  return { deployedRepo: vi.fn() };
});

const deployed: RepoContext = {
  owner: "acme",
  name: "platform",
  fullName: "acme/platform",
  sha: "a".repeat(40),
};

beforeEach(() => {
  vi.mocked(deployedRepo).mockReturnValue(deployed);
});

afterEach(() => {
  vi.mocked(deployedRepo).mockReset();
});

type Api = ReturnType<typeof createFakeSandboxApi>;

/** An app with its own client, on the environment `api` stands in for. */
const app = (api: Api, id: string) => {
  return createCi(createCiTestClient(api, id), { github: consoleReporter() });
};

/** What a handler saw, once: handlers replay from the top on every step. */
const unique = (seen: unknown[]): unknown[] => {
  return [
    ...new Set(
      seen.map((value) => {
        return JSON.stringify(value);
      }),
    ),
  ].map((json) => {
    return JSON.parse(json);
  });
};

/** Run `asker`'s pipeline with every app's functions in reach. */
const go = async (
  asker: ReturnType<typeof app>,
  apps: ReturnType<typeof app>[],
  body: () => Promise<unknown>,
  runId: string,
  childRuns?: boolean,
) => {
  const result = await runFunction(
    asker.pipeline({ id: "pr", on: prTrigger, childRuns }, body),
    {
      event: prEvent,
      runId,
      functions: apps.flatMap((ci) => {
        return ci.functions();
      }),
    },
  );

  expect(result.type).toBe("function-resolved");
};

describe("a cached job's key", () => {
  test("its named parts are given to the handler, and each is resolved once", async () => {
    const api = createFakeSandboxApi();
    const ci = app(api, "web");
    const release = vi.fn(async () => {
      return "v9";
    });
    const seen: unknown[] = [];

    const base = ci.job(
      { id: "base", cache: { key: { deps: "lock-1", release } } },
      async ({ id, key, cache }) => {
        seen.push({ id, key, cache });

        await $`pnpm install`;
      },
    );

    await go(
      ci,
      [ci],
      async () => {
        await base();
      },
      "01FIRST",
    );

    // The pipeline's run asks for the key, and the build run it invokes is
    // handed the result rather than asking again.
    expect(release).toHaveBeenCalledTimes(1);

    expect(unique(seen)).toEqual([
      {
        id: "base",
        key: { deps: "lock-1", release: "v9" },
        cache: "miss",
      },
    ]);
  });

  test("a key written as a list has no named parts", async () => {
    const api = createFakeSandboxApi();
    const ci = app(api, "web");
    const seen: unknown[] = [];

    const base = ci.job(
      { id: "base", cache: { key: ["lock-1", async () => "v9"] } },
      async ({ key }) => {
        seen.push(key);

        await $`pnpm install`;
      },
    );

    await go(
      ci,
      [ci],
      async () => {
        await base();
      },
      "01FIRST",
    );

    expect(unique(seen)).toEqual([{}]);
  });
});

describe("what a job starts from", () => {
  /** `base` and `mid` are cached, and `leaf` starts from `mid`. */
  const chain = (api: Api, seen: unknown[]) => {
    const ci = app(api, "web");

    const base = ci.job(
      {
        id: "base",
        cache: { key: { lock: "l1", shared: async () => "base" } },
      },
      async () => {
        await $`pnpm install`;
      },
    );

    const mid = ci.job(
      {
        id: "mid",
        from: base,
        cache: { key: { shared: "mid", extra: "e1" } },
      },
      async () => {
        await $`pnpm build`;
      },
    );

    const leaf = ci.job({ id: "leaf", from: mid }, async ({ from }) => {
      seen.push(from);

      await $`pnpm test`;
    });

    return { ci, leaf };
  };

  const expected = {
    id: "mid",
    key: { lock: "l1", shared: "mid", extra: "e1" },
    output: {},
    $: {},
    ancestry: [
      { id: "mid", key: { shared: "mid", extra: "e1" }, output: {}, $: {} },
      { id: "base", key: { lock: "l1", shared: "base" }, output: {}, $: {} },
    ],
  };

  test("from.key merges the keys above it, nearest first, and from.ancestry lists them", async () => {
    const seen: unknown[] = [];
    const { ci, leaf } = chain(createFakeSandboxApi(), seen);

    await go(
      ci,
      [ci],
      async () => {
        await leaf();
      },
      "01FIRST",
    );

    expect(unique(seen)).toEqual([expected]);
  });

  test("a snapshot that is found rather than built gives the same", async () => {
    const api = createFakeSandboxApi();
    const first: unknown[] = [];
    const second: unknown[] = [];

    for (const [runId, seen] of [
      ["01FIRST", first],
      ["01SECOND", second],
    ] as const) {
      const { ci, leaf } = chain(api, seen);

      await go(
        ci,
        [ci],
        async () => {
          await leaf();
        },
        runId,
      );
    }

    const installs = api.commands.filter((argv) => {
      return argv.join(" ").includes("pnpm install");
    });

    expect(installs).toHaveLength(1);
    expect(unique(second)).toEqual([expected]);
  });

  test("another app's job gives its key and ancestry too, built or found", async () => {
    const api = createFakeSandboxApi();
    const seen: unknown[] = [];

    for (const runId of ["01FIRST", "01SECOND"]) {
      const platform = app(api, "platform");
      const web = app(api, "web");

      platform.job(
        { id: "node-base", cache: { key: { devServer: async () => "d1" } } },
        async () => {
          await $`pnpm install`;
        },
      );

      const test = web.job(
        { id: "test", from: image.job("platform/node-base") },
        async ({ from }) => {
          seen.push(from);

          await $`pnpm test`;
        },
      );

      await go(
        web,
        [platform, web],
        async () => {
          await test();
        },
        runId,
      );
    }

    const image1 = {
      id: "node-base",
      key: { devServer: "d1" },
      output: {},
      $: {},
      ancestry: [
        { id: "node-base", key: { devServer: "d1" }, output: {}, $: {} },
      ],
    };

    expect(unique(seen)).toEqual([image1]);
  });
});

describe("a matrix job", () => {
  test("gets its combination as matrix, and the key of its own cache", async () => {
    const api = createFakeSandboxApi();
    const ci = app(api, "web");
    const seen: unknown[] = [];

    const compat = ci.matrix(
      {
        id: "compat",
        axes: { node: ["20", "22"] },
        cache: (combo) => {
          return { key: { node: combo.node } };
        },
      },
      async ({ id, matrix, key }) => {
        seen.push({ id, matrix, key });

        await $`pnpm test`;
      },
    );

    await go(
      ci,
      [ci],
      async () => {
        await compat();
      },
      "01FIRST",
    );

    expect(seen).toEqual(
      expect.arrayContaining([
        {
          id: "compat (node:20)",
          matrix: { node: "20" },
          key: { node: "20" },
        },
        {
          id: "compat (node:22)",
          matrix: { node: "22" },
          key: { node: "22" },
        },
      ]),
    );
  });
});

describe("what a job returns", () => {
  /** `base` is cached and returns data and a command, and `leaf` starts from it. */
  const chain = (api: Api, seen: unknown[], cache = true) => {
    const ci = app(api, "web");

    const base = ci.job(
      { id: "base", ...(cache ? { cache: { key: "v1" } } : {}) },
      async () => {
        await $`pnpm install`;

        return {
          version: await $`pnpm --version`.text(),
          release: { tag: "v9", assets: [1, 2] },
          dev: $`pnpm dev`.env({ PORT: "3000" }),
        };
      },
    );

    const leaf = ci.job({ id: "leaf", from: base }, async ({ from }) => {
      seen.push({
        output: from.output,
        ancestry: from.ancestry.map((above) => {
          return above.output;
        }),
        dev: stateOfCommand(from.$.dev),
      });

      await from.$.dev.env({ MODE: "test" });
    });

    return { ci, leaf };
  };

  const expected = {
    output: { version: "", release: { tag: "v9", assets: [1, 2] } },
    ancestry: [{ version: "", release: { tag: "v9", assets: [1, 2] } }],
    dev: {
      argv: ["pnpm", "dev"],
      env: { PORT: "3000" },
      retries: 0,
      nothrow: false,
    },
  };

  test("the job that starts from it gets the data as from.output and the command as from.$", async () => {
    const api = createFakeSandboxApi();
    const seen: unknown[] = [];
    const { ci, leaf } = chain(api, seen);

    await go(
      ci,
      [ci],
      async () => {
        await leaf();
      },
      "01FIRST",
    );

    expect(unique(seen)).toEqual([expected]);

    // The command is run on this job's machine, with what it was given here.
    expect(api.commands).toContainEqual(["pnpm", "dev"]);
  });

  test("a cached job's output is found with its snapshot, without the job running", async () => {
    const api = createFakeSandboxApi();
    const seen: unknown[] = [];

    for (const runId of ["01FIRST", "01SECOND"]) {
      const { ci, leaf } = chain(api, seen);

      await go(
        ci,
        [ci],
        async () => {
          await leaf();
        },
        runId,
      );
    }

    const installs = api.commands.filter((argv) => {
      return argv.join(" ").includes("pnpm install");
    });

    expect(installs).toHaveLength(1);
    expect(unique(seen)).toEqual([expected]);
  });

  test("an uncached job's output is found the same way", async () => {
    const seen: unknown[] = [];
    const { ci, leaf } = chain(createFakeSandboxApi(), seen, false);

    await go(
      ci,
      [ci],
      async () => {
        await leaf();
      },
      "01FIRST",
    );

    expect(unique(seen)).toEqual([expected]);
  });

  test("an uncached job resolves to its data, without its commands", async () => {
    const ci = app(createFakeSandboxApi(), "web");
    const results: unknown[] = [];

    const job = ci.job("job", async () => {
      return { count: 3, dev: $`pnpm dev` };
    });

    await go(
      ci,
      [ci],
      async () => {
        results.push(await job());
      },
      "01FIRST",
    );

    expect(unique(results)).toEqual([{ count: 3 }]);
  });

  test("a job gives the same data inline as it does in a child run", async () => {
    const gave: Record<string, unknown[]> = { inline: [], child: [] };

    for (const [mode, childRuns] of [
      ["inline", false],
      ["child", true],
    ] as const) {
      const ci = app(createFakeSandboxApi(), "web");
      const seen: unknown[] = [];

      const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
        await $`pnpm install`;

        return { answer: 42, dev: $`pnpm dev` };
      });

      const leaf = ci.job({ id: "leaf", from: base }, async ({ from }) => {
        seen.push({ output: from.output, dev: Object.keys(from.$) });

        return { count: 3, dev: $`pnpm dev` };
      });

      await go(
        ci,
        [ci],
        async () => {
          gave[mode]!.push(await leaf());
        },
        "01FIRST",
        childRuns,
      );

      gave[mode] = unique([...gave[mode]!, ...seen]);
    }

    expect(gave.child).toEqual(gave.inline);
    expect(gave.inline).toEqual([
      { count: 3 },
      { output: { answer: 42 }, dev: ["dev"] },
    ]);
  });

  test("a job that ran no commands but returned something still gives it", async () => {
    const seen: unknown[] = [];
    const ci = app(createFakeSandboxApi(), "web");

    const base = ci.job("base", async () => {
      return { answer: 42 };
    });

    const leaf = ci.job({ id: "leaf", from: base }, async ({ from }) => {
      seen.push(from.output);

      await $`pnpm test`;
    });

    await go(
      ci,
      [ci],
      async () => {
        await leaf();
      },
      "01FIRST",
    );

    expect(unique(seen)).toEqual([{ answer: 42 }]);
  });

  test("outputs merge up the chain, the nearest job winning a name", async () => {
    const api = createFakeSandboxApi();
    const seen: unknown[] = [];
    const ci = app(api, "web");

    const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
      await $`pnpm install`;

      return { shared: "base", only: "base", run: $`pnpm base` };
    });

    const mid = ci.job(
      { id: "mid", from: base, cache: { key: "v1" } },
      async () => {
        await $`pnpm build`;

        return { shared: "mid", run: $`pnpm mid` };
      },
    );

    const leaf = ci.job({ id: "leaf", from: mid }, async ({ from }) => {
      seen.push({
        output: from.output,
        ancestry: from.ancestry.map((above) => {
          return [above.id, above.output, Object.keys(above.$)];
        }),
        run: stateOfCommand(from.$.run).argv,
      });

      await $`pnpm test`;
    });

    await go(
      ci,
      [ci],
      async () => {
        await leaf();
      },
      "01FIRST",
    );

    expect(unique(seen)).toEqual([
      {
        output: { shared: "mid", only: "base" },
        ancestry: [
          ["mid", { shared: "mid" }, ["run"]],
          ["base", { shared: "base", only: "base" }, ["run"]],
        ],
        run: ["pnpm", "mid"],
      },
    ]);
  });

  test("each use of a command in from.$ is a command of its own", async () => {
    const seen: unknown[] = [];
    const ci = app(createFakeSandboxApi(), "web");

    const base = ci.job("base", async () => {
      await $`pnpm install`;

      return { dev: $`pnpm dev` };
    });

    const child = ci.job({ id: "child", from: base }, async ({ from }) => {
      seen.push(stateOfCommand(from.$.dev.env({ A: "1" })));
      seen.push(stateOfCommand(from.$.dev));
    });

    await go(
      ci,
      [ci],
      async () => {
        await child();
      },
      "01FIRST",
    );

    expect(unique(seen)).toMatchObject([{ env: { A: "1" } }, { env: {} }]);
  });

  test("data that looks like a stored command stays data", async () => {
    const seen: unknown[] = [];
    const ci = app(createFakeSandboxApi(), "web");

    const base = ci.job("base", async () => {
      await $`pnpm install`;

      return { metadata: { $cmd: "literal" }, dev: $`pnpm dev` };
    });

    const child = ci.job({ id: "child", from: base }, async ({ from }) => {
      seen.push({ output: from.output, commands: Object.keys(from.$) });
    });

    await go(
      ci,
      [ci],
      async () => {
        await child();
      },
      "01FIRST",
    );

    expect(unique(seen)).toEqual([
      { output: { metadata: { $cmd: "literal" } }, commands: ["dev"] },
    ]);
  });

  test("a returned command with an onTimeout callback is refused", () => {
    const scope = { outputs: {} } as CiJobScope;

    const dev = createRawCommand(() => {
      return scope;
    }, ["pnpm", "dev"]).onTimeout(async () => {});

    expect(() => {
      return storeOutput(scope, "base", [], { dev });
    }).toThrow(/onTimeout/);
  });

  test("two jobs with the same ID in a chain keep their own outputs", () => {
    const scope = { outputs: {} } as CiJobScope;
    const root = { id: "build", key: {} };
    const top = { id: "build", key: {} };

    storeOutput(scope, "build", [], { from: "root" });

    storeOutput(scope, "build", [root], { from: "top" });

    const above = outputsFrom(
      () => {
        return scope;
      },
      [top, root],
      scope.outputs,
    );

    expect(above.output).toEqual({ from: "top" });
    expect(above.ancestry.map((one) => one.output)).toEqual([
      { from: "top" },
      { from: "root" },
    ]);
  });

  test("another app's job gives its output, built or found", async () => {
    const api = createFakeSandboxApi();
    const seen: unknown[] = [];

    for (const runId of ["01FIRST", "01SECOND"]) {
      const platform = app(api, "platform");
      const web = app(api, "web");

      platform.job({ id: "node-base", cache: { key: "v1" } }, async () => {
        await $`pnpm install`;

        return { node: "22", dev: $`pnpm dev` };
      });

      const test = web.job(
        { id: "test", from: image.job("platform/node-base") },
        async ({ from }) => {
          seen.push({
            output: from.output,
            dev: stateOfCommand(from.$.dev!).argv,
          });

          await $`pnpm test`;
        },
      );

      await go(
        web,
        [platform, web],
        async () => {
          await test();
        },
        runId,
      );
    }

    expect(unique(seen)).toEqual([
      { output: { node: "22" }, dev: ["pnpm", "dev"] },
    ]);
  });
});
