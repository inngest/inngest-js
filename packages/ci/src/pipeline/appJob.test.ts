/**
 * Tests for starting from another app's job with `image.job()`: one app asks,
 * the owner resolves and builds, and names follow the owner's snapshot.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { files } from "../cache/cache.ts";
import { consoleReporter } from "../github/auth.ts";
import { deployedRepo } from "../github/deployRepo.ts";
import { image } from "../image.ts";
import { $ } from "../machine/command.ts";
import { createCiTestClient } from "../testing/client.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import type { RepoContext } from "../types.ts";
import { appJobRequestVersion } from "./appJob.ts";
import { cacheBuildFunctionId } from "./cacheBuild.ts";
import { createCi } from "./createCi.ts";

vi.mock("../github/deployRepo.ts", async (original) => {
  return {
    ...(await original<typeof import("../github/deployRepo.ts")>()),
    deployedRepo: vi.fn(),
  };
});

const deployed: RepoContext = {
  owner: "acme",
  name: "platform",
  fullName: "acme/platform",
  sha: "a".repeat(40),
  ref: "refs/heads/main",
  baseRef: "main",
};

beforeEach(() => {
  vi.mocked(deployedRepo).mockReturnValue(deployed);
});

afterEach(() => {
  vi.mocked(deployedRepo).mockReset();
});

type Api = ReturnType<typeof createFakeSandboxApi>;
type Ci = ReturnType<typeof createCi>;

/** An app with its own client, on the environment `api` stands in for. */
const app = (api: Api, appId: string): Ci => {
  return createCi(createCiTestClient(api, appId), {
    github: consoleReporter(),
  });
};

/** How many commands containing `text` ran. */
const ran = (api: Api, text: string): number => {
  return api.commands.filter((argv) => {
    return argv.join(" ").includes(text);
  }).length;
};

/** Run `asker`'s pipeline with every app's functions in reach. */
const go = (
  asker: Ci,
  apps: Ci[],
  body: () => Promise<void>,
  runId?: string,
) => {
  return runFunction(asker.pipeline({ id: "pr", on: prTrigger }, body), {
    event: prEvent,
    ...(runId ? { runId } : {}),
    functions: apps.flatMap((ci) => {
      return ci.functions();
    }),
  });
};

const message = (result: Awaited<ReturnType<typeof go>>): string => {
  return String((result.error as { message?: string } | undefined)?.message);
};

/** Define `platform`'s `node-base`, cached on `key`, and `web`'s `test` on it. */
const world = (api: Api, key: string | ReturnType<typeof files> = "v1") => {
  const platform = app(api, "platform");
  const web = app(api, "web");

  platform.job({ id: "node-base", cache: { key } }, async () => {
    await $`pnpm install`;
  });

  const test = web.job(
    { id: "test", from: image.job("platform/node-base") },
    async () => {
      await $`pnpm test`;
    },
  );

  const asking = (runId: string) => {
    return go(
      web,
      [platform, web],
      async () => {
        await test();
      },
      runId,
    );
  };

  return { platform, web, asking };
};

describe("image.job()", () => {
  test("starts a job from another app's job, which that app builds once and looks up on every ask", async () => {
    const api = createFakeSandboxApi();

    for (const runId of ["01FIRST", "01SECOND"]) {
      const result = await world(api).asking(runId);

      expect(result.type).toBe("function-resolved");

      // The asking app can't work out the other app's snapshot names, so it
      // has no lookup of its own: every run invokes the owner.
      expect(
        result.stepIds.filter((id) => {
          return id.startsWith("image ");
        }),
      ).toEqual(["image job:platform/node-base"]);
    }

    expect(ran(api, "pnpm install")).toBe(1);
    expect(ran(api, "pnpm test")).toBe(2);

    const [snapshot, ...others] = [...api.snapshots.values()];

    expect(others).toEqual([]);

    // The owner names it in the branch it was deployed from.
    expect(snapshot?.name).toMatch(/^ci\/main\/node-base\//);

    expect(
      [...api.sandboxes.values()].filter((sandbox) => {
        return sandbox.snapshotId === snapshot?.id;
      }),
    ).toHaveLength(2);
  });

  test("a cached job on another app's job builds again when that job does", async () => {
    const api = createFakeSandboxApi();

    const run = async (key: string, runId: string) => {
      const platform = app(api, "platform");
      const web = app(api, "web");

      platform.job({ id: "node-base", cache: { key } }, async () => {
        await $`pnpm install`;
      });

      const deps = web.job(
        {
          id: "deps",
          from: image.job("platform/node-base"),
          cache: { key: "d1" },
        },
        async () => {
          await $`pnpm deps`;
        },
      );

      const result = await go(
        web,
        [platform, web],
        async () => {
          await deps();
        },
        runId,
      );

      expect(result.type).toBe("function-resolved");
    };

    await run("v1", "01A");
    await run("v1", "01B");

    expect(ran(api, "pnpm deps")).toBe(1);

    await run("v2", "01C");

    expect(ran(api, "pnpm install")).toBe(2);
    expect(ran(api, "pnpm deps")).toBe(2);
  });

  test("two apps asking at once for jobs that share a base may each build it, and the snapshot that kept the name serves both", async () => {
    const api = createFakeSandboxApi();
    const platform = app(api, "platform");
    const web = app(api, "web");
    const mobile = app(api, "mobile");
    const everyone = [platform, web, mobile];

    const z = platform.job({ id: "z", cache: { key: "z" } }, async () => {
      await $`pnpm build-z`;
    });

    platform.job({ id: "y", from: z, cache: { key: "y" } }, async () => {
      await $`pnpm build-y`;
    });

    // `web` reaches `z` through `y`; `mobile` asks for `z` itself.
    const x = web.job({ id: "x", from: image.job("platform/y") }, async () => {
      await $`pnpm x`;
    });

    const w = mobile.job(
      { id: "w", from: image.job("platform/z") },
      async () => {
        await $`pnpm w`;
      },
    );

    const results = await Promise.all([
      go(web, everyone, () => x(), "01WEB"),
      go(mobile, everyone, () => w(), "01MOBILE"),
    ]);

    expect(
      results.map((result) => {
        return result.type;
      }),
    ).toEqual(["function-resolved", "function-resolved"]);

    // Best-effort across runs: both asks miss `z` together, so each may build
    // it, and at most one snapshot keeps its name. `y` is only asked for once.
    expect(ran(api, "pnpm build-z")).toBeGreaterThanOrEqual(1);
    expect(ran(api, "pnpm build-z")).toBeLessThanOrEqual(2);
    expect(ran(api, "pnpm build-y")).toBe(1);

    expect(
      [...api.snapshots.values()].filter((snapshot) => {
        return /\/z\//.test(snapshot.name ?? "");
      }),
    ).toHaveLength(1);
  });

  test("an input reaches the other app's job", async () => {
    const api = createFakeSandboxApi();
    const platform = app(api, "platform");
    const web = app(api, "web");

    platform.job("build", async (target: string) => {
      await $`pnpm build ${target}`;
    });

    const test = web.job(
      { id: "test", from: image.job("platform/build", "web") },
      async () => {
        await $`pnpm test`;
      },
    );

    const result = await go(web, [platform, web], () => test());

    expect(result.type).toBe("function-resolved");
    expect(ran(api, "pnpm build web")).toBe(1);
  });

  test("a snapshot and a job called alike are two images", async () => {
    const api = createFakeSandboxApi();
    const platform = app(api, "platform");
    const web = app(api, "web");

    platform.job("node-base", async () => {
      await $`pnpm install`;
    });

    const jobs = [
      image.job("platform/node-base"),
      image.snapshot("platform/node-base"),
    ];

    // Only the job image can be found: no snapshot has been captured.
    const results = await Promise.all(
      jobs.map((from, index) => {
        const job = web.job({ id: `test-${index}`, from }, async () => {
          await $`pnpm test`;
        });

        return go(web, [platform, web], () => job());
      }),
    );

    expect(
      results.map((result) => {
        return result.type;
      }),
    ).toEqual(["function-resolved", "function-rejected"]);
  });
});

describe("a request that can't be answered", () => {
  test.each([
    [
      "a job the other app doesn't define",
      "platform/nope",
      "defines no job `nope`",
    ],
    ["a cycle across apps", "platform/a", "starts from itself"],
  ])("fails clearly for %s", async (_label, ref, expected) => {
    const api = createFakeSandboxApi();
    const platform = app(api, "platform");
    const web = app(api, "web");

    platform.job(
      { id: "a", from: image.job("web/b"), cache: { key: "a" } },
      async () => {
        await $`pnpm a`;
      },
    );

    const b = web.job(
      { id: "b", from: image.job(ref), cache: { key: "b" } },
      async () => {
        await $`pnpm b`;
      },
    );

    const result = await go(web, [platform, web], () => b());

    expect(result.type).toBe("function-rejected");
    expect(message(result)).toContain(expected);
    expect(ran(api, "pnpm b")).toBe(0);
  });

  test("a job that reads its repository fails when the deployment doesn't say which", async () => {
    vi.mocked(deployedRepo).mockReturnValue(undefined);

    const result = await world(
      createFakeSandboxApi(),
      files("package.json"),
    ).asking("01RUN");

    expect(result.type).toBe("function-rejected");
    expect(message(result)).toContain("doesn't say which repository");
  });

  test("from another version is refused", async () => {
    const platform = app(createFakeSandboxApi(), "platform");

    platform.job("node-base", async () => {
      await $`pnpm install`;
    });

    const build = platform.functions().find((fn) => {
      // biome-ignore lint/suspicious/noExplicitAny: reaching into the SDK's internals
      return (fn as any).opts.id === cacheBuildFunctionId;
    });

    const result = await runFunction(build as NonNullable<typeof build>, {
      event: {
        name: "inngest/function.invoked",
        data: {
          jobId: "image job:platform/node-base",
          ownKey: "",
          cacheKey: "image job:platform/node-base",
          rootRunId: "01ROOT",
          resolve: {
            version: appJobRequestVersion + 1,
            job: "node-base",
            from: "web",
            chain: [],
          },
          parent: {
            runId: "01ROOT",
            pipelineId: "pr",
            jobPath: "image job:platform/node-base",
            trigger: "manual",
          },
        },
      },
    });

    expect(result.type).toBe("function-rejected");
    expect(message(result)).toContain("Update @inngest/ci in both apps");
  });
});

describe("image.job references", () => {
  test.each([["node-base"], ["/node-base"], ["platform/"], [""]])(
    "%j isn't an app/job reference",
    (ref) => {
      expect(() => {
        return image.job(ref);
      }).toThrow(/app\/job/);
    },
  );
});
