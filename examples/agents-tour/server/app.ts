/**
 * @module
 * The tour server: serves the site, streams events to the browser, proxies
 * the Dev Server's calls to the app so the app's address never changes, and
 * hands every `/api/*` request to the areas in `areas/` (pages and runs,
 * panels and fakes, and any area added later).
 */
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import type { Area, AreaFactory, Route, TourContext } from "./area.ts";
import { type CheckTiming, defaultTiming } from "./check-runner.ts";
import { DevServer, type DevServerPorts } from "./devserver.ts";
import { HttpError } from "./http-error.ts";
import { Hub } from "./hub.ts";
import { loadLessons } from "./lessons.ts";
import { Worker } from "./worker.ts";

export interface TourOptions {
  root: string;
  // Default: `lessons` in the root.
  lessonsDir?: string;
  binary: string;
  port: number;
  ports: DevServerPorts;
  // Where the areas are. Default: `areas` beside this file.
  areasDir?: string;
  // Areas to load in addition to the ones there.
  areas?: AreaFactory[];
  // Where the tour keeps what it writes. Default: `.tour` in the root.
  dataDir?: string;
  // How long a check waits, in parts. Default: `defaultTiming`.
  checkTiming?: Partial<CheckTiming>;
  // Tells the app to use the scripted model; `tour:verify` sets it.
  scriptedModel?: boolean;
  // Where the tour keeps progress, which outlives the data folder that is
  // wiped at start. Default: `.tour-cache` in the root.
  cacheDir?: string;
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

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const loadAreaFactories = async (dir: string) => {
  const factories: AreaFactory[] = [];

  for (const file of readdirSync(dir).sort()) {
    if (file.endsWith(".ts")) {
      const module = (await import(pathToFileURL(join(dir, file)).href)) as {
        area?: AreaFactory;
      };

      if (!module.area) {
        throw new Error(`areas/${file} must export area`);
      }

      factories.push(module.area);
    }
  }

  return factories;
};

// A browser may reach the tour as any of its loopback names.
const hostsOf = (port: number) => {
  return ["127.0.0.1", "localhost", "[::1]"].map((name) => {
    return `${name}:${port}`;
  });
};

export const createTour = async (options: TourOptions) => {
  const { root, binary, port, ports } = options;
  const publicUrl = `http://127.0.0.1:${port}`;
  const allowedHosts = new Set(hostsOf(port));
  const allowedOrigins = new Set(
    hostsOf(port).map((host) => {
      return `http://${host}`;
    }),
  );
  const dataDir = options.dataDir ?? join(root, ".tour");
  const cacheDir = options.cacheDir ?? join(root, ".tour-cache");
  const { pages, index, definitions } = loadLessons(
    options.lessonsDir ?? join(root, "lessons"),
  );
  const hub = new Hub();
  const devServer = new DevServer({
    binary,
    ports,
    appUrl: `${publicUrl}/api/inngest`,
    logFile: join(dataDir, "devserver.log"),
  });
  const worker = new Worker({
    root,
    publicUrl,
    devServerUrl: devServer.url,
    onOutput: (kind, text) => {
      for (const line of text.split("\n")) {
        if (line.trim()) {
          hub.emit({ type: "log", kind, text: line });
        }
      }
    },
  });
  let areas: Area[] = [];
  const ctx: TourContext = {
    root,
    checkTiming: { ...defaultTiming, ...options.checkTiming },
    scriptedModel: options.scriptedModel ?? false,
    publicUrl,
    dataDir,
    cacheDir,
    definitions,
    devServer,
    worker,
    hub,
    pages,
    index,
    areas: () => {
      return areas;
    },
    runPage: async () => {
      throw new Error("No area runs pages");
    },
    resetAreas: async () => {
      for (const area of areas) {
        await area.reset?.();
      }
    },
  };

  areas = [
    ...(await loadAreaFactories(
      options.areasDir ?? join(import.meta.dirname, "areas"),
    )),
    ...(options.areas ?? []),
  ].map((factory) => {
    return factory(ctx);
  });

  const routes = new Map<string, Route>();

  for (const area of areas) {
    for (const route of area.routes ?? []) {
      const key = `${route.method} ${route.path}`;

      if (routes.has(key)) {
        throw new Error(`${area.name} answers ${key}, which is already taken`);
      }

      routes.set(key, route);
    }
  }

  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }

    return Buffer.concat(chunks).toString("utf8");
  };

  // An area may own routes outside `/api/`, such as a fake's own REST API.
  const answeredRaw = async (req: IncomingMessage, res: ServerResponse) => {
    for (const area of areas) {
      if (await area.raw?.(req, res)) {
        return true;
      }
    }

    return false;
  };

  const handleApi = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ) => {
    if (url.pathname === "/api/stream") {
      hub.open(
        res,
        areas.flatMap((area) => {
          return area.replay?.() ?? [];
        }),
      );

      return;
    }

    const route = routes.get(`${req.method} ${url.pathname}`);

    if (!route) {
      return sendJson(res, 404, { error: "Not found" });
    }

    const body =
      req.method === "POST"
        ? (JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>)
        : {};

    try {
      return sendJson(res, 200, await route.handle({ url, body }));
    } catch (error) {
      if (error instanceof HttpError) {
        return sendJson(res, error.status, error.body);
      }

      return sendJson(res, 500, { error: String(error) });
    }
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
    const origin = req.headers.origin;
    const foreign =
      !allowedHosts.has(req.headers.host ?? "") ||
      (origin !== undefined && !allowedOrigins.has(origin));

    if (foreign && url.pathname !== "/api/inngest") {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Forbidden");

      return;
    }

    if (
      req.method === "POST" &&
      url.pathname.startsWith("/api/") &&
      !req.headers["content-type"]?.startsWith("application/json")
    ) {
      res.writeHead(415, { "content-type": "text/plain" });
      res.end("JSON only");

      return;
    }

    try {
      if (url.pathname === "/api/inngest") {
        worker.proxy(req, res);
      } else if (await answeredRaw(req, res)) {
        return;
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

  const listen = async () => {
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  };

  return {
    url: publicUrl,
    /**
     * Starts the HTTP server alone, without the Dev Server.
     */
    listen,
    async start() {
      await listen();
      hub.setStatus("starting", "Starting the Dev Server...");
      await devServer.start();
      hub.setStatus("idle", "Ready");
    },
    stop: async () => {
      worker.stop();

      await devServer.stop();

      hub.close();
      server.close();
      server.closeAllConnections();
    },
  };
};
