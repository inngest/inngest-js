/**
 * Send a pipeline a locally built GitHub event.
 *
 * ```bash
 * pnpm ci:send pr
 * pnpm ci:send pr --event pull_request.synchronize
 * pnpm ci:send release --event push
 * pnpm ci:send prerelease --event comment --body "/prerelease"
 * ```
 *
 * The payloads are built from this git repository, and `checkout()` uploads
 * the working tree, so uncommitted changes are what the pipeline tests.
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { fixtures } from "inngest/ci";

import { inngest } from "../ci/client.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    event: { type: "string", default: "pull_request.opened" },
    body: { type: "string" },
    base: { type: "string", default: "main" },
    cwd: { type: "string" },
  },
});

const pipeline = positionals[0];

if (!pipeline) {
  console.error(
    "Usage: pnpm ci:send <pipeline> [--event pull_request.opened|push|comment]",
  );
  process.exit(1);
}

// The repository root, so `checkout()` uploads the whole working tree.
const cwd = resolve(values.cwd ?? process.cwd(), "../..");

const build = async () => {
  const kind = values.event ?? "pull_request.opened";

  if (kind === "push") {
    return fixtures.push({ cwd });
  }

  if (kind === "comment") {
    return fixtures.comment({
      cwd,
      body: values.body ?? "/prerelease",
    });
  }

  const [, action = "opened"] = kind.split(".");

  return fixtures.pullRequest({
    cwd,
    base: values.base ?? "main",
    // biome-ignore lint/suspicious/noExplicitAny: the action is user input
    action: action as any,
  });
};

const event = await build();

await inngest.send(event);

console.log(
  { pipeline, event: event.name },
  `Sent ${event.name}. Watch it at http://localhost:8288`,
);
