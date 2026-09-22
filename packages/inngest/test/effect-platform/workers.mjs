// node test/effect-platform/workers.mjs
// Downloads only the pinned Wrangler CLI through pnpm dlx; never deploys.
// Requires Node >=22 and pnpm on PATH. Uses a local workerd process, not mocks.
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const port = Number(process.env.EFFECT_WORKER_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid EFFECT_WORKER_PORT");
const base = `http://127.0.0.1:${port}`;
// Refuse to accidentally exercise an unrelated/stale worker on the same port.
try {
  await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
  throw new Error(
    `Port ${port} is already serving HTTP; choose EFFECT_WORKER_PORT`,
  );
} catch (error) {
  if (!(error instanceof TypeError) && error.name !== "TimeoutError")
    throw error;
}
const child = spawn(
  "pnpm",
  [
    "dlx",
    "wrangler@4.136.1",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--config",
    fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)),
  ],
  {
    stdio: "inherit",
    detached: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", BROWSER: "none" },
  },
);
let childFailure;
child.once("error", (error) => {
  childFailure = error;
});
child.once("exit", (code, signal) => {
  childFailure = new Error(
    `Wrangler exited before smoke completed (${code ?? signal})`,
  );
});
function stop(signal) {
  if (!child.pid) return;
  try {
    // Only this runner's freshly spawned process group is terminated.
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
try {
  const until = Date.now() + 120000;
  let ready = false;
  while (Date.now() < until) {
    if (childFailure) throw childFailure;
    try {
      const response = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      ready = response.status === 200 && (await response.text()) === "ready";
    } catch {
      // Only readiness connection failures are retried. The scenario runs once.
    }
    if (ready) break;
    await delay(250);
  }
  if (!ready)
    throw new Error("Local workerd did not become ready within 120 seconds");
  const response = await fetch(`${base}/smoke`, {
    signal: AbortSignal.timeout(90000),
  });
  const body = await response.text();
  if (response.status !== 200)
    throw new Error(`Workers smoke HTTP ${response.status}: ${body}`);
  const result = JSON.parse(body);
  if (result.ok !== true || result.runtime !== "workerd")
    throw new Error(`Unexpected Workers smoke response: ${body}`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  stop("SIGTERM");
  await delay(1000);
  stop("SIGKILL");
}
