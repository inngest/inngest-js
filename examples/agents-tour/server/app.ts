/**
 * @module
 * The tour server: serves the site, passes the editor's files to the app,
 * restarts the app on Run, sends the page's start events, streams the app's
 * output and the runs to the browser, and proxies the Dev Server's calls to
 * the app so the app's address never changes.
 */
import {
  createReadStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, join, normalize } from "node:path";
import type { Page, Start, TourEvent, TraceRun } from "../shared/types.ts";
import { DevServer, type DevServerPorts } from "./devserver.ts";
import { type LoadedPage, loadLessons } from "./lessons.ts";
import { cancelRun, readOutput, readRuns, terminal } from "./runs.ts";
import { readTypes } from "./types.ts";
import { Worker } from "./worker.ts";

export interface TourOptions {
  root: string;
  binary: string;
  port: number;
  ports: DevServerPorts;
}

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
};

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export const createTour = async (options: TourOptions) => {
  const { root, binary, port, ports } = options;
  const publicUrl = `http://127.0.0.1:${port}`;
  const dataDir = join(root, ".tour");
  const { pages, index } = loadLessons(join(root, "lessons"));
  const byId = new Map<string, LoadedPage>(
    pages.map((page) => {
      return [page.id, page];
    }),
  );
  const clients = new Set<ServerResponse>();
  const log: TourEvent[] = [];
  let status: TourEvent = {
    type: "status",
    state: "idle",
    text: "Starting the Dev Server...",
  };
  let runs: TraceRun[] = [];
  let from = new Date().toISOString();
  let generation = 0;
  let current: LoadedPage | undefined;
  const reported = new Set<string>();

  const broadcast = (event: TourEvent) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;

    for (const client of clients) {
      client.write(line);
    }
  };

  const emit = (event: TourEvent) => {
    if (event.type === "log") {
      log.push(event);
    } else if (event.type === "clear") {
      log.length = 0;
    } else if (event.type === "status") {
      status = event;
    }

    broadcast(event);
  };

  const info = (text: string) => {
    emit({ type: "log", kind: "info", text });
  };

  const setStatus = (
    state: "idle" | "starting" | "live" | "failed",
    text: string,
  ) => {
    emit({ type: "status", state, text });
  };

  const devServer = new DevServer({
    binary,
    ports,
    appUrl: `${publicUrl}/api/inngest`,
    logFile: join(dataDir, "devserver.log"),
  });
  const worker = new Worker({
    root,
    devServerUrl: devServer.url,
    onOutput: (kind, text) => {
      for (const line of text.split("\n")) {
        if (line.trim()) {
          emit({ type: "log", kind, text: line });
        }
      }
    },
  });

  const describe = async (run: TraceRun) => {
    emit({
      type: "log",
      kind: run.status === "COMPLETED" ? "result" : "err",
      text: `run ${run.fn} ${run.status}`,
    });

    if (!run.output) {
      return;
    }

    const output = await readOutput(devServer, run.output).catch(() => {
      return undefined;
    });

    if (output?.error) {
      emit({ type: "log", kind: "err", text: `error ${output.error.message}` });
    } else if (output?.data === "null") {
      emit({ type: "log", kind: "result", text: "no output" });
    } else if (output?.data) {
      emit({ type: "log", kind: "result", text: `output ${output.data}` });
    }
  };

  const poll = async () => {
    if (
      status.type !== "status" ||
      status.state === "idle" ||
      clients.size === 0
    ) {
      return;
    }

    try {
      const next = await readRuns(devServer, from);
      const same = JSON.stringify(next) === JSON.stringify(runs);

      if (!same) {
        runs = next;
        broadcast({ type: "runs", runs });
      }

      for (const run of next) {
        if (terminal.has(run.status) && !reported.has(run.id)) {
          reported.add(run.id);
          await describe(run);
        }
      }
    } catch {
      // The Dev Server is restarting; the next tick tries again.
    }
  };

  setInterval(poll, 300).unref();

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

  const sendStart = async (page: Page, start: Start) => {
    if ("event" in start) {
      await devServer.send(start.event.name, start.event.data);
      info(`sent event ${start.event.name}`);

      return;
    }

    await worker.send(start.agent, start.thread, start.message);
    info(`sent "${start.message}" to ${start.agent}`);
  };

  const cancelLive = async () => {
    for (const run of runs) {
      if (!terminal.has(run.status)) {
        await cancelRun(devServer, run.id).catch(() => {});
      }
    }
  };

  let running: Promise<void> = Promise.resolve();

  const run = (id: string, files: Record<string, string>) => {
    const task = running.then(async () => {
      const page = byId.get(id);

      if (!page || page.manifest.code === false) {
        return;
      }

      current = page;
      await cancelLive();
      emit({ type: "clear" });
      reported.clear();
      runs = [];
      broadcast({ type: "runs", runs });
      setStatus("starting", "Starting your code...");

      const started = Date.now();
      const dir = writeLesson(page, files);
      const result = await worker.reload(dir);

      if (!result.ok) {
        emit({
          type: "log",
          kind: "err",
          text: result.error ?? "The app did not start",
        });
        setStatus("failed", "Your code did not start");

        return;
      }

      from = new Date(Date.now() - 500).toISOString();

      try {
        await worker.sync(publicUrl);
      } catch (error) {
        emit({ type: "log", kind: "err", text: String(error) });
        setStatus("failed", "The Dev Server did not accept the app");

        return;
      }

      info(`started in ${Date.now() - started} ms`);
      setStatus("live", "Live");

      for (const start of page.manifest.start ?? []) {
        try {
          await sendStart(page, start);
        } catch (error) {
          emit({ type: "log", kind: "err", text: String(error) });
        }
      }
    });

    running = task.catch(() => {});

    return task;
  };

  const handleApi = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ) => {
    const path = url.pathname;

    if (path === "/api/index") {
      return sendJson(res, 200, index);
    }

    if (path === "/api/page") {
      const page = byId.get(url.searchParams.get("id") ?? "");

      if (!page) {
        return sendJson(res, 404, { error: "No such page" });
      }

      const { dir: _dir, ...rest } = page;

      return sendJson(res, 200, rest);
    }

    if (path === "/api/types") {
      return sendJson(res, 200, readTypes(root));
    }

    if (path === "/api/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(status)}\n\n`);

      for (const event of log) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }

      res.write(`data: ${JSON.stringify({ type: "runs", runs })}\n\n`);
      clients.add(res);
      req.on("close", () => {
        clients.delete(res);
      });

      return;
    }

    if (path === "/api/output") {
      const outputID = url.searchParams.get("id") ?? "";

      return sendJson(res, 200, await readOutput(devServer, outputID));
    }

    if (req.method !== "POST") {
      return sendJson(res, 404, { error: "Not found" });
    }

    const body = JSON.parse((await readBody(req)) || "{}") as Record<
      string,
      unknown
    >;

    if (path === "/api/open") {
      await running;
      current = byId.get(String(body.id));
      await cancelLive();
      emit({ type: "clear" });
      reported.clear();
      runs = [];
      from = new Date().toISOString();
      broadcast({ type: "runs", runs });
      setStatus("idle", "Ready");

      return sendJson(res, 200, { ok: true });
    }

    if (path === "/api/run") {
      await run(String(body.id), (body.files ?? {}) as Record<string, string>);

      return sendJson(res, 200, { ok: true });
    }

    if (path === "/api/kill") {
      await cancelLive();
      info("killed the live runs");

      return sendJson(res, 200, { ok: true });
    }

    if (path === "/api/reset") {
      await running;
      worker.stop();
      emit({ type: "clear" });
      runs = [];
      broadcast({ type: "runs", runs });
      setStatus("starting", "Restarting the Dev Server...");
      await devServer.restart();
      setStatus("idle", "Ready");

      return sendJson(res, 200, { ok: true });
    }

    if (path === "/api/send") {
      try {
        await worker.send(
          String(body.agent),
          String(body.thread),
          String(body.message),
        );
        info(`sent "${String(body.message)}" to ${String(body.agent)}`);

        return sendJson(res, 200, { ok: true });
      } catch (error) {
        emit({ type: "log", kind: "err", text: String(error) });

        return sendJson(res, 500, { error: String(error) });
      }
    }

    return sendJson(res, 404, { error: "Not found" });
  };

  const siteDir = join(root, "site/dist");

  const serveStatic = (res: ServerResponse, pathname: string) => {
    const requested = normalize(join(siteDir, pathname));
    const file =
      requested.startsWith(siteDir) &&
      existsSync(requested) &&
      statSync(requested).isFile()
        ? requested
        : join(siteDir, "index.html");

    res.writeHead(200, {
      "content-type": mime[extname(file)] ?? "application/octet-stream",
    });
    createReadStream(file).pipe(res);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", publicUrl);

    try {
      if (url.pathname === "/api/inngest") {
        worker.proxy(req, res);
      } else if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
      } else {
        serveStatic(res, url.pathname);
      }
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: String(error) });
      }
    }
  });

  return {
    url: publicUrl,
    async start() {
      rmSync(dataDir, { recursive: true, force: true });
      mkdirSync(dataDir, { recursive: true });
      await new Promise<void>((resolve) => {
        server.listen(port, "127.0.0.1", resolve);
      });
      setStatus("starting", "Starting the Dev Server...");
      await devServer.start();
      setStatus("idle", "Ready");
    },
    async stop() {
      worker.stop();
      await devServer.stop();
      for (const client of clients) {
        client.end();
      }
      server.close();
      server.closeAllConnections();
    },
    current: () => {
      return current;
    },
  };
};
