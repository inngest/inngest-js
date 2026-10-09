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

vi.mock("../github/deployRepo.ts", () => {
  return { deployedRepo: vi.fn() };
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

/** An app with its own client, on the environment `api` stands in for. */
const app = (api: Api, appId: string) => {
  const client = createCiTestClient(api, appId);

  return createCi(client, { github: consoleReporter() });
};

const ran = (api: Api, text: string): number => {
  return api.commands.filter((argv) => {
    return argv.join(" ").includes(text);
  }).length;
};

/**
 * `platform` owns a cached `node-base`, keyed on `key`, and `web` has a
 * pipeline whose `test` starts from it.
 */
const apps = (api: Api, key = "v1") => {
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

  const pipeline = web.pipeline({ id: "pr", on: prTrigger }, async () => {
    await test();
  });

  return {
    pipeline,
    functions: [...platform.functions(), ...web.functions()],
  };
};

describe("image.job()", () => {
  test("starts a job from another app's job, which that app builds once", async () => {
    const api = createFakeSandboxApi();

    for (const runId of ["01FIRST", "01SECOND"]) {
      const { pipeline, functions } = apps(api);
      const result = await runFunction(pipeline, {
        event: prEvent,
        runId,
        functions,
      });

      expect(result.type).toBe("function-resolved");
    }

    expect(ran(api, "pnpm install")).toBe(1);
    expect(ran(api, "pnpm test")).toBe(2);

    const [snapshot, ...others] = [...api.snapshots.values()];

    expect(others).toEqual([]);

    // The owner names it in the branch it was deployed from.
    expect(snapshot?.name).toMatch(/^ci\/main\/node-base\//);

    const tests = [...api.sandboxes.values()].filter((sandbox) => {
      return sandbox.snapshotId === snapshot?.id;
    });

    expect(tests).toHaveLength(2);
  });

  test("always asks the other app, which looks its job up and builds only on a miss", async () => {
    const api = createFakeSandboxApi();

    /** Machines that builds ran on, rather than pipeline jobs. */
    const builds = () => {
      return [...api.sandboxes.values()].filter((machine) => {
        return machine.name.startsWith("ci-01TESTINVOKED");
      }).length;
    };

    for (const runId of ["01COLD", "01WARM"]) {
      const { pipeline, functions } = apps(api);
      const result = await runFunction(pipeline, {
        event: prEvent,
        runId,
        functions,
      });

      expect(result.type).toBe("function-resolved");

      // The asking app can't work out the other app's snapshot names, so it
      // has no lookup of its own: every run invokes the owner.
      const asks = result.stepIds.filter((stepId) => {
        return stepId.startsWith("image ");
      });

      expect(asks).toEqual(["image job:platform/node-base"]);
    }

    // The warm run's request found the snapshot without a machine.
    expect(builds()).toBe(1);
    expect(ran(api, "pnpm install")).toBe(1);
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

      const result = await runFunction(
        web.pipeline({ id: "pr", on: prTrigger }, async () => {
          await deps();
        }),
        {
          event: prEvent,
          runId,
          functions: [...platform.functions(), ...web.functions()],
        },
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

  test("two apps asking at once for jobs that share a base build that base once", async () => {
    const api = createFakeSandboxApi();
    const platform = app(api, "platform");
    const web = app(api, "web");
    const mobile = app(api, "mobile");

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

    const functions = [
      ...platform.functions(),
      ...web.functions(),
      ...mobile.functions(),
    ];

    const [a, b] = await Promise.all([
      runFunction(
        web.pipeline({ id: "pr", on: prTrigger }, async () => {
          await x();
        }),
        { event: prEvent, runId: "01WEB", functions },
      ),
      runFunction(
        mobile.pipeline({ id: "pr", on: prTrigger }, async () => {
          await w();
        }),
        { event: prEvent, runId: "01MOBILE", functions },
      ),
    ]);

    expect(a.type).toBe("function-resolved");
    expect(b.type).toBe("function-resolved");
    expect(ran(api, "pnpm build-z")).toBe(1);
    expect(ran(api, "pnpm build-y")).toBe(1);
    expect(ran(api, "pnpm x")).toBe(1);
    expect(ran(api, "pnpm w")).toBe(1);
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

    const result = await runFunction(
      web.pipeline({ id: "pr", on: prTrigger }, async () => {
        await test();
      }),
      {
        event: prEvent,
        functions: [...platform.functions(), ...web.functions()],
      },
    );

    expect(result.type).toBe("function-resolved");
    expect(ran(api, "pnpm build web")).toBe(1);
  });

  test("a job the other app doesn't define fails clearly", async () => {
    const api = createFakeSandboxApi();
    const platform = app(api, "platform");
    const web = app(api, "web");

    const test = web.job(
      { id: "test", from: image.job("platform/nope") },
      async () => {
        await $`pnpm test`;
      },
    );

    const result = await runFunction(
      web.pipeline({ id: "pr", on: prTrigger }, async () => {
        await test();
      }),
      {
        event: prEvent,
        functions: [...platform.functions(), ...web.functions()],
      },
    );

    expect(result.type).toBe("function-rejected");
    expect(String((result.error as { message?: string })?.message)).toContain(
      "defines no job `nope`",
    );
    expect(ran(api, "pnpm test")).toBe(0);
  });

  test("a cycle across apps fails instead of asking forever", async () => {
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
      { id: "b", from: image.job("platform/a"), cache: { key: "b" } },
      async () => {
        await $`pnpm b`;
      },
    );

    const result = await runFunction(
      web.pipeline({ id: "pr", on: prTrigger }, async () => {
        await b();
      }),
      {
        event: prEvent,
        functions: [...platform.functions(), ...web.functions()],
      },
    );

    expect(result.type).toBe("function-rejected");
    expect(String((result.error as { message?: string })?.message)).toContain(
      "starts from itself",
    );
  });

  test("a job that reads its repository fails clearly when the deployment doesn't say which", async () => {
    vi.mocked(deployedRepo).mockReturnValue(undefined);

    const api = createFakeSandboxApi();
    const platform = app(api, "platform");
    const web = app(api, "web");

    platform.job(
      { id: "node-base", cache: { key: files("package.json") } },
      async () => {
        await $`pnpm install`;
      },
    );

    const test = web.job(
      { id: "test", from: image.job("platform/node-base") },
      async () => {
        await $`pnpm test`;
      },
    );

    const result = await runFunction(
      web.pipeline({ id: "pr", on: prTrigger }, async () => {
        await test();
      }),
      {
        event: prEvent,
        functions: [...platform.functions(), ...web.functions()],
      },
    );

    expect(result.type).toBe("function-rejected");
    expect(String((result.error as { message?: string })?.message)).toContain(
      "doesn't say which repository",
    );
  });

  test("a request from another version is refused", async () => {
    const api = createFakeSandboxApi();
    const platform = app(api, "platform");

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
          jobId: "image platform/node-base",
          ownKey: "",
          cacheKey: "image:platform/node-base",
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
            jobPath: "image platform/node-base",
            trigger: "manual",
          },
        },
      },
    });

    expect(result.type).toBe("function-rejected");
    expect(String((result.error as { message?: string })?.message)).toContain(
      "Update @inngest/ci in both apps",
    );
  });

  test.each([["node-base"], ["/node-base"], ["platform/"], [""]])(
    "%s isn't an app/job reference",
    (ref) => {
      expect(() => {
        return image.job(ref);
      }).toThrow(/app\/job/);
    },
  );
});
