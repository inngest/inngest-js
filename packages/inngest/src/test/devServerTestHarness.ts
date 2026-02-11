import { type ChildProcess, spawn } from "node:child_process";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import type { Inngest, InngestFunction } from "../index.ts";
import { createServer as createNodeServer } from "../node.ts";

let devServerProcess: ChildProcess | null = null;

export const DEV_SERVER_PORT = 8288;

/**
 * The base URL for the Dev Server.
 */
export const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

/**
 * Start the Inngest Dev Server.
 *
 * This function spawns a new process running the Inngest CLI in dev mode.
 * It waits for the server to be ready before resolving.
 */
export async function startDevServer(): Promise<void> {
  if (devServerProcess) {
    console.log("Dev server already running");
    return;
  }

  return new Promise((resolve, reject) => {
    // npx inngest-cli@latest dev --no-discovery --port 8288
    devServerProcess = spawn(
      "npx",
      [
        "inngest-cli@latest",
        "dev",
        "--no-discovery",
        "--no-poll",
        "--port",
        DEV_SERVER_PORT.toString(),
        "--retry-interval",
        "1",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
      },
    );

    let startupTimeout: NodeJS.Timeout | null = null;
    let resolved = false;

    const cleanup = () => {
      if (startupTimeout) {
        clearTimeout(startupTimeout);
        startupTimeout = null;
      }
    };

    devServerProcess.stdout?.on("data", (data) => {
      const output = data.toString();
      if (process.env.DEBUG_DEV_SERVER) {
        console.log("[dev-server stdout]", output);
      }
    });

    devServerProcess.stderr?.on("data", (data) => {
      const output = data.toString();
      if (process.env.DEBUG_DEV_SERVER) {
        console.error("[dev-server stderr]", output);
      }
    });

    devServerProcess.on("error", (err) => {
      cleanup();
      if (!resolved) {
        resolved = true;
        reject(new Error(`Failed to start Dev Server: ${err.message}`));
      }
    });

    devServerProcess.on("exit", (code) => {
      cleanup();
      devServerProcess = null;
      if (!resolved) {
        resolved = true;
        reject(new Error(`Dev Server exited unexpectedly with code ${code}`));
      }
    });

    // Set a timeout for startup
    startupTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("Dev Server startup timed out after 60 seconds"));
      }
    }, 60000);

    // Poll for readiness
    const checkReady = async () => {
      for (let i = 0; i < 120; i++) {
        try {
          const res = await fetch(`${DEV_SERVER_URL}/dev`);
          if (res.ok) {
            cleanup();
            if (!resolved) {
              resolved = true;
              resolve();
            }
            return;
          }
        } catch {
          // Server not ready yet
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      cleanup();
      if (!resolved) {
        resolved = true;
        reject(new Error("Dev Server failed health check"));
      }
    };

    checkReady();
  });
}

/**
 * Stop the Inngest Dev Server.
 */
export async function stopDevServer(): Promise<void> {
  if (!devServerProcess) {
    return;
  }

  return new Promise((resolve) => {
    const proc = devServerProcess;
    devServerProcess = null;

    if (!proc) {
      resolve();
      return;
    }

    proc.on("exit", () => {
      resolve();
    });

    // Give it some time to exit gracefully
    const forceKillTimeout = setTimeout(() => {
      proc.kill("SIGKILL");
    }, 5000);

    proc.on("exit", () => {
      clearTimeout(forceKillTimeout);
    });

    proc.kill("SIGTERM");
  });
}

/**
 * Check if the Dev Server is running.
 */
export function isDevServerRunning(): boolean {
  return devServerProcess !== null;
}

/**
 * Create a test server using the Node.js serve handler.
 *
 * This creates an HTTP server that serves Inngest functions. The server
 * listens on a random available port (use server.address() to get the port).
 */
export function createTestServer(options: {
  client: Inngest.Any;
  functions: InngestFunction.Any[];
  servePath?: string;
}): http.Server {
  const servePath = options.servePath ?? "/api/inngest";

  // Create server without specifying serveOrigin - we'll set it after getting the port
  return createNodeServer({
    client: options.client,
    functions: options.functions,
    servePath,
  });
}

/**
 * Information about a running test app.
 */
export interface TestApp {
  /** The HTTP server */
  server: http.Server;
  /** The port the server is listening on */
  port: number;
  /** The base URL of the app (e.g., http://localhost:3456) */
  baseUrl: string;
  /** The full URL to the Inngest endpoint */
  inngestUrl: string;
}

/**
 * Create a test app server, start it on a random port, and register with Dev Server.
 *
 * This is the main entry point for setting up a test. It:
 * 1. Creates an HTTP server with the provided functions
 * 2. Starts listening on a random available port
 * 3. Registers the functions with the Dev Server
 * 4. Returns the app info for sending events
 *
 * @example
 * ```ts
 * const app = await createTestApp({
 *   client: inngest,
 *   functions: [myFunction],
 * });
 *
 * // Send events and check results
 * const eventId = await sendEvent("my-event");
 * ```
 */
export async function createTestApp(options: {
  client: Inngest.Any;
  functions: InngestFunction.Any[];
  servePath?: string;
}): Promise<TestApp> {
  const servePath = options.servePath ?? "/api/inngest";

  // Create and start the server on port 0 to get a random available port
  const server = await new Promise<http.Server>((resolve, reject) => {
    // We need to create the server with the correct origin after we know the port
    // For now, create a temporary server just to get a port
    const tempServer = createNodeServer({
      client: options.client,
      functions: options.functions,
      servePath,
      // serveOrigin will be wrong initially, but we'll fix it
    });

    tempServer.on("error", reject);
    tempServer.listen(0, () => {
      tempServer.removeListener("error", reject);
      resolve(tempServer);
    });
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const baseUrl = `http://localhost:${port}`;
  const inngestUrl = `${baseUrl}${servePath}`;

  // Close the temp server and recreate with correct serveOrigin
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const finalServer = await new Promise<http.Server>((resolve, reject) => {
    const srv = createNodeServer({
      client: options.client,
      functions: options.functions,
      servePath,
      serveOrigin: baseUrl,
    });

    srv.on("error", reject);
    srv.listen(port, () => {
      srv.removeListener("error", reject);
      resolve(srv);
    });
  });

  // Register with the Dev Server
  await registerApp(inngestUrl);

  return {
    server: finalServer,
    port,
    baseUrl,
    inngestUrl,
  };
}

/**
 * Register an app with the Dev Server by triggering a PUT request.
 *
 * This tells the Dev Server about the functions available at the given URL.
 */
export async function registerApp(inngestUrl: string): Promise<void> {
  // PUT to the serve endpoint to trigger registration
  const res = await fetch(inngestUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to register app: ${res.status} ${text}`);
  }

  // Wait a bit for the Dev Server to process the registration
  await new Promise((r) => setTimeout(r, 500));
}

/**
 * Wait for the Dev Server to have a specific number of registered functions.
 */
export async function waitForFunctions(
  count: number,
  timeout = 10000,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`${DEV_SERVER_URL}/dev`);
      if (res.ok) {
        const data = (await res.json()) as { functions?: unknown[] };
        if (data.functions && data.functions.length >= count) {
          return;
        }
      }
    } catch {
      // Dev server not ready
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(`Timeout waiting for ${count} functions to be registered`);
}
