/**
 * @module
 * The tour server through its HTTP API, the way the site calls it. Needs no
 * Dev Server: the server is listening, nothing else is started.
 */
import assert from "node:assert/strict";
import { request } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { freePort } from "../scripts/lib.ts";
import { createTour } from "../server/app.ts";
import type { Area } from "../server/area.ts";
import type { Page, TourIndex } from "../shared/types.ts";

const root = join(import.meta.dirname, "fixtures");

const exampleArea: Area = {
  name: "example",
  routes: [
    {
      method: "GET",
      path: "/api/example",
      handle: () => {
        return { hello: "from the example area" };
      },
    },
  ],
  replay: () => {
    return [{ type: "area", area: "example", topic: "ready" }];
  },
};

describe("the tour server", () => {
  let base = "";
  let stop = async () => {};

  before(async () => {
    const port = await freePort();
    const tour = await createTour({
      root,
      lessonsDir: join(root, "lessons"),
      binary: "unused",
      port,
      ports: { api: 1, gateway: 2, gatewayGrpc: 3, executorGrpc: 4 },
      areas: [() => exampleArea],
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

  it("starts an exercise from its stub and keeps the solution back", async () => {
    const page = await getJson<Page>("/api/page?id=first/exercise");

    assert.equal(page.exercise, true);
    assert.equal(
      page.files[0]?.content.trim(),
      'export const answer = "stub";',
    );
    assert.ok(!JSON.stringify(page).includes('answer = \\"solution'));
  });

  it("serves the routes of an area added from outside", async () => {
    assert.deepEqual(await getJson("/api/example"), {
      hello: "from the example area",
    });

    const res = await fetch(`${base}/api/stream`);
    const reader = res.body?.getReader();
    const chunk = new TextDecoder().decode((await reader?.read())?.value);

    await reader?.cancel();
    assert.match(chunk, /"topic":"ready"/);
  });

  const statusWithHost = (host: string) => {
    const { port } = new URL(base);

    return new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/index",
          headers: { host },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );

      req.on("error", reject);
      req.end();
    });
  };

  it("accepts the loopback names a browser may use and refuses other hosts", async () => {
    const { port } = new URL(base);

    for (const host of [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ]) {
      assert.equal(await statusWithHost(host), 200, host);
    }

    for (const host of [`evil.example:${port}`, "localhost:1", "localhost"]) {
      assert.equal(await statusWithHost(host), 403, host);
    }
  });
});
