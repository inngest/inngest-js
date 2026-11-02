/**
 * @module
 * Progress through the tour server's HTTP API, the way the site calls it:
 * page states, collected concepts, module-done and Reset progress. Needs no
 * Dev Server.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { freePort } from "../scripts/lib.ts";
import { createTour } from "../server/app.ts";
import type { ProgressMark, ProgressSnapshot } from "../shared/types.ts";

const root = join(import.meta.dirname, "fixtures");
const ports = { api: 1, gateway: 2, gatewayGrpc: 3, executorGrpc: 4 };

const boot = async (
  cacheDir: string,
  dataDir = mkdtempSync(join(tmpdir(), "tour-data-")),
) => {
  const tour = await createTour({
    root,
    lessonsDir: join(root, "lessons"),
    dataDir,
    cacheDir,
    binary: "unused",
    port: await freePort(),
    ports,
  });

  await tour.listen();

  const post = async <T>(path: string, body: object) => {
    const res = await fetch(tour.url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    return (await res.json()) as T;
  };

  const progress = async () => {
    return (await (
      await fetch(`${tour.url}/api/progress`)
    ).json()) as ProgressSnapshot;
  };

  // The next event of the given type on the event stream, the way the site
  // listens for it.
  const nextEvent = async (type: string, act: () => Promise<unknown>) => {
    const controller = new AbortController();

    const res = await fetch(`${tour.url}/api/stream`, {
      signal: controller.signal,
    });

    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    const timer = setTimeout(() => {
      controller.abort();
    }, 3000);
    let text = "";

    await act();

    try {
      while (reader) {
        const { value, done } = await reader.read();

        if (done) {
          break;
        }

        text += decoder.decode(value);

        for (const line of text.split("\n\n")) {
          if (line.startsWith("data: ") && line.includes(`"type":"${type}"`)) {
            return JSON.parse(line.slice(6)) as Record<string, unknown>;
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`No ${type} event arrived within 3 s`);
      }

      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }

    throw new Error(`No ${type} event arrived`);
  };

  return { tour, post, progress, nextEvent, dataDir };
};

describe("progress", () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "tour-cache-"));
  let current: Awaited<ReturnType<typeof boot>>;

  before(async () => {
    current = await boot(cacheDir);
  });

  after(async () => {
    await current.tour.stop();
  });

  it("starts empty, with every concept of the tour counted", async () => {
    const snapshot = await current.progress();

    assert.deepEqual(snapshot.pages, {});
    assert.deepEqual(snapshot.concepts, {});
    assert.equal(snapshot.totalConcepts, 2);
  });

  it("records opened, ran and passed on a page", async () => {
    await current.post("/api/progress/mark", {
      page: "first/hello",
      state: "opened",
    });
    await current.post("/api/progress/mark", {
      page: "first/hello",
      state: "ran",
    });

    assert.deepEqual((await current.progress()).pages["first/hello"], {
      opened: true,
      ran: true,
    });
  });

  it("collects a concept the first time its page opens, with its definition", async () => {
    const mark = await current.post<ProgressMark>("/api/progress/mark", {
      page: "first/hello",
      state: "opened",
    });

    assert.deepEqual(mark.collected, []);

    const snapshot = await current.progress();

    assert.deepEqual(snapshot.concepts, {
      agent: {
        page: "first/hello",
        definition: "A function that holds conversations.",
      },
    });
  });

  it("collects a Go deeper page's concepts on opening it", async () => {
    const mark = await current.post<ProgressMark>("/api/progress/mark", {
      page: "first/deeper",
      state: "opened",
    });

    assert.deepEqual(mark.collected, ["inbox"]);
  });

  it("finishes a module when its exercise passes", async () => {
    const early = await current.post<ProgressMark>("/api/progress/mark", {
      page: "first/hello",
      state: "passed",
    });

    assert.equal(early.moduleDone, null);

    const done = await current.post<ProgressMark>("/api/progress/mark", {
      page: "first/exercise",
      state: "passed",
    });

    assert.equal(done.moduleDone, "first");
  });

  it("tells the site about a finished module on the event stream", async () => {
    const event = await current.nextEvent("progress", () => {
      return current.post("/api/progress/mark", {
        page: "first/exercise",
        state: "passed",
      });
    });

    assert.deepEqual(event.mark, { collected: [], moduleDone: "first" });
    assert.equal(event.page, "first/exercise");
  });

  it("tells the site on the event stream when progress is reset", async () => {
    await current.post("/api/progress/mark", {
      page: "first/hello",
      state: "opened",
    });

    const event = await current.nextEvent("progress", () => {
      return current.post("/api/progress/reset", {});
    });

    assert.deepEqual(event.mark, { collected: [], moduleDone: null });
    assert.deepEqual((await current.progress()).pages, {});
  });

  it("does not collect a page's concepts when it only ran", async () => {
    await current.post("/api/progress/reset", {});

    await current.post("/api/progress/mark", {
      page: "first/hello",
      state: "ran",
    });

    assert.deepEqual((await current.progress()).concepts, {});
  });

  it("does not finish a module when a page that is not its exercise passes", async () => {
    await current.post("/api/progress/reset", {});

    const mark = await current.post<ProgressMark>("/api/progress/mark", {
      page: "first/hello",
      state: "passed",
    });

    assert.equal(mark.moduleDone, null);
  });

  it("refuses a state it does not know", async () => {
    const res = await fetch(`${current.tour.url}/api/progress/mark`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: "first/hello", state: "mastered" }),
    });

    assert.equal(res.status, 400);
  });

  it("survives a restart that wipes the data folder", async () => {
    await current.post("/api/progress/mark", {
      page: "first/hello",
      state: "opened",
    });

    const before = await current.progress();

    assert.ok(existsSync(join(cacheDir, "progress.json")));
    assert.ok(!existsSync(join(current.dataDir, "progress.json")));

    for (let restart = 0; restart < 2; restart += 1) {
      await current.tour.stop();
      current = await boot(cacheDir, current.dataDir);

      assert.deepEqual(await current.progress(), before);
    }
  });

  it("clears everything on Reset progress, and stays cleared after a restart", async () => {
    await current.post("/api/progress/reset", {});

    const snapshot = await current.progress();

    assert.deepEqual(snapshot.pages, {});
    assert.deepEqual(snapshot.concepts, {});

    await current.tour.stop();
    current = await boot(cacheDir, current.dataDir);

    assert.deepEqual((await current.progress()).pages, {});
  });

  it("makes the cache folder when it does not exist yet", async () => {
    const fresh = join(mkdtempSync(join(tmpdir(), "tour-fresh-")), "a", "b");
    const other = await boot(fresh);

    try {
      const mark = await other.post<ProgressMark>("/api/progress/mark", {
        page: "first/hello",
        state: "opened",
      });

      assert.deepEqual(mark.collected, ["agent"]);
    } finally {
      await other.tour.stop();
    }
  });

  it("starts empty from a progress file of the wrong shape", async () => {
    for (const content of ["[]", "null", '{"pages":5,"concepts":[]}', "{"]) {
      const dir = mkdtempSync(join(tmpdir(), "tour-bad-"));

      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "progress.json"), content);

      const other = await boot(dir);

      try {
        assert.deepEqual((await other.progress()).pages, {});

        const mark = await other.post<ProgressMark>("/api/progress/mark", {
          page: "first/hello",
          state: "opened",
        });

        assert.deepEqual(mark.collected, ["agent"]);
      } finally {
        await other.tour.stop();
      }
    }
  });

  it("refuses a page it does not know", async () => {
    const res = await fetch(`${current.tour.url}/api/progress/mark`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: "nope/nope", state: "opened" }),
    });

    assert.equal(res.status, 404);
  });
});
