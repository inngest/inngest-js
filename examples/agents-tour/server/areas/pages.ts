/**
 * @module
 * Pages and runs: opening a page, pressing Run, killing and resetting, the
 * app's output, and the runs the Dev Server reports. It writes the page's
 * files, restarts the reader's app, sends the page's start entries and polls
 * the runs into the event stream.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Start, TraceRun } from "../../shared/types.ts";
import type { Area, AreaFactory } from "../area.ts";
import { HttpError } from "../http-error.ts";
import type { LoadedPage } from "../lessons.ts";
import { cancelRun, readOutput, readRuns, terminal } from "../runs.ts";
import { readTypes } from "../types.ts";

export const area: AreaFactory = (ctx) => {
  const { hub, devServer, worker, dataDir, publicUrl } = ctx;
  const byId = new Map<string, LoadedPage>(
    ctx.pages.map((page) => {
      return [page.id, page];
    }),
  );
  let runs: TraceRun[] = [];
  let from = new Date().toISOString();
  let generation = 0;
  // Bumped when the runs on screen are cleared, so a poll that started
  // before cannot bring them back.
  let epoch = 0;
  let running: Promise<void> = Promise.resolve();
  // Identifies the page the reader is on. Opening a page ends the one before,
  // and anything the old page's Run still has to do is dropped.
  let session = 0;
  // Set once a Run has sent something that may have started a run.
  let mayBeLive = false;

  const poll = async () => {
    if (hub.status.state === "idle" || hub.clients.size === 0) {
      return;
    }

    const seen = epoch;

    try {
      const next = await readRuns(devServer, from);

      if (seen !== epoch) {
        return;
      }

      if (JSON.stringify(next) !== JSON.stringify(runs)) {
        runs = next;
        hub.broadcast({ type: "runs", runs });
      }
    } catch {
      // The Dev Server is restarting; the next tick tries again.
    }
  };

  setInterval(poll, 300).unref();

  const clearRuns = () => {
    epoch += 1;
    from = new Date().toISOString();
    hub.emit({ type: "clear" });
    runs = [];
    hub.broadcast({ type: "runs", runs });
  };

  const writeLesson = (page: LoadedPage, files: Record<string, string>) => {
    generation += 1;

    const dir = join(dataDir, "run", `gen-${generation}`);

    mkdirSync(dir, { recursive: true });

    for (const file of page.files) {
      // Read-only files always come from disk, never from the browser.
      const content = file.editable
        ? (files[file.name] ?? file.content)
        : file.content;

      writeFileSync(join(dir, file.name), content);
    }

    if (generation > 3) {
      rmSync(join(dataDir, "run", `gen-${generation - 3}`), {
        recursive: true,
        force: true,
      });
    }

    return dir;
  };

  const sendStart = async (start: Start) => {
    if ("event" in start) {
      await devServer.send(start.event.name, start.event.data);
      hub.info(`sent event ${start.event.name}`);

      return;
    }

    if ("agent" in start) {
      await worker.send(start.agent, start.thread, start.text);
      hub.info(`sent "${start.text}" to ${start.agent}`);

      return;
    }

    throw new Error("No area sends this start entry");
  };

  const cancelOnce = async () => {
    const seen = await readRuns(devServer, from).catch(() => {
      return runs;
    });

    for (const run of seen) {
      if (!terminal.has(run.status)) {
        await cancelRun(devServer, run.id).catch(() => {});
      }
    }
  };

  // Cancels every run of the page since it was opened, asking the Dev Server
  // rather than trusting the last poll. After a Run sent something, looks a
  // second time for runs the Dev Server had not made yet.
  const cancelLive = async () => {
    await cancelOnce();

    if (mayBeLive) {
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });

      await cancelOnce();

      mayBeLive = false;
    }
  };

  const run = (id: string, files: Record<string, string>) => {
    session += 1;

    const mine = session;
    const stale = () => {
      return mine !== session;
    };
    const task = running.then(async () => {
      const page = byId.get(id);

      if (!page || page.manifest.code === false || stale()) {
        return;
      }

      await cancelLive();

      if (stale()) {
        return;
      }

      clearRuns();
      await ctx.resetAreas();
      hub.setStatus("starting", "Starting your code...");

      const started = Date.now();
      const dir = writeLesson(page, files);
      const result = await worker.reload(
        dir,
        page.files.map((file) => {
          return file.name;
        }),
      );

      if (stale()) {
        worker.stop();

        return;
      }

      if (!result.ok) {
        hub.emit({
          type: "log",
          kind: "err",
          text: result.error ?? "The app did not start",
        });
        hub.setStatus("failed", "Your code did not start");

        return;
      }

      try {
        await worker.sync(publicUrl);
      } catch (error) {
        if (!stale()) {
          hub.emit({ type: "log", kind: "err", text: String(error) });
          hub.setStatus("failed", "The Dev Server did not accept the app");
        }

        return;
      }

      if (stale()) {
        return;
      }

      hub.info(`started in ${Date.now() - started} ms`);
      hub.setStatus("live", "Live");

      for (const start of page.manifest.start ?? []) {
        if (stale()) {
          return;
        }

        mayBeLive = true;

        try {
          const sent = await Promise.all(
            ctx.areas().map((other) => {
              return other.send?.(start) ?? false;
            }),
          );

          if (!sent.some(Boolean)) {
            await sendStart(start);
          }
        } catch (error) {
          if (!stale()) {
            hub.emit({ type: "log", kind: "err", text: String(error) });
          }
        }
      }
    });

    running = task.catch(() => {});

    return task;
  };

  const result: Area = {
    name: "pages",
    replay: () => {
      return [{ type: "runs", runs }];
    },
    routes: [
      {
        method: "GET",
        path: "/api/index",
        handle: () => {
          return ctx.index;
        },
      },
      {
        method: "GET",
        path: "/api/page",
        handle: ({ url }) => {
          const page = byId.get(url.searchParams.get("id") ?? "");

          if (!page) {
            throw new HttpError(404, { error: "No such page" });
          }

          const { dir: _dir, exerciseFiles: _exerciseFiles, ...rest } = page;

          return rest;
        },
      },
      {
        method: "GET",
        path: "/api/info",
        handle: () => {
          return { devServerUrl: devServer.url };
        },
      },
      {
        method: "GET",
        path: "/api/types",
        handle: () => {
          return readTypes(ctx.root);
        },
      },
      {
        method: "GET",
        path: "/api/output",
        handle: ({ url }) => {
          return readOutput(devServer, url.searchParams.get("id") ?? "");
        },
      },
      {
        method: "POST",
        path: "/api/open",
        handle: async () => {
          session += 1;
          worker.abortStarting();

          await running;
          await cancelLive();

          clearRuns();
          await ctx.resetAreas();
          hub.setStatus("idle", "Ready");

          return { ok: true };
        },
      },
      {
        method: "POST",
        path: "/api/run",
        handle: async ({ body }) => {
          await run(
            String(body.id),
            (body.files ?? {}) as Record<string, string>,
          );

          return { ok: true };
        },
      },
      {
        method: "POST",
        path: "/api/kill",
        handle: async () => {
          await cancelLive();
          hub.info("killed the live runs");

          return { ok: true };
        },
      },
      {
        method: "POST",
        path: "/api/reset",
        handle: async () => {
          session += 1;
          worker.abortStarting();

          const task = running.then(async () => {
            worker.stop();
            clearRuns();
            hub.setStatus("starting", "Restarting the Dev Server...");
            await devServer.restart();
            await ctx.resetAreas();
            hub.setStatus("idle", "Ready");
          });

          running = task.catch(() => {});
          await task;

          return { ok: true };
        },
      },
    ],
  };

  return result;
};
