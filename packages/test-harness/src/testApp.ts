import type http from "node:http";
import type { AddressInfo } from "node:net";
import type { Inngest, InngestFunction } from "inngest";
import { createServer as createNodeServer } from "inngest/node";

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

  // Auto-close server when the current test finishes
  const { onTestFinished } = await import("vitest");
  onTestFinished(() => {
    return new Promise<void>((resolve) => {
      finalServer.close(() => {
        resolve();
      });
    });
  });

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
      const res = await fetch(
        `http://localhost:8288/dev`,
      );
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
