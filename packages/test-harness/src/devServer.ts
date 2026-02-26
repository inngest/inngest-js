import { type ChildProcess, spawn } from "node:child_process";

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
        "--tick",
        "10",
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
