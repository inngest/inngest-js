import { startDevServer, stopDevServer } from "@inngest/test-harness";

export async function setup() {
  console.log("Starting Inngest Dev Server for benchmarks...");
  await startDevServer();
  console.log("Inngest Dev Server started");
}

export async function teardown() {
  console.log("Stopping Inngest Dev Server...");
  await stopDevServer();
  console.log("Inngest Dev Server stopped");
}
