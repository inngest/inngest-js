/**
 * @module
 * Runs the learner's app. Each Run starts a new child process on a free port
 * from the lesson files; once it reports it is serving, the proxy switches to
 * it and the old child stops. A file that does not load keeps the previous
 * version serving, and the error is returned. The Dev Server talks to the
 * proxy URL, which never changes.
 */
import { type ChildProcess, fork } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request } from "node:http";
import { join } from "node:path";
import { freePort } from "../scripts/lib.ts";

export interface WorkerEnv {
  root: string;
  // Base URL of the Dev Server, handed to the app.
  devServerUrl: string;
  onOutput: (kind: "out" | "err", text: string) => void;
}

export interface Started {
  ok: boolean;
  error?: string;
}

const readyTimeoutMs = 30_000;

export class Worker {
  private current: ChildProcess | undefined;
  private port = 0;
  private readonly env: WorkerEnv;

  constructor(env: WorkerEnv) {
    this.env = env;
  }

  /**
   * Starts the app from `dir`, and switches to it when it serves.
   */
  async reload(dir: string): Promise<Started> {
    const port = await freePort();
    const errors: string[] = [];
    const child = fork(join(this.env.root, "runtime/host.ts"), [], {
      cwd: dir,
      execArgv: ["--import", "tsx", "--disable-warning=ExperimentalWarning"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        TOUR_DIR: dir,
        PORT: String(port),
        INNGEST_DEV: "1",
        INNGEST_BASE_URL: this.env.devServerUrl,
        NODE_NO_WARNINGS: "1",
      },
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      this.env.onOutput("out", chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");

      errors.push(text);
      this.env.onOutput("err", text);
    });

    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(false);
      }, readyTimeoutMs);

      child.once("message", () => {
        clearTimeout(timer);
        resolve(true);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    if (!ready) {
      child.kill("SIGKILL");

      return {
        ok: false,
        error: errors.join("").trim() || "The app did not start",
      };
    }

    const previous = this.current;

    this.current = child;
    this.port = port;
    child.once("exit", (code) => {
      if (this.current === child) {
        this.current = undefined;
        this.env.onOutput("err", `The app exited with code ${code}\n`);
      }
    });
    previous?.kill("SIGTERM");

    return { ok: true };
  }

  /**
   * Forwards a request to the app. The Host header is kept so the SDK
   * registers the proxy's URL with the Dev Server.
   */
  proxy(req: IncomingMessage, res: ServerResponse) {
    if (!this.port) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("The app is not running yet");

      return;
    }

    const upstream = request(
      {
        host: "127.0.0.1",
        port: this.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );

    upstream.on("error", (error) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(String(error));
    });
    req.pipe(upstream);
  }

  /**
   * Asks the app to register with the Dev Server, through the proxy.
   */
  async sync(publicUrl: string) {
    const res = await fetch(`${publicUrl}/api/inngest`, { method: "PUT" });

    if (!res.ok) {
      throw new Error(
        `Registering the app failed: ${res.status} ${await res.text()}`,
      );
    }
  }

  async send(agent: string, thread: string, message: string) {
    const res = await fetch(`http://127.0.0.1:${this.port}/__tour/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent, thread, message }),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };

    if (!res.ok) {
      throw new Error(body.error ?? `Sending failed: ${res.status}`);
    }
  }

  stop() {
    this.current?.kill("SIGTERM");
    this.current = undefined;
    this.port = 0;
  }
}
