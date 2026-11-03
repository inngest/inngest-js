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
  // The tour server's own address, where the fake Slack and GitHub are.
  publicUrl: string;
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
  private readonly pending = new Set<ChildProcess>();
  private readonly env: WorkerEnv;

  constructor(env: WorkerEnv) {
    this.env = env;
  }

  /**
   * Starts the app from `dir`, and switches to it when it serves. `files`
   * are the page's files, in the folder, that the app imports. `env` is
   * added to the app's environment.
   */
  async reload(
    dir: string,
    files: string[],
    env: Record<string, string> = {},
  ): Promise<Started> {
    const pending = this.pending;
    const port = await freePort();
    const errors: string[] = [];
    const child = fork(join(this.env.root, "runtime/host.ts"), [], {
      cwd: dir,
      execArgv: ["--import", "tsx", "--disable-warning=ExperimentalWarning"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        TOUR_DIR: dir,
        // The page's files, which the app imports.
        TOUR_FILES: JSON.stringify(files),
        TOUR_URL: this.env.publicUrl,
        SLACK_BOT_TOKEN: "xoxb-tour",
        PORT: String(port),
        INNGEST_DEV: "1",
        INNGEST_BASE_URL: this.env.devServerUrl,
        NODE_NO_WARNINGS: "1",
        ...env,
      },
    });

    pending.add(child);
    child.once("exit", () => {
      pending.delete(child);
    });
    child.on("error", () => {});
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

    res.on("close", () => {
      upstream.destroy();
    });
    upstream.on("error", (error) => {
      if (res.headersSent) {
        res.destroy();

        return;
      }

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

  /**
   * Sends `content` to a thread of `agent` (its id or export name) as a plain
   * `agent/message`: into the live run's inbox, or as the start of a run.
   */
  async send(agent: string, thread: string, content: string) {
    await this.post("/__tour/send", { agent, thread, content });
  }

  /**
   * Starts `agent` on `thread` with `content` through the app's `tour-start`
   * function, which calls `agent.start()`. The run ends after its answer.
   */
  async start(agent: string, thread: string, content: string) {
    await this.post("/__tour/start", { agent, thread, content });
  }

  /**
   * Runs the page's `run.ts` through the app's `tour-start` function, which
   * calls its `run` export inside the function, so `start()` works there.
   */
  async run() {
    await this.post("/__tour/run", {});
  }

  private async post(path: string, body: Record<string, unknown>) {
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const answer = (await res.json()) as { ok?: boolean; error?: string };

    if (!res.ok) {
      throw new Error(answer.error ?? `Sending failed: ${res.status}`);
    }
  }

  /**
   * Gives up on an app that is still starting. The previous one keeps serving.
   */
  abortStarting() {
    for (const child of this.pending) {
      if (child !== this.current) {
        child.kill("SIGKILL");
      }
    }
  }

  stop() {
    for (const child of this.pending) {
      child.kill("SIGKILL");
    }

    this.current?.kill("SIGTERM");
    this.current = undefined;
    this.port = 0;
  }
}
