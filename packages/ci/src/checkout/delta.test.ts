/**
 * Tests for `checkout()` of a local working tree that a machine already has
 * most of: delta uploads, and the tree ID carried through snapshots in their
 * metadata, run end to end against the fake sandbox API.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

const git = (cwd: string, ...args: string[]): string => {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
};

const event = (path: string) => {
  return {
    ...prEvent,
    data: { ...prEvent.data, local: { path, baseRef: "main" } },
  };
};

/** The files in an uploaded tar, by unpacking it with the system's `tar`. */
const unpack = (bytes: Uint8Array): Record<string, string> => {
  const dir = mkdtempSync(join(tmpdir(), "ci-delta-unpack-"));

  try {
    writeFileSync(join(dir, "in.tar"), bytes);

    mkdirSync(join(dir, "out"));

    execFileSync("tar", ["-xf", join(dir, "in.tar"), "-C", join(dir, "out")]);

    const files: Record<string, string> = {};

    const walk = (prefix: string) => {
      for (const name of readdirSync(join(dir, "out", prefix))) {
        const relative = prefix ? `${prefix}/${name}` : name;

        if (statSync(join(dir, "out", relative)).isDirectory()) {
          walk(relative);
        } else {
          files[relative] = readFileSync(join(dir, "out", relative), "utf8");
        }
      }
    };

    walk("");

    return files;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** The uploaded tars, which are the working tree or changes to it. */
const tarballs = (api: FakeSandboxApi) => {
  return api.uploads.filter((upload) => {
    return upload.path.endsWith(".inngest-ci-source.tar");
  });
};

/** The snapshot `base` is cached under, and the metadata inside it. */
const cachedBase = (api: FakeSandboxApi) => {
  const snapshot = [...api.snapshots.values()].find((candidate) => {
    return candidate.name?.includes("/base/");
  });

  const meta = JSON.parse(
    snapshot?.files.get(snapshotMetaPath) ?? "{}",
  ) as SnapshotMeta;

  /** Change what the snapshot says about itself, as another machine might. */
  const rewrite = (change: (meta: SnapshotMeta) => SnapshotMeta) => {
    snapshot?.files.set(snapshotMetaPath, JSON.stringify(change(meta)));
  };

  return { snapshot, meta, rewrite };
};

describe("checkout() of a local working tree", () => {
  let root: string;
  let repo: string;

  const write = (path: string, contents: string) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });

    writeFileSync(join(repo, path), contents);
  };

  /** A client over `api`, which later runs share like one environment. */
  const harness = (api = createFakeSandboxApi()) => {
    const ci = createCi(createCiTestClient(api), {
      github: consoleReporter(),
      runUrl: ({ runId }) => {
        return `http://localhost:8288/run?runID=${runId}`;
      },
    });

    // Installed once, the way the example's `base` does.
    const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
      await checkout();

      await $`pnpm install`;
    });

    return { api, ci, base };
  };

  /** Run `lint`, which starts from `base` and checks out again. */
  const runLint = async (api: FakeSandboxApi) => {
    const { ci, base } = harness(api);

    const lint = ci.job({ id: "lint", from: base }, async () => {
      await checkout();

      await $`pnpm lint`;
    });

    await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return lint();
      }),
      { event: event(repo) },
    );
  };

  /** Run `base` on its own, which caches it. */
  const runBase = async (api: FakeSandboxApi) => {
    const { ci, base } = harness(api);

    await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return base();
      }),
      { event: event(repo) },
    );
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ci-delta-"));
    repo = join(root, "repo");

    mkdirSync(repo);

    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "ci@example.com");
    git(repo, "config", "user.name", "ci");

    write("keep.txt", "keep");
    write("edit.txt", "before");
    write("gone.txt", "gone");
    write("dir/nested.txt", "nested");

    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a job that starts from a snapshot uploads only what changed since", async () => {
    const api = createFakeSandboxApi();

    await runLint(api);

    // The base job uploaded everything; lint found the same tree there.
    expect(tarballs(api)).toHaveLength(1);

    expect(
      Object.keys(unpack(tarballs(api)[0]?.bytes as Uint8Array)).sort(),
    ).toEqual(["dir/nested.txt", "edit.txt", "gone.txt", "keep.txt"]);

    // The tree is kept in the cached snapshot's own metadata.
    expect(cachedBase(api).meta.treeId).toBe(await workingTreeId(repo));

    write("edit.txt", "after");
    write("added.txt", "added");
    rmSync(join(repo, "gone.txt"));

    await runLint(api);

    // The base came from the cache, so only the second job uploaded: a tar of
    // the two files that were added or changed, and one command that removes
    // the one that's gone.
    expect(tarballs(api)).toHaveLength(2);

    expect(unpack(tarballs(api)[1]?.bytes as Uint8Array)).toEqual({
      "added.txt": "added",
      "edit.txt": "after",
    });

    const removals = api.commands.filter((argv) => {
      return argv.join(" ").includes("rm -f --");
    });

    expect(removals).toHaveLength(1);
    expect(removals[0]?.slice(-1)).toEqual(["gone.txt"]);
  });

  test("a snapshot of a job that isn't cached carries its tree too", async () => {
    const { api, ci } = harness();

    const parent = ci.job("parent", async () => {
      await checkout();
    });

    const child = ci.job({ id: "child", from: parent }, async () => {
      write("edit.txt", "edited by the child's run");

      await checkout();
    });

    await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return child();
      }),
      { event: event(repo) },
    );

    expect(tarballs(api)).toHaveLength(2);

    expect(unpack(tarballs(api)[1]?.bytes as Uint8Array)).toEqual({
      "edit.txt": "edited by the child's run",
    });
  });

  test.each([
    [
      "a tree this machine's git has never seen",
      (meta: SnapshotMeta) => {
        return { ...meta, treeId: "0".repeat(40) };
      },
    ],
    [
      "a snapshot that says nothing about its tree",
      (meta: SnapshotMeta) => {
        const { treeId: _dropped, ...rest } = meta;

        return rest;
      },
    ],
  ])("%s falls back to the whole tree", async (_label, change) => {
    const api = createFakeSandboxApi();

    await runBase(api);

    cachedBase(api).rewrite(change);

    write("edit.txt", "after");

    await runLint(api);

    expect(tarballs(api)).toHaveLength(2);

    expect(
      Object.keys(unpack(tarballs(api)[1]?.bytes as Uint8Array)).sort(),
    ).toEqual(["dir/nested.txt", "edit.txt", "gone.txt", "keep.txt"]);
  });
});
