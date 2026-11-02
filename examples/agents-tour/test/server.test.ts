/**
 * @module
 * The tour server through its HTTP API, the way the site calls it. Needs no
 * Dev Server: the server is listening, nothing else is started.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { freePort } from "../scripts/lib.ts";
import { createTour } from "../server/app.ts";
import type { Area } from "../server/area.ts";
import { HttpError } from "../server/http-error.ts";
import type { Page, TourIndex } from "../shared/types.ts";

const root = join(import.meta.dirname, "fixtures");
const lessonsDir = join(root, "lessons");

const ports = { api: 1, gateway: 2, gatewayGrpc: 3, executorGrpc: 4 };

const exampleArea = (resets: { count: number }): Area => {
  return {
    name: "example",
    routes: [
      {
        method: "GET",
        path: "/api/example",
        handle: () => {
          return { hello: "from the example area", resets: resets.count };
        },
      },
      {
        method: "GET",
        path: "/api/example/teapot",
        handle: () => {
          throw new HttpError(418, { error: "I am a teapot" });
        },
      },
    ],
    raw: (req, res) => {
      if (req.url !== "/example-raw") {
        return false;
      }

      res.writeHead(200, { "content-type": "text/plain" });
      res.end("raw answer");

      return true;
    },
    replay: () => {
      return [{ type: "area", area: "example", topic: "ready" }];
    },
    reset: () => {
      resets.count += 1;
    },
  };
};

describe("the tour server", () => {
  let base = "";
  let stop = async () => {};
  let broadcast: (topic: string) => void = () => {};
  const resets = { count: 0 };

  before(async () => {
    const tour = await createTour({
      root,
      lessonsDir,
      binary: "unused",
      port: await freePort(),
      ports,
      areas: [
        (ctx) => {
          broadcast = (topic) => {
            ctx.hub.broadcast({ type: "area", area: "example", topic });
          };

          return exampleArea(resets);
        },
      ],
    });

    await tour.listen();
    base = tour.url;
    stop = tour.stop;
  });

  after(async () => {
    await stop();
  });

  const getJson = async <T>(path: string) => {
    return (await (await fetch(base + path)).json()) as T;
  };

  const status = (headers: Record<string, string>, path = "/api/index") => {
    const { port } = new URL(base);

    return new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });

      req.on("error", reject);
      req.end();
    });
  };

  it("lists modules with a title, an opening line and labelled pages", async () => {
    const index = await getJson<TourIndex>("/api/index");
    const first = index.modules[0];

    assert.equal(first?.title, "First");
    assert.equal(first?.opening, "A fixture module.");
    assert.deepEqual(
      first?.pages.map((page) => {
        return [page.label, page.kind];
      }),
      [
        ["1", "core"],
        ["2", "core"],
        ["2a", "deeper"],
        ["3", "core"],
      ],
    );
  });

  it("shows the read-only files a page names, found per module then tour-wide", async () => {
    const hello = await getJson<Page>("/api/page?id=first/hello");

    assert.deepEqual(
      hello.files.map((file) => {
        return [file.name, file.editable, file.content.trim()];
      }),
      [
        ["agent.ts", true, "export const hello = 1;"],
        ["setup.ts", false, "export const moduleWide = true;"],
      ],
    );
    assert.deepEqual(hello.manifest.concepts, ["agent"]);
    assert.deepEqual(hello.manifest.apis, ["agents.agent"]);

    const more = await getJson<Page>("/api/page?id=first/more");

    assert.deepEqual(
      more.files.map((file) => {
        return [file.name, file.editable];
      }),
      [
        ["agent.ts", true],
        ["tools.ts", true],
        ["client.ts", false],
      ],
    );
  });

  it("starts an exercise from its stub and sends neither the solution nor server paths", async () => {
    const page = await getJson<Page>("/api/page?id=first/exercise");
    const text = JSON.stringify(page);

    assert.equal(
      page.files[0]?.content.trim(),
      'export const answer = "stub";',
    );
    assert.ok(!text.includes('answer = \\"solution'));
    assert.ok(!text.includes('"dir"'));
    assert.ok(!text.includes("exerciseFiles"));
    assert.ok(!text.includes(import.meta.dirname));
  });

  it("answers an unknown page with 404 and the error in JSON", async () => {
    const res = await fetch(`${base}/api/page?id=nope/nope`);

    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "No such page" });
  });

  it("answers a route that throws an HttpError with its status", async () => {
    const res = await fetch(`${base}/api/example/teapot`);

    assert.equal(res.status, 418);
    assert.deepEqual(await res.json(), { error: "I am a teapot" });
  });

  it("serves the routes of an area added from outside", async () => {
    const answer = await getJson<{ hello: string }>("/api/example");

    assert.equal(answer.hello, "from the example area");
  });

  it("lets an area answer a request outside /api/ itself", async () => {
    const res = await fetch(`${base}/example-raw`);

    assert.equal(await res.text(), "raw answer");
  });

  it("serves the fakes' own REST routes, not the site", async () => {
    const slack = await fetch(`${base}/slack/api/auth.test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const github = await fetch(`${base}/github/repos/acme/web/pulls/1`);

    for (const res of [slack, github]) {
      assert.match(res.headers.get("content-type") ?? "", /json/);
    }
  });

  it("catches a new browser up with an area's replay and carries its later events", async () => {
    const res = await fetch(`${base}/api/stream`);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let seen = "";

    while (!seen.includes('"topic":"ready"')) {
      seen += decoder.decode((await reader?.read())?.value);
    }

    broadcast("later");

    while (!seen.includes('"topic":"later"')) {
      seen += decoder.decode((await reader?.read())?.value);
    }

    await reader?.cancel();
  });

  it("resets every area when a page is opened", async () => {
    const before = resets.count;
    const res = await fetch(`${base}/api/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "first/hello" }),
    });

    assert.equal(res.status, 200);
    assert.equal(resets.count, before + 1);
  });

  it("accepts the loopback names a browser may use and refuses other hosts", async () => {
    const { port } = new URL(base);

    for (const host of [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ]) {
      assert.equal(await status({ host }), 200, host);
    }

    for (const host of [`evil.example:${port}`, "localhost:1", "localhost"]) {
      assert.equal(await status({ host }), 403, host);
    }
  });

  it("accepts a browser's own origin and refuses any other", async () => {
    const { port } = new URL(base);
    const host = `localhost:${port}`;

    for (const origin of [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
    ]) {
      assert.equal(await status({ host, origin }), 200, origin);
    }

    for (const origin of [
      "http://evil.example",
      `http://localhost:${port + 1}`,
      `https://localhost:${port}`,
    ]) {
      assert.equal(await status({ host, origin }), 403, origin);
    }
  });

  it("takes only JSON in a POST to /api", async () => {
    const res = await fetch(`${base}/api/open`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });

    assert.equal(res.status, 415);
  });

  it("formats code with the repo's Biome, and hands back what it cannot format", async () => {
    const post = async (body: unknown) => {
      return (await (
        await fetch(`${base}/api/format`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json()) as { content: string; ok: boolean };
    };

    assert.deepEqual(
      await post({ name: "agent.ts", content: "export const a   =  1" }),
      { content: "export const a = 1;\n", ok: true },
    );
    assert.deepEqual(
      await post({ name: "agent.ts", content: "export const (" }),
      {
        content: "export const (",
        ok: false,
      },
    );

    const bad = await fetch(`${base}/api/format`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: 1 }),
    });

    assert.equal(bad.status, 400);
  });
});

describe("loading areas", () => {
  const options = {
    root,
    lessonsDir,
    binary: "unused",
    ports,
  };

  it("refuses two areas that answer the same route", async () => {
    const twin = (): Area => {
      return {
        name: "twin",
        routes: [{ method: "GET", path: "/api/index", handle: () => ({}) }],
      };
    };

    await assert.rejects(
      createTour({
        ...options,
        port: await freePort(),
        areas: [twin],
      }),
      /already taken/,
    );
  });

  it("refuses an area file that does not export area", async () => {
    const dir = mkdtempSync(join(tmpdir(), "areas-"));

    writeFileSync(join(dir, "oops.ts"), "export const other = 1;\n");

    await assert.rejects(
      createTour({ ...options, port: await freePort(), areasDir: dir }),
      /areas\/oops.ts must export area/,
    );
  });
});
