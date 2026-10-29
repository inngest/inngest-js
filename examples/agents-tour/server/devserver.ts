/**
 * @module
 * The Dev Server process: started from the binary `pnpm tour:devserver`
 * built, with no autodiscovery, on ports the tour picked. Its log goes to a
 * file. Restarting it clears every run.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface DevServerPorts {
  api: number;
  gateway: number;
  gatewayGrpc: number;
  executorGrpc: number;
}

export interface DevServerOptions {
  binary: string;
  ports: DevServerPorts;
  // The URL of the app the Dev Server is told about.
  appUrl: string;
  logFile: string;
}

const sleep = (ms: number) => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

export class DevServer {
  readonly url: string;
  private child: ChildProcess | undefined;
  private readonly options: DevServerOptions;

  constructor(options: DevServerOptions) {
    this.options = options;
    this.url = `http://127.0.0.1:${options.ports.api}`;
  }

  async start() {
    const { binary, ports, appUrl, logFile } = this.options;

    mkdirSync(dirname(logFile), { recursive: true });

    const log = createWriteStream(logFile, { flags: "a" });
    const child = spawn(
      binary,
      [
        "dev",
        "--no-discovery",
        "--no-poll",
        "-u",
        appUrl,
        "--host",
        "127.0.0.1",
        "--port",
        String(ports.api),
        "--connect-gateway-port",
        String(ports.gateway),
        "--connect-gateway-grpc-port",
        String(ports.gatewayGrpc),
        "--connect-executor-grpc-port",
        String(ports.executorGrpc),
        "--tick",
        "50",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    child.stdout.pipe(log);
    child.stderr.pipe(log);
    this.child = child;
    child.once("exit", () => {
      if (this.child === child) {
        this.child = undefined;
      }
    });

    await this.waitUntilUp();
  }

  private async waitUntilUp() {
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      if (!this.child) {
        throw new Error(`The Dev Server exited; see ${this.options.logFile}`);
      }

      try {
        const res = await fetch(`${this.url}/health`);

        if (res.ok) {
          return;
        }
      } catch {
        // Not listening yet.
      }

      await sleep(100);
    }

    throw new Error(`The Dev Server did not start in 30s; see ${this.options.logFile}`);
  }

  async stop() {
    const child = this.child;

    this.child = undefined;

    if (!child || child.exitCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);

      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  /**
   * Runs a GraphQL query against the Dev Server.
   */
  async gql<T>(query: string, variables: Record<string, unknown> = {}) {
    const res = await fetch(`${this.url}/v0/gql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as {
      data?: T;
      errors?: { message: string }[];
    };

    if (body.errors?.length) {
      throw new Error(body.errors.map((e) => e.message).join("; "));
    }

    return body.data as T;
  }

  /**
   * Sends an event to the Dev Server.
   */
  async send(name: string, data: Record<string, unknown>) {
    const res = await fetch(`${this.url}/e/tour`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, data }),
    });

    if (!res.ok) {
      throw new Error(`Sending ${name} failed: ${res.status} ${await res.text()}`);
    }
  }
}
