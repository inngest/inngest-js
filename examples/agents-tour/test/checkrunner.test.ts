/**
 * @module
 * Check, through the tour server's HTTP API with a real Dev Server and app:
 * a stub fails with one sentence and a solution passes; every part of the
 * check API does its job; a check that cannot judge is reported as broken;
 * and a passed check marks the page passed. Skipped when the Dev Server
 * binary is not built.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { freePort, resolveBinary, root } from "../scripts/lib.ts";
import { createTour } from "../server/app.ts";
import type { Area } from "../server/area.ts";

const binary = resolveBinary();
const lessonsDir = join(import.meta.dirname, "fixtures", "checks");

interface Answer {
  pass: boolean;
  reason?: string;
  broken?: boolean;
}

const post = async (base: string, path: string, body: unknown) => {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return { status: res.status, body: (await res.json()) as Answer };
};

const folderOf: Record<string, string> = {
  greeter: "01-greeter",
  events: "02-events",
  posts: "03-posts",
  threads: "04-threads",
  "no-run": "05-no-run",
  "too-slow": "06-too-slow",
  "no-export": "07-no-export",
  throws: "08-throws",
};

const fileOf = (page: string, folder: string) => {
  return readFileSync(
    join(lessonsDir, "01-checks", folderOf[page] as string, folder, "agent.ts"),
    "utf8",
  );
};

describe("checking an exercise", { skip: binary === undefined }, () => {
  let base = "";
  let stop = async () => {};
  const marked: unknown[] = [];
  const progress: Area = {
    name: "progress",
    routes: [
      {
        method: "POST",
        path: "/api/progress/mark",
        handle: ({ body }) => {
          marked.push(body);

          return { ok: true };
        },
      },
    ],
  };

  const solve = (page: string) => {
    return post(base, "/api/check", {
      id: `checks/${page}`,
      files: { "agent.ts": fileOf(page, "solution") },
    });
  };

  before(async () => {
    const tour = await createTour({
      root,
      lessonsDir,
      dataDir: join(root, ".tour", "test-check"),
      binary: binary as string,
      checkTiming: { firstRunTimeoutMs: 2000 },
      areas: [() => progress],
      port: await freePort(),
      ports: {
        api: await freePort(),
        gateway: await freePort(),
        gatewayGrpc: await freePort(),
        executorGrpc: await freePort(),
      },
    });

    await tour.start();
    base = tour.url;
    stop = tour.stop;
  });

  after(async () => {
    await stop();
  });

  it("fails the stub with one sentence saying why", async () => {
    const answer = await post(base, "/api/check", {
      id: "checks/greeter",
      files: { "agent.ts": fileOf("greeter", "stub") },
    });

    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, {
      pass: false,
      reason: 'The greeter returned null, not "Hello, Ada!".',
    });
  });

  it("passes the solution, and marks the page passed", async () => {
    const before = marked.length;
    const answer = await solve("greeter");

    assert.deepEqual(answer.body, { pass: true });
    assert.deepEqual(marked.slice(before), [
      { page: "checks/greeter", state: "passed" },
    ]);
  });

  it("does not mark a page that failed", async () => {
    const before = marked.length;

    await post(base, "/api/check", {
      id: "checks/greeter",
      files: { "agent.ts": fileOf("greeter", "stub") },
    });

    assert.equal(marked.length, before);
  });

  it("sends events, presses a panel's route, and filters runs by function, leaving out the page's own start", async () => {
    assert.deepEqual((await solve("events")).body, { pass: true });
  });

  it("reads what the bot posted, after settling on a run that waits for more", async () => {
    assert.deepEqual((await solve("posts")).body, { pass: true });
  });

  it("groups runs by the thread key they were sent to", async () => {
    assert.deepEqual((await solve("threads")).body, { pass: true });
  });

  it("says so when no run ever starts, instead of judging nothing", async () => {
    assert.deepEqual((await solve("no-run")).body, {
      pass: false,
      reason: "No run started within 2 seconds.",
    });
  });

  it("gives up when the runs keep changing past the timeout", async () => {
    assert.deepEqual((await solve("too-slow")).body, {
      pass: false,
      reason: "The runs were still changing after 0.4 seconds.",
    });
  });

  it("reports a check that exports nothing as broken", async () => {
    const answer = await solve("no-export");

    assert.equal(answer.body.pass, false);
    assert.equal(answer.body.broken, true);
    assert.match(answer.body.reason ?? "", /does not export check/);
  });

  it("reports a check that throws as broken, not as the reader's failure", async () => {
    const answer = await solve("throws");

    assert.equal(answer.body.pass, false);
    assert.equal(answer.body.broken, true);
    assert.match(answer.body.reason ?? "", /Error: boom/);
  });

  it("answers that the code did not start, and never runs the check", async () => {
    const answer = await post(base, "/api/check", {
      id: "checks/greeter",
      files: { "agent.ts": 'throw new Error("no");' },
    });

    assert.deepEqual(answer.body, {
      pass: false,
      reason: "Your code did not start; see the console.",
    });
  });

  it("runs two checks one after the other, so neither cancels the other's runs", async () => {
    const [first, second] = await Promise.all([
      solve("greeter"),
      solve("greeter"),
    ]);

    assert.deepEqual(
      [first.body, second.body],
      [{ pass: true }, { pass: true }],
    );
  });

  it("answers 404 for a page that is not an exercise, and returns the solution files", async () => {
    assert.equal((await post(base, "/api/check", { id: "nope" })).status, 404);

    const res = await fetch(`${base}/api/solution?id=checks/greeter`);
    const files = (await res.json()) as { name: string; content: string }[];

    assert.deepEqual(
      files.map((file) => {
        return file.name;
      }),
      ["agent.ts"],
    );
    assert.equal(files[0]?.content, fileOf("greeter", "solution"));
  });
});
