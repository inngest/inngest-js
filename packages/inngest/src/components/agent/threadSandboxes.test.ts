/**
 * @module
 * Tests for thread-owned sandboxes: snapshot names, restore, save, the
 * pointer to the newest snapshot and the cleanup of a run that ended early.
 */
import { describe, expect, test, vi } from "vitest";
import { StepError } from "../StepError.ts";
import type { DurableSandbox, DurableSandboxTools } from "../sandbox/types.ts";
import { openSandboxes, sandbox } from "./defs.ts";
import { createKv, memoryKvAdapter } from "./kv.ts";
import { skills } from "./skills.ts";
import {
  cleanupThreadSandbox,
  threadSandboxOwner,
  threadSnapshotEntry,
} from "./threadSandboxes.ts";
import { sandboxGenerationKey } from "./threadState.ts";

interface Row {
  id: string;
  name?: string;
  status: string;
  createdAt: string;
  expiresAt: string;
}

const ref = "app/agent";
const thread = "C0123/1712.44";

const world = () => {
  const rows: Row[] = [];
  let counter = 0;
  const live = new Set<string>();

  const withDelete = (row: Row) => {
    return {
      ...row,
      delete: async () => {
        row.status = "DELETED";
      },
    };
  };
  const take = async (name?: string) => {
    if (
      name &&
      rows.some((row) => {
        return row.name === name && row.status === "READY";
      })
    ) {
      throw Object.assign(new Error("taken"), {
        code: "sandbox_snapshot_name_taken",
      });
    }

    counter += 1;

    const row: Row = {
      id: `snap-${counter}`,
      ...(name ? { name } : {}),
      status: "READY",
      createdAt: new Date(Date.now() + counter).toISOString(),
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    };
    rows.push(row);

    return row;
  };

  const client = {
    sandboxes: {
      snapshots: {
        list: async (options?: { name?: string }) => {
          return {
            items: rows
              .filter((row) => {
                return !options?.name || row.name === options.name;
              })
              .reverse()
              .map(withDelete),
            page: { hasMore: false },
          };
        },
        get: async (id: string) => {
          const row = rows.find((candidate) => {
            return candidate.id === id;
          });

          return row ? withDelete(row) : null;
        },
      },
      get: async (id: string) => {
        if (!live.has(id)) {
          return null;
        }

        return {
          snapshot: async (options: { name?: string }) => {
            return take(options.name);
          },
          destroy: async () => {
            live.delete(id);
          },
        };
      },
    },
  };

  const durable = (id: string) => {
    live.add(id);

    return {
      id,
      snapshot: vi.fn(async (_id: unknown, options: { name?: string }) => {
        return take(options.name);
      }),
      destroy: vi.fn(async () => {
        live.delete(id);
      }),
      commands: { run: vi.fn() },
      files: {},
    } as unknown as DurableSandbox;
  };

  return { rows, live, client, durable };
};

const setup = (
  w: ReturnType<typeof world>,
  runId: string,
  thatThread = thread,
) => {
  const store = createKv({ adapter: memoryKvAdapter() }).with({
    id: "app",
    env: null,
  });
  const defer = vi.fn((_id: string, _data: unknown) => {
    return { abort: vi.fn() };
  });

  return {
    store,
    scope: store.scope("thread", thatThread),
    defer,
    owner: (scope = store.scope("thread", thatThread)) => {
      return threadSandboxOwner({
        client: w.client as never,
        ref,
        thread: thatThread,
        runId,
        scope,
        run: (_id, fn) => {
          return fn();
        },
        defer,
      });
    },
  };
};

describe("threadSnapshotEntry", () => {
  test("names the snapshot under the thread scope, bounded and deterministic", async () => {
    const long = "x".repeat(500);
    const a = await threadSnapshotEntry(ref, long, "work", "01RUN");
    const b = await threadSnapshotEntry(ref, long, "work", "01RUN");
    const other = await threadSnapshotEntry(ref, "other", "work", "01RUN");

    expect(a).toEqual(b);
    expect(a.scope).toBe("thread");
    expect(a.key.length).toBeLessThan(100);
    expect(other.key).not.toBe(a.key);
    expect(a.key.startsWith(`${ref}/work/`)).toBe(true);
  });
});

describe("restore and save", () => {
  test("a thread with no snapshot gets a fresh sandbox", async () => {
    const w = world();
    const { owner } = setup(w, "01B");

    expect(await owner().restore("work")).toBeUndefined();
  });

  test("a saved sandbox is restored by the thread's next run", async () => {
    const w = world();
    const first = setup(w, "01A");
    const box = w.durable("sb-1");

    await first.owner().save("work", box);

    expect(w.rows).toHaveLength(1);
    expect(w.rows[0]?.name).toContain("thread/app/agent/work/");
    expect(w.rows[0]?.name?.endsWith("/01A")).toBe(true);
    expect(await first.scope.get(sandboxGenerationKey(ref, "work"))).toBe(
      "01A",
    );

    const next = setup(w, "01B");
    const restored = await next.owner(first.scope).restore("work");

    expect(restored).toBe(w.rows[0]?.id);
  });

  test("another thread or another sandbox name finds nothing", async () => {
    const w = world();
    const first = setup(w, "01A");

    await first.owner().save("work", w.durable("sb-1"));

    const otherThread = setup(w, "01B", "other-thread");

    expect(await otherThread.owner().restore("work")).toBeUndefined();
    expect(await first.owner().restore("data")).toBeUndefined();
  });

  test("a newer save replaces the older generation", async () => {
    const w = world();
    const first = setup(w, "01A");

    await first.owner().save("work", w.durable("sb-1"));

    const second = setup(w, "01B");

    await second.owner(first.scope).save("work", w.durable("sb-2"));

    const alive = w.rows.filter((row) => {
      return row.status === "READY";
    });

    expect(alive).toHaveLength(1);
    expect(alive[0]?.name?.endsWith("/01B")).toBe(true);
    expect(await first.scope.get(sandboxGenerationKey(ref, "work"))).toBe(
      "01B",
    );
  });

  test("an expired snapshot means a fresh sandbox", async () => {
    const w = world();
    const first = setup(w, "01A");

    await first.owner().save("work", w.durable("sb-1"));

    (w.rows[0] as Row).expiresAt = new Date(Date.now() + 60_000).toISOString();

    expect(await first.owner().restore("work")).toBeUndefined();
  });

  test("a failed snapshot is quiet and records nothing", async () => {
    const w = world();
    const first = setup(w, "01A");
    const box = w.durable("sb-1");

    (box.snapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
      new StepError("save", new Error("boom")),
    );

    await first.owner().save("work", box);

    expect(
      await first.scope.get(sandboxGenerationKey(ref, "work")),
    ).toBeUndefined();
  });

  test("the pointer never moves back to an older run", async () => {
    const w = world();
    const newer = setup(w, "01B");
    const older = setup(w, "01A");

    await newer.owner().save("work", w.durable("sb-1"));
    await older.owner(newer.scope).save("work", w.durable("sb-2"));

    expect(await newer.scope.get(sandboxGenerationKey(ref, "work"))).toBe(
      "01B",
    );
  });
});

describe("guard", () => {
  test("registers the cleanup with the sandbox's name and ID", () => {
    const w = world();
    const s = setup(w, "01A");

    s.owner().guard("work", w.durable("sb-1"), true);

    expect(s.defer).toHaveBeenCalledWith("work:thread:cleanup:save", {
      name: "work",
      sandboxId: "sb-1",
      save: true,
    });
  });
});

describe("cleanupThreadSandbox", () => {
  const cleanup = (
    w: ReturnType<typeof world>,
    s: ReturnType<typeof setup>,
    runId: string,
  ) => {
    return cleanupThreadSandbox({
      client: w.client as never,
      ref,
      thread,
      runId,
      scope: s.scope,
      sandbox: { name: "work", sandboxId: "sb-1", save: true },
      run: (_id, fn) => {
        return fn();
      },
    });
  };

  test("saves the sandbox, records the pointer and destroys it", async () => {
    const w = world();
    const s = setup(w, "01A");

    w.durable("sb-1");
    await cleanup(w, s, "01A");

    expect(w.rows).toHaveLength(1);
    expect(await s.scope.get(sandboxGenerationKey(ref, "work"))).toBe("01A");
    expect(w.live.has("sb-1")).toBe(false);
  });

  test("saves nothing when this run or a newer one already did, and still destroys", async () => {
    const w = world();
    const s = setup(w, "01B");

    await s.owner().save("work", w.durable("sb-2"));
    w.durable("sb-1");
    await cleanup(w, s, "01A");

    expect(w.rows).toHaveLength(1);
    expect(w.live.has("sb-1")).toBe(false);
  });

  test("a late cleanup never deletes the snapshot of a newer run", async () => {
    const w = world();
    const s = setup(w, "01B");

    w.durable("sb-1");
    await s.owner().save("work", w.durable("sb-2"));
    // The check passed before the newer run saved: the pointer is read stale.
    await s.scope.delete(sandboxGenerationKey(ref, "work"));
    await cleanup(w, s, "01A");

    expect(
      w.rows.filter((row) => {
        return row.status === "READY";
      }),
    ).toHaveLength(2);
  });

  test("a sandbox not cleared to be saved is destroyed without a snapshot", async () => {
    const w = world();
    const s = setup(w, "01A");

    w.durable("sb-1");
    await cleanupThreadSandbox({
      client: w.client as never,
      ref,
      thread,
      runId: "01A",
      scope: s.scope,
      sandbox: { name: "work", sandboxId: "sb-1", save: false },
      run: (_id, fn) => {
        return fn();
      },
    });

    expect(w.rows).toHaveLength(0);
    expect(w.live.has("sb-1")).toBe(false);
  });

  test("does nothing for a sandbox that is already gone", async () => {
    const w = world();
    const s = setup(w, "01A");

    await cleanup(w, s, "01A");

    expect(w.rows).toHaveLength(0);
  });
});

describe("lazy sandboxes of a thread", () => {
  const box = sandbox({ id: "box" });

  const open = (w: ReturnType<typeof world>, s: ReturnType<typeof setup>) => {
    const created: { options: unknown }[] = [];
    const tools = {
      create: vi.fn(async (_id: unknown, options: unknown) => {
        created.push({ options });

        return w.durable(`sb-${created.length}`);
      }),
    } as unknown as DurableSandboxTools;

    return {
      created,
      opened: openSandboxes({ work: box }, tools, undefined, s.owner()),
    };
  };

  test("save at close, restore in the next run, nothing when unused", async () => {
    const w = world();
    const first = setup(w, "01A");
    const one = open(w, first);

    await one.opened.work?.get();
    await one.opened.work?.close();

    expect(w.rows).toHaveLength(1);
    expect(first.defer).toHaveBeenCalledTimes(2);

    const unused = open(w, setup(w, "01B"));

    await unused.opened.work?.close();

    expect(unused.created).toHaveLength(0);
    expect(w.rows).toHaveLength(1);

    const second = setup(w, "01C");
    const next = openSandboxes(
      { work: box },
      {
        create: vi.fn(async (_id: unknown, options: unknown) => {
          expect(options).toMatchObject({ snapshotId: w.rows[0]?.id });

          return w.durable("sb-9");
        }),
      } as unknown as DurableSandboxTools,
      undefined,
      second.owner(first.scope),
    );

    await next.work?.get();
    expect((next.work as unknown as { started: boolean }).started).toBe(true);
  });

  test("setup still runs after a restore", async () => {
    const w = world();
    const first = setup(w, "01A");
    const setups: string[] = [];
    const withSetup = sandbox({
      id: "box",
      setup: async ({ name }) => {
        setups.push(name);
      },
    });
    const runtime = {
      event: {},
      client: w.client,
      run: (_id: string, fn: () => Promise<unknown>) => {
        return fn();
      },
      sendEvent: async () => {},
    } as never;
    const tools = {
      create: vi.fn(async () => {
        return w.durable("sb-x");
      }),
    } as unknown as DurableSandboxTools;

    await first.owner().save("work", w.durable("sb-0"));

    const next = openSandboxes(
      { work: withSetup },
      tools,
      runtime,
      setup(w, "01B").owner(first.scope),
    );

    await next.work?.get();

    expect(tools.create).toHaveBeenCalledWith(
      "work",
      expect.objectContaining({ snapshotId: w.rows[0]?.id }),
    );
    expect(setups).toEqual(["work"]);
  });

  test("a failed setup keeps the last good snapshot for the next run", async () => {
    const w = world();
    const first = setup(w, "01A");
    const seen: boolean[] = [];
    const failing = sandbox({
      id: "box",
      setup: async ({ restored }) => {
        seen.push(restored);

        throw new Error("setup failed");
      },
    });
    const runtime = {
      event: {},
      client: w.client,
      run: (_id: string, fn: () => Promise<unknown>) => {
        return fn();
      },
      sendEvent: async () => {},
    } as never;
    const tools = {
      create: vi.fn(async () => {
        return w.durable("sb-x");
      }),
    } as unknown as DurableSandboxTools;

    await first.owner().save("work", w.durable("sb-0"));

    const goodId = w.rows[0]?.id;
    const second = setup(w, "01B");
    const next = openSandboxes(
      { work: failing },
      tools,
      runtime,
      second.owner(first.scope),
    );

    await expect(next.work?.get()).rejects.toThrow("setup failed");
    await next.work?.close();

    expect(seen).toEqual([true]);
    expect(w.rows).toHaveLength(1);
    expect(await first.scope.get(sandboxGenerationKey(ref, "work"))).toBe(
      "01A",
    );
    expect(await setup(w, "01C").owner(first.scope).restore("work")).toBe(
      goodId,
    );
  });

  test("a setup keeps the sandbox unsaveable until it has finished", async () => {
    const w = world();
    const s = setup(w, "01A");
    const runtime = {
      event: {},
      client: w.client,
      run: (_id: string, fn: () => Promise<unknown>) => {
        return fn();
      },
      sendEvent: async () => {},
    } as never;
    const tools = {
      create: vi.fn(async () => {
        return w.durable("sb-x");
      }),
    } as unknown as DurableSandboxTools;
    const failing = openSandboxes(
      {
        work: sandbox({
          id: "bad",
          setup: async () => {
            throw new Error("nope");
          },
        }),
      },
      tools,
      runtime,
      s.owner(),
    );

    await expect(failing.work?.get()).rejects.toThrow("nope");
    expect(s.defer.mock.calls.map((call) => call[1])).toEqual([
      { name: "work", sandboxId: "sb-x", save: false },
    ]);

    const ok = openSandboxes(
      { work: sandbox({ id: "good", setup: async () => {} }) },
      tools,
      runtime,
      s.owner(),
    );

    await ok.work?.get();
    expect(s.defer.mock.calls.at(-1)?.[1]).toEqual({
      name: "work",
      sandboxId: "sb-x",
      save: true,
    });
  });

  test("a failed skills fetch leaves a cleanup armed that cannot save", async () => {
    const w = world();
    const s = setup(w, "01A");
    const broken = w.durable("sb-x");

    (broken.commands.run as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("fetch failed"),
    );

    const opened = openSandboxes(
      {
        work: sandbox({
          id: "skilled",
          skills: [skills.git("a/b", { freshness: "boot", into: "/skills/a" })],
        }),
      },
      { create: vi.fn(async () => broken) } as unknown as DurableSandboxTools,
      {
        event: {},
        client: w.client,
        run: (_id: string, fn: () => Promise<unknown>) => {
          return fn();
        },
        sendEvent: async () => {},
      } as never,
      s.owner(),
    );

    await expect(opened.work?.get()).rejects.toThrow("fetch failed");
    expect(s.defer.mock.calls.map((call) => call[1])).toEqual([
      { name: "work", sandboxId: "sb-x", save: false },
    ]);
  });
});
