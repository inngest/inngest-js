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
import { $ } from "../machine/command.ts";
import { createCiTestClient } from "../testing/client.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import type { RepoContext } from "../types.ts";
import { createCi } from "./createCi.ts";

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
) => {
  const result = await runFunction(
    asker.pipeline({ id: "pr", on: prTrigger }, body),
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
    ancestry: [
      { id: "mid", key: { shared: "mid", extra: "e1" } },
      { id: "base", key: { lock: "l1", shared: "base" } },
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
      ancestry: [{ id: "node-base", key: { devServer: "d1" } }],
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
