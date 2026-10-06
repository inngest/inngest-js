/**
 * Tests for `checkout()` of a local working tree that a machine already has
 * most of: delta uploads, the tree ID carried through snapshots and cache
 * entries, and layer snapshots, run end to end against the fake sandbox API.
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
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { memoryCacheStore } from "../cache/cache.ts";
import { consoleReporter } from "../github/auth.ts";
import { $ } from "../machine/command.ts";
import { from } from "../machine/from.ts";
import { layerThresholdBytes } from "../machine/layer.ts";
import { createCi } from "../pipeline/createCi.ts";
import { createCiTestClient } from "../testing/client.ts";
import type { FakeSandboxApi } from "../testing/fakeSandbox.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import type { CacheEntry, CacheStore } from "../types.ts";
import { checkout } from "./checkout.ts";
import { workingTreeId } from "./tree.ts";

const git = (cwd: string, ...args: string[]): string => {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
};

const event = (path: string) => {
  return {
    name: "github/pull_request.opened",
    data: {
      action: "opened",
      repository: { full_name: "inngest/inngest-js" },
      pull_request: {
        number: 7,
        head: {
          sha: "abc1234",
          ref: "feature",
          repo: { full_name: "inngest/inngest-js" },
        },
        base: { sha: "def5678", ref: "main" },
      },
      local: { path, baseRef: "main" },
    },
  };
};

const trigger = [{ event: "github/pull_request.opened" }];

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

/** How many snapshots were asked for, whatever became of them. */
const snapshotRequests = (api: FakeSandboxApi): number => {
  return api.requests.filter((request) => {
    return /^POST \/v2\/sandboxes\/[^/]+\/snapshots$/.test(request);
  }).length;
};

const deletedSnapshots = (api: FakeSandboxApi): string[] => {
  return api.requests
    .filter((request) => {
      return request.startsWith("DELETE /v2/snapshots/");
    })
    .map((request) => {
      return request.replace("DELETE /v2/snapshots/", "");
    });
};

/** A cache store that remembers what was written to it. */
const recordingStore = (): CacheStore & { written: CacheEntry[] } => {
  const inner = memoryCacheStore();
  const written: CacheEntry[] = [];

  return {
    written,
    get: inner.get,
    set: async (key, entry) => {
      written.push(entry);

      await inner.set(key, entry);
    },
  };
};

describe("checkout() of a local working tree", () => {
  let root: string;
  let repo: string;

  const write = (path: string, contents: string) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });

    writeFileSync(join(repo, path), contents);
  };

  const harness = (store: CacheStore, api = createFakeSandboxApi()) => {
    const ci = createCi(createCiTestClient(api), {
      github: consoleReporter(),
      cacheStore: store,
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
    const store = recordingStore();
    const api = createFakeSandboxApi();

    const first = harness(store, api);

    const lint = first.ci.job("lint", async () => {
      await from(first.base);

      await checkout();

      await $`pnpm lint`;
    });

    await runFunction(
      first.ci.pipeline({ id: "pr", on: trigger }, async () => {
        return lint();
      }),
      { event: event(repo) },
    );

    // The base job uploaded everything; lint found the same tree there.
    expect(tarballs(api)).toHaveLength(1);

    expect(
      Object.keys(unpack(tarballs(api)[0]?.bytes as Uint8Array)).sort(),
    ).toEqual(["dir/nested.txt", "edit.txt", "gone.txt", "keep.txt"]);

    // The tree is stored with the snapshot, in the cache entry the build wrote.
    const treeAtBuild = await workingTreeId(repo);

    expect(store.written[0]?.treeId).toBe(treeAtBuild);

    write("edit.txt", "after");
    write("added.txt", "added");
    rmSync(join(repo, "gone.txt"));

    const second = harness(store, api);

    const lint2 = second.ci.job("lint", async () => {
      await from(second.base);

      await checkout();

      await $`pnpm lint`;
    });

    await runFunction(
      second.ci.pipeline({ id: "pr", on: trigger }, async () => {
        return lint2();
      }),
      { event: event(repo) },
    );

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
    const api = createFakeSandboxApi();
    const { ci } = harness(memoryCacheStore(), api);

    const parent = ci.job("parent", async () => {
      await checkout();
    });

    const child = ci.job("child", async () => {
      await from(parent);

      write("edit.txt", "edited by the child's run");

      await checkout();
    });

    await runFunction(
      ci.pipeline({ id: "pr", on: trigger }, async () => {
        return child();
      }),
      { event: event(repo) },
    );

    expect(tarballs(api)).toHaveLength(2);

    expect(unpack(tarballs(api)[1]?.bytes as Uint8Array)).toEqual({
      "edit.txt": "edited by the child's run",
    });
  });

  test("a tree this machine's git has never seen falls back to the whole tree", async () => {
    const inner = recordingStore();
    const api = createFakeSandboxApi();

    const first = harness(inner, api);

    await runFunction(
      first.ci.pipeline({ id: "pr", on: trigger }, async () => {
        return first.base();
      }),
      { event: event(repo) },
    );

    // Another machine's cache: the entry names a tree that isn't in this
    // repository.
    const foreign: CacheStore = {
      get: async (key) => {
        const entry = await inner.get(key);

        return entry ? { ...entry, treeId: "0".repeat(40) } : entry;
      },
      set: inner.set,
    };

    write("edit.txt", "after");

    const second = harness(foreign, api);

    const lint = second.ci.job("lint", async () => {
      await from(second.base);

      await checkout();
    });

    await runFunction(
      second.ci.pipeline({ id: "pr", on: trigger }, async () => {
        return lint();
      }),
      { event: event(repo) },
    );

    expect(tarballs(api)).toHaveLength(2);

    expect(
      Object.keys(unpack(tarballs(api)[1]?.bytes as Uint8Array)).sort(),
    ).toEqual(["dir/nested.txt", "edit.txt", "gone.txt", "keep.txt"]);
  });

  test("an entry with no tree, from before trees were stored, uploads everything", async () => {
    const inner = recordingStore();
    const api = createFakeSandboxApi();

    const first = harness(inner, api);

    await runFunction(
      first.ci.pipeline({ id: "pr", on: trigger }, async () => {
        return first.base();
      }),
      { event: event(repo) },
    );

    const old: CacheStore = {
      get: async (key) => {
        const entry = await inner.get(key);

        if (!entry) {
          return entry;
        }

        const { treeId: _dropped, ...rest } = entry;

        return rest;
      },
      set: inner.set,
    };

    const second = harness(old, api);

    const lint = second.ci.job("lint", async () => {
      await from(second.base);

      await checkout();
    });

    await runFunction(
      second.ci.pipeline({ id: "pr", on: trigger }, async () => {
        return lint();
      }),
      { event: event(repo) },
    );

    expect(tarballs(api)).toHaveLength(2);
    expect(
      Object.keys(unpack(tarballs(api)[1]?.bytes as Uint8Array)),
    ).toHaveLength(4);
  });
});

describe("layer snapshots", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ci-layer-"));
    repo = join(root, "repo");

    mkdirSync(repo);

    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "ci@example.com");
    git(repo, "config", "user.name", "ci");

    writeFileSync(join(repo, "keep.txt"), "keep");

    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * A parent that checks out, then three jobs that start from it after the
   * working tree changed by `bytes`.
   */
  const runWithChange = async (bytes: number) => {
    const api = createFakeSandboxApi();

    const ci = createCi(createCiTestClient(api), {
      github: consoleReporter(),
      cacheStore: memoryCacheStore(),
      runUrl: ({ runId }) => {
        return `http://localhost:8288/run?runID=${runId}`;
      },
    });

    const parent = ci.job("parent", async () => {
      await checkout();

      await $`pnpm install`;
    });

    const child = (id: string) => {
      return ci.job(id, async () => {
        await from(parent);

        await checkout();

        await $`pnpm ${id}`;
      });
    };

    const [lint, test, compat] = [
      child("lint"),
      child("test"),
      child("compat"),
    ];

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: trigger }, async () => {
        await parent();

        // The change the children have to get onto their machines.
        const file = join(repo, "change.bin");

        writeFileSync(file, "");
        truncateSync(file, bytes);

        await Promise.all([lint(), test(), compat()]);
      }),
      { event: event(repo) },
    );

    return { api, result };
  };

  test("a large change is uploaded once and snapshotted for the other jobs", async () => {
    const { api, result } = await runWithChange(layerThresholdBytes + 1024);

    expect(result.type).toBe("function-resolved");

    // The parent's own full upload, and one upload of the change.
    expect(tarballs(api)).toHaveLength(2);

    // The parent's snapshot, and the layer.
    expect(snapshotRequests(api)).toBe(2);

    // One job started from the parent's snapshot and took the change; the
    // other two started from the layer and had nothing to upload.
    const parentSnapshot = api.snapshotStarts[0] as string;
    const layer = api.snapshotStarts.find((id) => {
      return id !== parentSnapshot;
    });

    expect(layer).toBeDefined();
    expect(
      api.snapshotStarts.filter((id) => {
        return id === parentSnapshot;
      }),
    ).toHaveLength(1);
    expect(
      api.snapshotStarts.filter((id) => {
        return id === layer;
      }),
    ).toHaveLength(2);
  });

  test("a layer is deleted when the run ends", async () => {
    const { api } = await runWithChange(layerThresholdBytes + 1024);

    const layer = api.snapshotStarts.find((id) => {
      return id !== api.snapshotStarts[0];
    }) as string;

    expect(deletedSnapshots(api)).toEqual([layer]);
    expect(api.snapshots.has(layer)).toBe(false);

    // Nothing else of the run's was a layer.
    expect(api.snapshots.size).toBe(1);
  });

  test("a small change is uploaded by each job and makes no layer", async () => {
    const { api, result } = await runWithChange(10 * 1024);

    expect(result.type).toBe("function-resolved");

    // The parent's full upload, and one small delta per job.
    expect(tarballs(api)).toHaveLength(4);

    expect(snapshotRequests(api)).toBe(1);
    expect(deletedSnapshots(api)).toEqual([]);
    expect(new Set(api.snapshotStarts).size).toBe(1);
  });
});
