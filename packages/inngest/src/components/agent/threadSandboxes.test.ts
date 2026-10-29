/**
 * @module
 * Tests for thread-owned sandboxes: snapshot names, restore, save, the
 * pointer to the newest snapshot and the cleanup of a run that ended early.
 */
import { describe, expect, test, vi } from "vitest";
import { StepError } from "../StepError.ts";
import type { DurableSandbox, DurableSandboxTools } from "../sandbox/types.ts";
import { openSandboxes, sandbox } from "./defs.ts";
import { createKv, type KvScopeInstance, memoryKvAdapter } from "./kv.ts";
import { skills } from "./skills.ts";
import {
  cleanupThreadSandbox,
  sandboxGeneration,
  threadSandboxOwner,
  threadSnapshotEntry,
} from "./threadSandboxes.ts";
import {
  newestSandboxGeneration,
  runScore,
  sandboxReadyKey,
} from "./threadState.ts";

interface Row {
  id: string;
  name?: string;
  status: string;
  createdAt: string;
  expiresAt: string;
}

const ref = "app/agent";
const thread = "C0123/1712.44";

const newest = (scope: KvScopeInstance) => {
  return newestSandboxGeneration(scope, ref, "work");
};

const world = () => {
  const rows: Row[] = [];
  const calls: string[] = [];
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
          calls.push(options?.name ? "list:name" : "list:all");

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

  return { rows, live, calls, client, durable };
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
  test("names the snapshot under the thread scope, bounded and deterministic", () => {
    const long = "x".repeat(500);
    const a = threadSnapshotEntry(ref, long, "work", "01RUN");
    const b = threadSnapshotEntry(ref, long, "work", "01RUN");
    const other = threadSnapshotEntry(ref, "other", "work", "01RUN");

    expect(a).toEqual(b);
    expect(a.scope).toBe("thread");
    expect(a.key.length).toBeLessThan(100);
    expect(other.key).not.toBe(a.key);
    expect(a.key.startsWith(`${ref}/work/`)).toBe(true);
    expect(a.key.split("/").at(-1)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("runScore", () => {
  test("reads the time of a ULID and scores anything else 0", () => {
    expect(runScore("01M6094CS5BE09H3Z2G0GN5J3D")).toBeGreaterThan(1.7e12);
    expect(runScore("01M6094CS5BE09H3Z2G0GN5J3D")).toBeLessThan(
      runScore("01M6094FQ6QBAQR6PWMRAM8RAG"),
    );
    expect(runScore("not a ulid")).toBe(0);
  });
});

describe("restore and save", () => {
  test("a thread with no snapshot gets a fresh sandbox", async () => {
    const w = world();
    const { owner } = setup(w, "01B");

    expect(await owner().restore("work")).toEqual([]);
  });

  test("a saved sandbox is restored by the thread's next run", async () => {
    const w = world();
    const first = setup(w, "01A");
    const box = w.durable("sb-1");

    await first.owner().save("work", box);

    expect(w.rows).toHaveLength(1);
    expect(w.rows[0]?.name).toContain("thread/app/agent/work/");
    expect(w.rows[0]?.name?.endsWith("/01A")).toBe(true);
    expect(await newest(first.scope)).toBe("01A");

    const next = setup(w, "01B");
    const restored = await next.owner(first.scope).restore("work");

    expect(restored).toEqual([w.rows[0]?.id]);
  });

  test("another thread or another sandbox name finds nothing", async () => {
    const w = world();
    const first = setup(w, "01A");

    await first.owner().save("work", w.durable("sb-1"));

    const otherThread = setup(w, "01B", "other-thread");

    expect(await otherThread.owner().restore("work")).toEqual([]);
    expect(await first.owner().restore("data")).toEqual([]);
  });

  test("a save deletes generations older than the previous one by name, without listing every snapshot", async () => {
    const w = world();
    const first = setup(w, "01A");

    await first.owner().save("work", w.durable("sb-1"));
    await setup(w, "01B").owner(first.scope).save("work", w.durable("sb-2"));

    // The previous generation stays as a spare for a run restoring from it.
    expect(
      w.rows
        .filter((row) => {
          return row.status === "READY";
        })
        .map((row) => {
          return row.name?.split("/").at(-1);
        }),
    ).toEqual(["01A", "01B"]);

    w.calls.length = 0;
    await setup(w, "01C").owner(first.scope).save("work", w.durable("sb-3"));

    const alive = w.rows.filter((row) => {
      return row.status === "READY";
    });

    expect(
      alive.map((row) => {
        return row.name?.split("/").at(-1);
      }),
    ).toEqual(["01B", "01C"]);
    expect(await newest(first.scope)).toBe("01C");
    expect(
      w.calls.every((call) => {
        return call !== "list:all";
      }),
    ).toBe(true);
  });

  test("an expired snapshot means a fresh sandbox", async () => {
    const w = world();
    const first = setup(w, "01A");

    await first.owner().save("work", w.durable("sb-1"));

    (w.rows[0] as Row).expiresAt = new Date(Date.now() + 60_000).toISOString();

    expect(await first.owner().restore("work")).toEqual([]);
  });

  test("a failed snapshot is quiet and records nothing", async () => {
    const w = world();
    const first = setup(w, "01A");
    const box = w.durable("sb-1");

    (box.snapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
      new StepError("save", new Error("boom")),
    );

    await first.owner().save("work", box);

    expect(await newest(first.scope)).toBeUndefined();
  });

  test("the newest generation never moves back to an older run, in either order", async () => {
    for (const order of [
      ["01A", "01B"],
      ["01B", "01A"],
    ] as const) {
      const w = world();
      const base = setup(w, "01Z");
      const owners = order.map((id) => {
        return setup(w, id).owner(base.scope);
      });

      await Promise.all(
        owners.map((owner, index) => {
          return owner.save("work", w.durable(`sb-${index}`));
        }),
      );

      expect(await newest(base.scope)).toBe("01B");
      expect((await base.owner().restore("work")).length).toBeGreaterThan(0);
    }
  });
});

describe("guard and ready", () => {
  test("one cleanup per sandbox, told its name and ID", () => {
    const w = world();
    const s = setup(w, "01A");

    s.owner().guard("work", w.durable("sb-1"));

    expect(s.defer).toHaveBeenCalledTimes(1);
    expect(s.defer).toHaveBeenCalledWith("work:thread:cleanup", {
      name: "work",
      sandboxId: "sb-1",
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
      sandbox: { name: "work", sandboxId: "sb-1" },
      run: (_id, fn) => {
        return fn();
      },
    });
  };

  test("saves a ready sandbox, records the generation and destroys it", async () => {
    const w = world();
    const s = setup(w, "01A");

    w.durable("sb-1");
    await s.owner().ready("work");
    await cleanup(w, s, "01A");

    expect(w.rows).toHaveLength(1);
    expect(await newest(s.scope)).toBe("01A");
    expect(w.live.has("sb-1")).toBe(false);
  });

  test("saves nothing when this run or a newer one already did, and still destroys", async () => {
    const w = world();
    const s = setup(w, "01B");

    await s.owner().save("work", w.durable("sb-2"));
    w.durable("sb-1");
    await s.owner().ready("work");
    await cleanup(w, s, "01B");

    expect(w.rows).toHaveLength(1);
    expect(w.live.has("sb-1")).toBe(false);
  });

  test("a late cleanup never deletes the snapshot of a newer run", async () => {
    const w = world();
    const newer = setup(w, "01B");
    const older = setup(w, "01A");

    w.durable("sb-1");
    await older.owner(newer.scope).ready("work");
    await newer.owner().save("work", w.durable("sb-2"));
    await cleanupThreadSandbox({
      client: w.client as never,
      ref,
      thread,
      runId: "01A",
      scope: newer.scope,
      sandbox: { name: "work", sandboxId: "sb-1" },
      run: (_id, fn) => {
        return fn();
      },
    });

    const alive = w.rows.filter((row) => {
      return row.status === "READY";
    });

    expect(alive).toHaveLength(1);
    expect(alive[0]?.name?.endsWith("/01B")).toBe(true);
    expect(await newest(newer.scope)).toBe("01B");
  });

  test("a sandbox not marked ready is destroyed without a snapshot", async () => {
    const w = world();
    const s = setup(w, "01A");

    w.durable("sb-1");
    await cleanup(w, s, "01A");

    expect(w.rows).toHaveLength(0);
    expect(w.live.has("sb-1")).toBe(false);
  });

  test("a sandbox marked ready by an earlier run is not saved by this one", async () => {
    const w = world();
    const s = setup(w, "01A");

    w.durable("sb-1");
    await s.owner().ready("work");
    await cleanup(w, s, "01B");

    expect(w.rows).toHaveLength(0);
  });

  test("a newer run marking its sandbox ready does not stop an older cleanup from saving", async () => {
    const w = world();
    const older = setup(w, "01A");
    const newer = setup(w, "01B");

    w.durable("sb-1");
    await older.owner().ready("work");
    await newer.owner(older.scope).ready("work");
    await cleanup(w, older, "01A");

    expect(w.rows).toHaveLength(1);
    expect(w.rows[0]?.name?.endsWith("/01A")).toBe(true);
  });

  test("a run that released or cleaned up leaves no ready key behind", async () => {
    const w = world();
    const s = setup(w, "01A");

    await s.owner().ready("work");
    await s.owner().save("work", w.durable("sb-1"));
    await s.owner().release("work");
    expect(
      await s.scope.get(sandboxReadyKey(ref, "work", "01A")),
    ).toBeUndefined();

    const later = setup(w, "01C");

    await later.owner(s.scope).ready("work");
    w.durable("sb-2");
    await cleanupThreadSandbox({
      client: w.client as never,
      ref,
      thread,
      runId: "01C",
      scope: s.scope,
      sandbox: { name: "work", sandboxId: "sb-2" },
      run: (_id, fn) => {
        return fn();
      },
    });
    expect(
      await s.scope.get(sandboxReadyKey(ref, "work", "01C")),
    ).toBeUndefined();
  });

  test("a cleanup that saves nothing still forgets the ready key", async () => {
    const w = world();
    const s = setup(w, "01B");

    await s.owner().save("work", w.durable("sb-2"));
    await s.owner().ready("work");
    w.durable("sb-1");
    await cleanupThreadSandbox({
      client: w.client as never,
      ref,
      thread,
      runId: "01B",
      scope: s.scope,
      sandbox: { name: "work", sandboxId: "sb-1" },
      run: (_id, fn) => {
        return fn();
      },
    });

    expect(
      await s.scope.get(sandboxReadyKey(ref, "work", "01B")),
    ).toBeUndefined();
  });

  test("a failed save keeps the ready key until the run releases it, so the cleanup can still save", async () => {
    const w = world();
    const s = setup(w, "01A");
    const box = w.durable("sb-1");

    (box.snapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
      new StepError("save", new Error("boom")),
    );
    await s.owner().ready("work");
    await s.owner().save("work", box);

    expect(await s.scope.get(sandboxReadyKey(ref, "work", "01A"))).toBe(true);
  });

  test("a failing delete of the ready key never fails the save", async () => {
    const w = world();
    const s = setup(w, "01A");
    const failing = {
      ...s.scope,
      delete: async () => {
        throw new StepError("kv.delete", new Error("boom"));
      },
    } as KvScopeInstance;

    await s.owner(failing).ready("work");
    await expect(
      s.owner(failing).save("work", w.durable("sb-1")),
    ).resolves.toBe(true);
    expect(await newest(s.scope)).toBe("01A");
  });

  test("does nothing for a sandbox that is already gone", async () => {
    const w = world();
    const s = setup(w, "01A");

    await s.owner().ready("work");
    await cleanup(w, s, "01A");

    expect(w.rows).toHaveLength(0);
  });
});

describe("lazy sandboxes of a thread", () => {
  const box = sandbox({ id: "box" });
  const runtimeOf = (w: ReturnType<typeof world>) => {
    return {
      event: {},
      client: w.client,
      run: (_id: string, fn: () => Promise<unknown>) => {
        return fn();
      },
      sendEvent: async () => {},
    } as never;
  };

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
    expect(first.defer).toHaveBeenCalledTimes(1);

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

  test("an eager sandbox nothing used is not marked ready, so a cancelled run does not save it", async () => {
    const w = world();
    const s = setup(w, "01A");
    const opened = openSandboxes(
      { work: { sandbox: box, start: "eager" } },
      {
        create: vi.fn(async () => {
          return w.durable("sb-1");
        }),
      } as unknown as DurableSandboxTools,
      undefined,
      s.owner(),
    );

    // Let the eager create finish without anything using the sandbox.
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    await cleanupThreadSandbox({
      client: w.client as never,
      ref,
      thread,
      runId: "01A",
      scope: s.scope,
      sandbox: { name: "work", sandboxId: "sb-1" },
      run: (_id, fn) => {
        return fn();
      },
    });

    expect(opened.work?.started).toBe(true);
    expect(w.rows).toHaveLength(0);
    expect(w.live.has("sb-1")).toBe(false);
  });

  test("keepAlive does nothing yet: the sandbox is saved and destroyed like any other", async () => {
    const w = world();
    const s = setup(w, "01A");
    const tools = {
      create: vi.fn(async () => {
        return w.durable("sb-1");
      }),
    } as unknown as DurableSandboxTools;
    const opened = openSandboxes(
      { work: { sandbox: box, keepAlive: { idle: "10m" } } },
      tools,
      undefined,
      s.owner(),
    );

    await opened.work?.get();
    await opened.work?.close();

    expect(w.rows).toHaveLength(1);
    expect(w.live.has("sb-1")).toBe(false);
  });

  test("an owner that keeps a keepAlive sandbox leaves it running and drops its cleanup", async () => {
    const w = world();
    const s = setup(w, "01A");
    const abort = vi.fn();
    const keep = vi.fn(async () => {
      return true;
    });
    const owner = {
      ...s.owner(),
      keep,
      guard: () => {
        return { abort };
      },
    };
    const tools = {
      create: vi.fn(async () => {
        return w.durable("sb-1");
      }),
    } as unknown as DurableSandboxTools;
    const opened = openSandboxes(
      { work: { sandbox: box, keepAlive: { idle: "10m" } } },
      tools,
      undefined,
      owner,
    );

    await opened.work?.get();
    await opened.work?.close();

    expect(keep).toHaveBeenCalledWith(
      "work",
      expect.anything(),
      { idle: "10m" },
      expect.objectContaining({ abort: expect.any(Function) }),
    );
    // The sandbox is saved before it is kept, so the thread keeps its state.
    expect(w.rows).toHaveLength(1);
    expect(w.live.has("sb-1")).toBe(true);
  });

  test("a keep that declines, or a sandbox that is unused, falls back to save and destroy or just destroy", async () => {
    const w = world();
    const s = setup(w, "01A");
    const keep = vi.fn(async () => {
      return false;
    });
    const tools = {
      create: vi.fn(async () => {
        return w.durable("sb-1");
      }),
    } as unknown as DurableSandboxTools;
    const used = openSandboxes(
      { work: { sandbox: box, keepAlive: { idle: "10m" } } },
      tools,
      undefined,
      { ...s.owner(), keep },
    );

    await used.work?.get();
    await used.work?.close();

    expect(keep).toHaveBeenCalledTimes(1);
    expect(w.rows).toHaveLength(1);
    expect(w.live.has("sb-1")).toBe(false);

    const unused = openSandboxes(
      { work: { sandbox: box, keepAlive: { idle: "10m" }, start: "eager" } },
      tools,
      undefined,
      { ...setup(w, "01B").owner(), keep },
    );

    await unused.work?.close();

    expect(keep).toHaveBeenCalledTimes(1);
    expect(w.rows).toHaveLength(1);
  });

  test("a keep that fails for good counts as declined", async () => {
    const w = world();
    const s = setup(w, "01A");
    const tools = {
      create: vi.fn(async () => {
        return w.durable("sb-1");
      }),
    } as unknown as DurableSandboxTools;
    const opened = openSandboxes(
      { work: { sandbox: box, keepAlive: { idle: "10m" } } },
      tools,
      undefined,
      {
        ...s.owner(),
        keep: async () => {
          throw new StepError("keep", new Error("boom"));
        },
      },
    );

    await opened.work?.get();
    await opened.work?.close();

    expect(w.rows).toHaveLength(1);
    expect(w.live.has("sb-1")).toBe(false);
  });

  test("a keep that returns anything but true, or throws, or returns a plain boolean, is handled", async () => {
    const run = async (keep: () => unknown) => {
      const w = world();
      const s = setup(w, "01A");
      const failed: unknown[] = [];
      const opened = openSandboxes(
        { work: { sandbox: box, keepAlive: { idle: "10m" } } },
        {
          create: vi.fn(async () => {
            return w.durable("sb-1");
          }),
        } as unknown as DurableSandboxTools,
        undefined,
        {
          ...s.owner(),
          keep: keep as never,
          keepFailed: (_name: string, error: unknown) => {
            failed.push(error);
          },
        },
      );

      await opened.work?.get();
      await opened.work?.close();

      return { live: w.live.has("sb-1"), failed };
    };

    // A truthy value that is not `true` is declined.
    expect(await run(() => "yes")).toEqual({ live: false, failed: [] });

    // A throw is declined and reported.
    const threw = await run(() => {
      throw new Error("bad hook");
    });

    expect(threw.live).toBe(false);
    expect(threw.failed).toHaveLength(1);

    // A plain boolean, not a promise, is accepted.
    expect((await run(() => true)).live).toBe(true);
  });

  test("a restore whose newest snapshot is gone tries the next newest before going fresh", async () => {
    const w = world();
    const first = setup(w, "01A");

    await first.owner().save("work", w.durable("sb-1"));
    await setup(w, "01B").owner(first.scope).save("work", w.durable("sb-2"));

    const [newest, spare] = (
      await setup(w, "01C").owner(first.scope).restore("work")
    ).map((id) => {
      return w.rows
        .find((row) => {
          return row.id === id;
        })
        ?.name?.split("/")
        .at(-1);
    });

    expect([newest, spare]).toEqual(["01B", "01A"]);

    const tried: string[] = [];
    const tools = {
      create: vi.fn(async (_id: unknown, options: unknown) => {
        const { snapshotId } = options as { snapshotId?: string };

        if (snapshotId) {
          tried.push(snapshotId);
        }

        if (snapshotId === w.rows[1]?.id) {
          throw Object.assign(new StepError("work", new Error("gone")), {
            cause: { code: "sandbox_snapshot_not_found" },
          });
        }

        return w.durable("sb-x");
      }),
    } as unknown as DurableSandboxTools;
    const warned: string[] = [];
    const opened = openSandboxes({ work: box }, tools, undefined, {
      ...setup(w, "01C").owner(first.scope),
      restoreFailed: (name: string) => {
        warned.push(name);
      },
    });

    await opened.work?.get();

    expect(tried).toEqual([w.rows[1]?.id, w.rows[0]?.id]);
    expect(warned).toEqual(["work"]);
  });

  test("a failed save together with a failed destroy keeps the ready key for the cleanup", async () => {
    const w = world();
    const s = setup(w, "01A");
    const box1 = w.durable("sb-1");

    (box1.snapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
      new StepError("save", new Error("boom")),
    );
    (box1.destroy as ReturnType<typeof vi.fn>).mockRejectedValue(
      new StepError("destroy", new Error("boom")),
    );

    const opened = openSandboxes(
      { work: box },
      {
        create: vi.fn(async () => {
          return box1;
        }),
      } as unknown as DurableSandboxTools,
      undefined,
      s.owner(),
    );

    await opened.work?.get();
    await opened.work?.close();

    expect(await s.scope.get(sandboxReadyKey(ref, "work", "01A"))).toBe(true);
  });

  test("close releases the ready key on the way out", async () => {
    const w = world();
    const s = setup(w, "01A");
    const opened = openSandboxes(
      { work: box },
      {
        create: vi.fn(async () => {
          return w.durable("sb-1");
        }),
      } as unknown as DurableSandboxTools,
      undefined,
      s.owner(),
    );

    await opened.work?.get();
    expect(await s.scope.get(sandboxReadyKey(ref, "work", "01A"))).toBe(true);

    await opened.work?.close();
    expect(
      await s.scope.get(sandboxReadyKey(ref, "work", "01A")),
    ).toBeUndefined();
  });

  test("a sandbox that was created but never used is destroyed without a snapshot", async () => {
    const w = world();
    const s = setup(w, "01A");
    const tools = {
      create: vi.fn(async () => {
        return w.durable("sb-1");
      }),
    } as unknown as DurableSandboxTools;
    const opened = openSandboxes(
      { work: { sandbox: box, start: "eager" } },
      tools,
      undefined,
      s.owner(),
    );

    await opened.work?.close();

    expect(tools.create).toHaveBeenCalledTimes(1);
    expect(w.rows).toHaveLength(0);
    expect(w.live.has("sb-1")).toBe(false);
  });

  test("a restore creates from the snapshot with only what the platform takes alongside it", async () => {
    const w = world();
    const first = setup(w, "01A");
    const full = sandbox({
      id: "full",
      vcpu: 4,
      memoryMb: 4096,
      environment: { A: "1" },
      secrets: ["TOKEN"],
    });
    const tools = {
      create: vi.fn(async () => {
        return w.durable("sb-x");
      }),
    } as unknown as DurableSandboxTools;

    await first.owner().save("work", w.durable("sb-0"));

    const next = openSandboxes(
      { work: full },
      tools,
      undefined,
      setup(w, "01B").owner(first.scope),
    );

    await next.work?.get();

    expect(tools.create).toHaveBeenCalledWith("work", {
      name: expect.any(String),
      snapshotId: w.rows[0]?.id,
    });
  });

  test("a restore whose snapshot is gone falls back to a fresh sandbox and says so", async () => {
    const w = world();
    const first = setup(w, "01A");
    const warned: string[] = [];
    const seen: (boolean | undefined)[] = [];
    const withSetup = sandbox({
      id: "box",
      setup: async ({ restored }) => {
        seen.push(restored);
      },
    });
    const calls: unknown[] = [];
    const tools = {
      create: vi.fn(async (_id: unknown, options: unknown) => {
        calls.push(options);

        if ((options as { snapshotId?: string }).snapshotId) {
          throw Object.assign(new StepError("work", new Error("not found")), {
            cause: { code: "sandbox_snapshot_not_found" },
          });
        }

        return w.durable("sb-x");
      }),
    } as unknown as DurableSandboxTools;

    await first.owner().save("work", w.durable("sb-0"));

    const next = openSandboxes({ work: withSetup }, tools, runtimeOf(w), {
      ...setup(w, "01B").owner(first.scope),
      restoreFailed: (name: string) => {
        warned.push(name);
      },
    });

    await next.work?.get();

    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toHaveProperty("snapshotId");
    expect(warned).toEqual(["work"]);
    expect(seen).toEqual([false]);
  });

  test("any other failure of the restore create fails the run instead of dropping the thread's state", async () => {
    const w = world();
    const first = setup(w, "01A");
    const tools = {
      create: vi.fn(async () => {
        throw new StepError("work", new Error("platform unavailable"));
      }),
    } as unknown as DurableSandboxTools;

    await first.owner().save("work", w.durable("sb-0"));

    const next = openSandboxes(
      { work: box },
      tools,
      undefined,
      setup(w, "01B").owner(first.scope),
    );

    await expect(next.work?.get()).rejects.toThrow("platform unavailable");
    expect(tools.create).toHaveBeenCalledTimes(1);
  });

  test("setup still runs after a restore and is told so", async () => {
    const w = world();
    const first = setup(w, "01A");
    const seen: (boolean | undefined)[] = [];
    const withSetup = sandbox({
      id: "box",
      setup: async ({ restored }) => {
        seen.push(restored);
      },
    });
    const tools = {
      create: vi.fn(async () => {
        return w.durable("sb-x");
      }),
    } as unknown as DurableSandboxTools;

    await first.owner().save("work", w.durable("sb-0"));

    const next = openSandboxes(
      { work: withSetup },
      tools,
      runtimeOf(w),
      setup(w, "01B").owner(first.scope),
    );

    await next.work?.get();

    expect(tools.create).toHaveBeenCalledWith(
      "work",
      expect.objectContaining({ snapshotId: w.rows[0]?.id }),
    );
    expect(seen).toEqual([true]);
  });

  test("a failed setup keeps the last good snapshot for the next run", async () => {
    const w = world();
    const first = setup(w, "01A");
    const failing = sandbox({
      id: "box",
      setup: async () => {
        throw new Error("setup failed");
      },
    });
    const tools = {
      create: vi.fn(async () => {
        return w.durable("sb-x");
      }),
    } as unknown as DurableSandboxTools;

    await first.owner().save("work", w.durable("sb-0"));

    const goodId = w.rows[0]?.id;
    const next = openSandboxes(
      { work: failing },
      tools,
      runtimeOf(w),
      setup(w, "01B").owner(first.scope),
    );

    await expect(next.work?.get()).rejects.toThrow("setup failed");
    await next.work?.close();

    expect(w.rows).toHaveLength(1);
    expect(await newest(first.scope)).toBe("01A");
    expect(await setup(w, "01C").owner(first.scope).restore("work")).toEqual([
      goodId,
    ]);
  });

  test("the cleanup may save only after setup finished, with one cleanup registered", async () => {
    const w = world();
    const s = setup(w, "01A");
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
      runtimeOf(w),
      s.owner(),
    );

    await expect(failing.work?.get()).rejects.toThrow("nope");
    expect(
      await s.scope.get(sandboxReadyKey(ref, "work", "01A")),
    ).toBeUndefined();

    const ok = openSandboxes(
      { work: sandbox({ id: "good", setup: async () => {} }) },
      tools,
      runtimeOf(w),
      s.owner(),
    );

    await ok.work?.get();
    expect(await s.scope.get(sandboxReadyKey(ref, "work", "01A"))).toBe(true);
    expect(s.defer).toHaveBeenCalledTimes(2);
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
      runtimeOf(w),
      s.owner(),
    );

    await expect(opened.work?.get()).rejects.toThrow("fetch failed");
    expect(
      s.defer.mock.calls.map((call) => {
        return call[1];
      }),
    ).toEqual([{ name: "work", sandboxId: "sb-x" }]);
    expect(
      await s.scope.get(sandboxReadyKey(ref, "work", "01A")),
    ).toBeUndefined();
  });
});

describe("recycling a lazy sandbox", () => {
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

  test("saves and destroys now, and the next get restores from that snapshot", async () => {
    const w = world();
    const s = setup(w, "01A");
    const { created, opened } = open(w, s);

    await opened.work?.get();
    await opened.work?.recycle();

    expect(w.rows).toHaveLength(1);
    expect([...w.live]).toEqual([]);

    await opened.work?.get();

    expect(created).toHaveLength(2);
    expect(created[1]?.options).toMatchObject({ snapshotId: w.rows[0]?.id });
    expect([...w.live]).toEqual(["sb-2"]);

    await opened.work?.close();

    // Each save is a later generation of the run, and the newest is the last.
    expect(w.rows).toHaveLength(2);
    expect(await newest(s.scope)).toBe("01A.000001");
    expect([...w.live]).toEqual([]);
  });

  test("each sandbox gets a cleanup defer of its own, and the recycled one's is aborted", async () => {
    const w = world();
    const s = setup(w, "01A");
    const { opened } = open(w, s);

    await opened.work?.get();
    const [first] = s.defer.mock.results;
    await opened.work?.recycle();
    await opened.work?.get();

    expect(s.defer.mock.calls.map((call) => call[0])).toEqual([
      "work:thread:cleanup",
      "work:thread:cleanup:g1",
    ]);
    expect(s.defer.mock.calls[1]?.[1]).toMatchObject({ epoch: 1 });
    expect(first?.value.abort).toHaveBeenCalledTimes(1);
  });

  test("an eager sandbox nothing used is destroyed without a snapshot", async () => {
    const w = world();
    const s = setup(w, "01A");
    const eager = openSandboxes(
      { work: { sandbox: sandbox({ id: "eager" }), start: "eager" } },
      {
        create: vi.fn(async () => {
          return w.durable("sb-1");
        }),
      } as unknown as DurableSandboxTools,
      undefined,
      s.owner(),
    );

    await Promise.resolve();
    await vi.waitFor(() => {
      expect(eager.work?.started).toBe(true);
    });
    await eager.work?.recycle();

    expect(w.rows).toHaveLength(0);
    expect([...w.live]).toEqual([]);
  });

  test("a recycle whose snapshot failed keeps the sandbox running and says so", async () => {
    const w = world();
    const s = setup(w, "01A");
    const { opened } = open(w, s);
    const sandboxNow = await opened.work?.get();

    (sandboxNow?.snapshot as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new StepError("sb:save", new Error("snapshot failed")),
    );

    await expect(opened.work?.recycle()).rejects.toThrow(/still running/);
    expect([...w.live]).toEqual(["sb-1"]);
    expect(await opened.work?.get()).toBe(sandboxNow);
  });

  test("a recycle whose destroy failed keeps the sandbox and says so", async () => {
    const w = world();
    const s = setup(w, "01A");
    const { opened } = open(w, s);
    const sandboxNow = await opened.work?.get();

    (sandboxNow?.destroy as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new StepError("sb:destroy", new Error("destroy failed")),
    );

    await expect(opened.work?.recycle()).rejects.toThrow(
      /could not be destroyed/,
    );
    expect(await opened.work?.get()).toBe(sandboxNow);
  });

  test("after a failed destroy the next save is a later generation, not a reuse of the first", async () => {
    const w = world();
    const s = setup(w, "01A");
    const { opened } = open(w, s);
    const sandboxNow = await opened.work?.get();

    (sandboxNow?.destroy as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new StepError("sb:destroy", new Error("destroy failed")),
    );

    await expect(opened.work?.recycle()).rejects.toThrow(
      /could not be destroyed/,
    );
    await opened.work?.close();

    // The snapshot taken before the failed destroy, and a new one from close.
    expect(w.rows).toHaveLength(2);
    expect(await newest(s.scope)).toBe("01A.000001");
  });

  test("after a failed destroy the sandbox's cleanup saves what it writes next as a later generation", async () => {
    const w = world();
    const s = setup(w, "01A");
    const { opened } = open(w, s);
    const sandboxNow = await opened.work?.get();

    (sandboxNow?.destroy as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new StepError("sb:destroy", new Error("destroy failed")),
    );

    await expect(opened.work?.recycle()).rejects.toThrow(
      /could not be destroyed/,
    );

    expect(s.defer.mock.calls.map((call) => call[0])).toEqual([
      "work:thread:cleanup",
      "work:thread:cleanup:g1",
    ]);

    // The run dies now: the new cleanup, not the old one, handles the sandbox.
    await s.scope.set(sandboxReadyKey(ref, "work", "01A"), true);
    await cleanupThreadSandbox({
      client: w.client as never,
      ref,
      thread,
      runId: "01A",
      scope: s.scope,
      sandbox: s.defer.mock.calls[1]?.[1] as never,
      run: (_id, fn) => {
        return fn();
      },
    });

    expect(await newest(s.scope)).toBe("01A.000001");
    expect(w.rows).toHaveLength(2);
  });

  test("a sandbox that belongs to no thread cannot be recycled", async () => {
    const w = world();
    const opened = openSandboxes({ work: box }, {
      create: vi.fn(async () => {
        return w.durable("sb-1");
      }),
    } as unknown as DurableSandboxTools);

    await opened.work?.get();

    await expect(opened.work?.recycle()).rejects.toThrow(
      /doesn't belong to a thread/,
    );
  });

  test("a close during a recycle waits for it", async () => {
    const w = world();
    const s = setup(w, "01A");
    const { opened } = open(w, s);

    await opened.work?.get();
    const recycled = opened.work?.recycle();
    const closed = opened.work?.close();

    await Promise.all([recycled, closed]);

    // The recycled sandbox was saved once; the new one was never created.
    expect(w.rows).toHaveLength(1);
    expect([...w.live]).toEqual([]);
  });

  test("generations keep their order past a thousand epoch", () => {
    expect(sandboxGeneration("01A", 999) < sandboxGeneration("01A", 1000)).toBe(
      true,
    );
    expect(sandboxGeneration("01A", 0) < sandboxGeneration("01A", 1)).toBe(
      true,
    );
  });

  test("does nothing before a sandbox exists, and a recycle after close does nothing", async () => {
    const w = world();
    const s = setup(w, "01A");
    const { created, opened } = open(w, s);

    await opened.work?.recycle();
    expect(created).toHaveLength(0);

    await opened.work?.get();
    await opened.work?.close();
    await opened.work?.recycle();

    expect(w.rows).toHaveLength(1);
  });

  test("a get during a recycle waits for it and gets the restored sandbox", async () => {
    const w = world();
    const s = setup(w, "01A");
    const { created, opened } = open(w, s);

    await opened.work?.get();
    const recycled = opened.work?.recycle();
    const again = opened.work?.get();

    await recycled;
    const sandboxAfter = await again;

    expect(sandboxAfter?.id).toBe("sb-2");
    expect(created[1]?.options).toMatchObject({ snapshotId: w.rows[0]?.id });
  });

  test("a cleanup of a recycled sandbox saves as the later generation", async () => {
    const w = world();
    const s = setup(w, "01A");
    const { opened } = open(w, s);

    await opened.work?.get();
    await opened.work?.recycle();
    await opened.work?.get();
    await s.scope.set(sandboxReadyKey(ref, "work", "01A"), true);

    await cleanupThreadSandbox({
      client: w.client as never,
      ref,
      thread,
      runId: "01A",
      scope: s.scope,
      sandbox: { name: "work", sandboxId: "sb-2", epoch: 1 },
      run: (_id, fn) => {
        return fn();
      },
    });

    expect(await newest(s.scope)).toBe("01A.000001");
    expect(w.rows).toHaveLength(2);
    expect([...w.live]).toEqual([]);
  });
});
