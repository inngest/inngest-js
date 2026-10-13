/**
 * Tests for `checkout()` of a local working tree that a machine already has
 * most of: delta uploads, and the tree ID carried through snapshots in their
 * metadata, run end to end against the fake sandbox API.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { consoleReporter } from "../github/auth.ts";
import { $ } from "../machine/command.ts";
import type { SnapshotMeta } from "../machine/snapshotMeta.ts";
import { snapshotMetaPath } from "../machine/snapshotMeta.ts";
import { createCi } from "../pipeline/createCi.ts";
import { createCiTestClient } from "../testing/client.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import type { FakeSandboxApi } from "../testing/fakeSandbox.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { checkout } from "./checkout.ts";
import { workingTreeId } from "./tree.ts";

const everything = ["dir/nested.txt", "edit.txt", "gone.txt", "keep.txt"];

/** The files in an uploaded tar, by reading it with the system's `tar`. */
const unpack = (bytes: Uint8Array): Record<string, string> => {
  const tar = (...args: string[]) => {
    return execFileSync("tar", args, { input: bytes, encoding: "utf8" });
  };

  const names = tar("-tf", "-")
    .split("\n")
    .filter((name) => {
      return name && !name.endsWith("/");
    });

  return Object.fromEntries(
    names.map((name) => {
      return [name, tar("-xOf", "-", name)];
    }),
  );
};

/** The uploaded tars, which are the working tree or changes to it. */
const tarballs = (api: FakeSandboxApi) => {
  return api.uploads
    .filter((upload) => {
      return upload.path.endsWith(".inngest-ci-source.tar");
    })
    .map((upload) => {
      return unpack(upload.bytes);
    });
};

/** The snapshot `base` is cached under. */
const cachedBase = (api: FakeSandboxApi) => {
  return [...api.snapshots.values()].find((candidate) => {
    return candidate.name?.includes("/base/");
  });
};

describe("checkout() of a local working tree", () => {
  let root: string;
  let repo: string;

  const write = (path: string, contents: string) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });

    writeFileSync(join(repo, path), contents);
  };

  const git = (...args: string[]) => {
    execFileSync("git", args, { cwd: repo });
  };

  /**
   * Run a pipeline over `api`, which later runs share like one environment.
   * `base` is cached and installed once, the way the example's is; `lint`
   * starts from it and checks out again.
   */
  const run = async (api: FakeSandboxApi, job: "base" | "lint") => {
    const ci = createCi(createCiTestClient(api), {
      github: consoleReporter(),
      runUrl: ({ runId }) => {
        return `http://localhost:8288/run?runID=${runId}`;
      },
    });

    const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
      await checkout();

      await $`pnpm install`;
    });

    const lint = ci.job({ id: "lint", from: base }, async () => {
      await checkout();

      await $`pnpm lint`;
    });

    await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return job === "base" ? base() : lint();
      }),
      {
        event: {
          ...prEvent,
          data: { ...prEvent.data, local: { path: repo, baseRef: "main" } },
        },
      },
    );
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ci-delta-"));
    repo = join(root, "repo");

    mkdirSync(repo);

    git("init", "-q", "-b", "main");
    git("config", "user.email", "ci@example.com");
    git("config", "user.name", "ci");

    write("keep.txt", "keep");
    write("edit.txt", "before");
    write("gone.txt", "gone");
    write("dir/nested.txt", "nested");

    git("add", ".");
    git("commit", "-q", "-m", "init");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a job that starts from a snapshot uploads only what changed since", async () => {
    const api = createFakeSandboxApi();

    await run(api, "lint");

    // The base job uploaded everything; lint found the same tree there.
    expect(tarballs(api).map(Object.keys)).toEqual([everything]);

    // The tree is kept in the cached snapshot's own metadata.
    expect(
      JSON.parse(cachedBase(api)?.files.get(snapshotMetaPath) ?? "{}"),
    ).toEqual({ treeId: await workingTreeId(repo) });

    write("edit.txt", "after");
    write("added.txt", "added");
    rmSync(join(repo, "gone.txt"));

    await run(api, "lint");

    // The base came from the cache, so only the second job uploaded: the two
    // files that were added or changed, and one command that removes the one
    // that's gone.
    expect(tarballs(api)[1]).toEqual({
      "added.txt": "added",
      "edit.txt": "after",
    });

    expect(
      api.commands
        .filter((argv) => {
          return argv.join(" ").includes("rm -f --");
        })
        .map((argv) => {
          return argv.slice(-1);
        }),
    ).toEqual([["gone.txt"]]);
  });

  test.each([
    ["a tree this machine's git has never seen", { treeId: "0".repeat(40) }],
    ["a snapshot that says nothing about its tree", {}],
  ])("%s falls back to the whole tree", async (_label, meta: SnapshotMeta) => {
    const api = createFakeSandboxApi();

    await run(api, "base");

    cachedBase(api)?.files.set(snapshotMetaPath, JSON.stringify(meta));

    write("edit.txt", "after");

    await run(api, "lint");

    expect(tarballs(api).map(Object.keys)).toEqual([everything, everything]);
  });

  test("a snapshot of a job that isn't cached carries its tree too", async () => {
    const api = createFakeSandboxApi();

    const ci = createCi(createCiTestClient(api), { github: consoleReporter() });
    const parent = ci.job("parent", checkout);

    const child = ci.job({ id: "child", from: parent }, async () => {
      write("edit.txt", "edited by the child's run");

      await checkout();
    });

    await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return child();
      }),
      {
        event: {
          ...prEvent,
          data: { ...prEvent.data, local: { path: repo, baseRef: "main" } },
        },
      },
    );

    expect(tarballs(api)[1]).toEqual({
      "edit.txt": "edited by the child's run",
    });
  });
});
