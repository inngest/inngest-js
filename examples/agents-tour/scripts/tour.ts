/**
 * @module
 * `pnpm tour`: checks the machine, starts the Dev Server from the cached
 * build on free ports, starts the tour server, opens the browser, and stops
 * everything on Ctrl-C. It listens on a fixed port (`TOUR_PORT` overrides),
 * so the address stays the same; `--live` is for the lead's long-running
 * tour and does not open a browser.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTour } from "../server/app.ts";
import { doctor, freePort, resolveBinary, root, tourPort } from "./lib.ts";

if (!doctor({ needGo: false })) {
  process.exit(1);
}

const binary = resolveBinary();

if (!binary) {
  console.error(
    "\nThe Dev Server is not built yet. Run `pnpm tour:devserver` first (it needs Go).",
  );
  process.exit(1);
}

const newest = (dir: string): number => {
  let time = 0;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }

    time = Math.max(
      time,
      entry.isDirectory() ? newest(path) : statSync(path).mtimeMs,
    );
  }

  return time;
};

const siteIndex = join(root, "site/dist/index.html");

if (
  !existsSync(siteIndex) ||
  statSync(siteIndex).mtimeMs < newest(join(root, "site"))
) {
  console.log("Building the site...");

  const { build } = await import("vite");

  await build({ root: join(root, "site"), logLevel: "warn" });
}

const [port, api, gateway, gatewayGrpc, executorGrpc] = await Promise.all([
  tourPort(process.env),
  freePort(),
  freePort(),
  freePort(),
  freePort(),
]);

const tour = await createTour({
  root,
  binary,
  port,
  ports: { api, gateway, gatewayGrpc, executorGrpc },
});

try {
  await tour.start();
} catch (error) {
  console.error(
    (error as NodeJS.ErrnoException).code === "EADDRINUSE"
      ? `Port ${port} is already in use. Stop the tour running there, or set TOUR_PORT.`
      : String(error),
  );
  await tour.stop();
  process.exit(1);
}

console.log(`\nThe Agents Tour is running at ${tour.url}`);
console.log("Press Ctrl-C to stop it.\n");

if (!process.env.TOUR_NO_OPEN && !process.argv.includes("--live")) {
  const opener =
    process.platform === "darwin"
      ? ["open"]
      : process.platform === "win32"
        ? ["cmd", "/c", "start"]
        : ["xdg-open"];

  spawnSync(opener[0] as string, [...opener.slice(1), tour.url], {
    stdio: "ignore",
  });
}

let stopping = false;

const shutdown = async () => {
  if (stopping) {
    return;
  }

  stopping = true;
  console.log("\nStopping the tour...");
  await tour.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
