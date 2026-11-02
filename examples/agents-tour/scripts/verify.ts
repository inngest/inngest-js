/**
 * @module
 * `pnpm tour:verify`: starts the tour with the scripted model, drives every
 * page through the tour server's API (see `verify-lib.ts`) and exits 1,
 * naming each page that does not hold. Pass a module id to verify one module.
 */
import { createTour } from "../server/app.ts";
import { doctor, freePort, resolveBinary, root } from "./lib.ts";
import { verifyPages } from "./verify-lib.ts";

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

const [port, api, gateway, gatewayGrpc, executorGrpc] = await Promise.all([
  freePort(),
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
  dataDir: `${root}/.tour/verify`,
  scriptedModel: true,
});

let problems: string[] = [];

try {
  await tour.start();
  problems = await verifyPages(tour.url, process.argv[2]);
} finally {
  await tour.stop();
}

if (problems.length > 0) {
  console.error(`\n${problems.join("\n")}\n\n${problems.length} problem(s).`);
  process.exit(1);
}

console.log("Every page holds its promise.");
process.exit(0);
