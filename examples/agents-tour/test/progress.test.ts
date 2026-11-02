/**
 * @module
 * Progress through the tour server's HTTP API, the way the site calls it:
 * page states, collected concepts, module-done and Reset progress. Needs no
 * Dev Server.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { freePort } from "../scripts/lib.ts";
import { createTour } from "../server/app.ts";
import type { ProgressMark, ProgressSnapshot } from "../shared/types.ts";

const root = join(import.meta.dirname, "fixtures");
const ports = { api: 1, gateway: 2, gatewayGrpc: 3, executorGrpc: 4 };

const boot = async (cacheDir: string) => {
  const tour = await createTour({
    root,
    lessonsDir: join(root, "lessons"),
    dataDir: mkdtempSync(join(tmpdir(), "tour-data-")),
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

  return { tour, post, progress };
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

  it("survives a restart of the tour", async () => {
    const before = await current.progress();

    await current.tour.stop();
    current = await boot(cacheDir);

    assert.deepEqual(await current.progress(), before);
  });

  it("clears everything on Reset progress", async () => {
    await current.post("/api/progress/reset", {});

    const snapshot = await current.progress();

    assert.deepEqual(snapshot.pages, {});
    assert.deepEqual(snapshot.concepts, {});
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
