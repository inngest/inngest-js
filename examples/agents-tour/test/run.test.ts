/**
 * @module
 * Run and page changes through the tour server with a real Dev Server and a
 * real app. Skipped when the Dev Server binary is not built.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { freePort, resolveBinary, root } from "../scripts/lib.ts";
import { createTour } from "../server/app.ts";
import type { Area } from "../server/area.ts";
import type { TourEvent } from "../shared/types.ts";

const binary = resolveBinary();

const post = async (base: string, path: string, body: unknown) => {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return res.status;
};

const listen = async (base: string) => {
  const events: TourEvent[] = [];
  const controller = new AbortController();
  const res = await fetch(`${base}/api/stream`, { signal: controller.signal });
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();

  void (async () => {
    let buffer = "";

    try {
      for (;;) {
        const chunk = await reader?.read();

        if (!chunk || chunk.done) {
          return;
        }

        buffer += decoder.decode(chunk.value);

        for (;;) {
          const end = buffer.indexOf("\n\n");

          if (end < 0) {
            break;
          }

          const line = buffer.slice(0, end).replace(/^data: /, "");

          buffer = buffer.slice(end + 2);
          events.push(JSON.parse(line) as TourEvent);
        }
      }
    } catch {
      // The stream was closed by the test.
    }
  })();

  return {
    events,
    stop: () => {
      controller.abort();
    },
    until: async (match: (event: TourEvent) => boolean, ms = 30_000) => {
      const end = Date.now() + ms;

      while (!events.some(match)) {
        assert.ok(Date.now() < end, "timed out waiting for a stream event");
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
      }
    },
  };
};

describe("running pages", { skip: binary === undefined }, () => {
  let base = "";
  let devServerUrl = "";
  let stop = async () => {};
  const sent: string[] = [];
  let resets = 0;

  const example: Area = {
    name: "example",
    reset: () => {
      resets += 1;
    },
    send: (start) => {
      if ("event" in start && start.event.name === "example/ping") {
        sent.push(start.event.name);

        return true;
      }

      return false;
    },
  };

  before(async () => {
    const tour = await createTour({
      root,
      lessonsDir: join(import.meta.dirname, "fixtures", "lessons"),
      dataDir: join(root, ".tour-test"),
      binary: binary as string,
      port: await freePort(),
      ports: {
        api: await freePort(),
        gateway: await freePort(),
        gatewayGrpc: await freePort(),
        executorGrpc: await freePort(),
      },
      areas: [() => example],
    });

    await tour.start();
    base = tour.url;
    stop = tour.stop;
    devServerUrl = (
      (await (await fetch(`${base}/api/info`)).json()) as {
        devServerUrl: string;
      }
    ).devServerUrl;
  });

  after(async () => {
    await stop();
  });

  const chatRuns = async () => {
    const res = await fetch(`${devServerUrl}/v0/gql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `{ runs(first: 50, orderBy: [{ field: QUEUED_AT, direction: ASC }], filter: { from: "2020-01-01T00:00:00Z" }) { edges { node { status function { name } } } } }`,
      }),
    });
    const body = (await res.json()) as {
      data: {
        runs: {
          edges: { node: { status: string; function: { name: string } } }[];
        };
      };
    };

    return body.data.runs.edges
      .map((edge) => {
        return edge.node;
      })
      .filter((run) => {
        return run.function.name === "chat";
      });
  };

  const settled = async (ms = 8000) => {
    const end = Date.now() + ms;

    for (;;) {
      const runs = await chatRuns();

      if (
        runs.every((run) => {
          return run.status === "CANCELLED";
        })
      ) {
        return runs;
      }

      assert.ok(Date.now() < end, "a run of the first page was left running");
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
    }
  };

  it("hands a start entry to the area that sends it, and resets the areas first", async () => {
    const before = resets;

    await post(base, "/api/run", { id: "live/idle" });

    assert.deepEqual(sent, ["example/ping"]);
    assert.ok(resets > before);
  });

  it("cancels a page's runs when the reader moves to another page", async () => {
    const stream = await listen(base);

    await post(base, "/api/open", { id: "live/chat" });
    await post(base, "/api/run", { id: "live/chat", files: {} });
    await stream.until((event) => {
      return (
        event.type === "runs" &&
        event.runs.some((run) => {
          return run.fn === "chat" && run.status === "RUNNING";
        })
      );
    });

    await post(base, "/api/open", { id: "live/idle" });

    const mark = stream.events.length;

    await new Promise((resolve) => {
      setTimeout(resolve, 1500);
    });
    stream.stop();

    const runs = await settled();

    assert.ok(runs.length > 0);

    for (const event of stream.events.slice(mark)) {
      if (event.type === "runs") {
        assert.deepEqual(event.runs, []);
      }

      if (event.type === "status") {
        assert.equal(event.state, "idle");
      }

      assert.notEqual(event.type, "log");
    }
  });

  it("drops a Run that is still starting when the reader moves on", async () => {
    await post(base, "/api/open", { id: "live/idle" });

    const stream = await listen(base);
    const running = post(base, "/api/run", { id: "live/chat", files: {} });

    await stream.until((event) => {
      return event.type === "status" && event.state === "starting";
    });
    await post(base, "/api/open", { id: "live/idle" });
    await running;

    const mark = stream.events.length;

    await new Promise((resolve) => {
      setTimeout(resolve, 2500);
    });
    stream.stop();

    for (const event of stream.events.slice(mark)) {
      assert.notEqual(event.type, "log");

      if (event.type === "runs") {
        assert.deepEqual(event.runs, []);
      }

      if (event.type === "status") {
        assert.equal(event.state, "idle");
      }
    }

    await settled();
  });
});
