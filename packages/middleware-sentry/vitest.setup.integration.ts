import { startDevServer, stopDevServer } from "@inngest/test-harness";

const devServerEnabled = process.env.DEV_SERVER_ENABLED !== "0";

export async function setup() {
  if (!devServerEnabled) {
    return;
  }

  console.log("Starting Inngest Dev Server...");
  await startDevServer();
  console.log("Inngest Dev Server started");
}

export async function teardown() {
  if (!devServerEnabled) {
    return;
  }

  console.log("Stopping Inngest Dev Server...");
  await stopDevServer();
  console.log("Inngest Dev Server stopped");
}
