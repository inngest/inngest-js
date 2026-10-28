/**
 * The checks for the agent primitives on `jack/agent-primitives`: the agent
 * unit tests, the type tests, lint, and every scenario of the agents e2e kit
 * (`pnpm agents:verify`). The scenarios use the kit's `direct` stack, so they
 * start a Dev Server and a Redis in the job instead of using devstack. Some
 * scenarios need a backend newer than the published Dev Server, so
 * `agentsBase` builds the one that `kit/oss-pins.json` pins, with Redis, into
 * a cached image. The scenarios then run in parallel shards.
 *
 * @module
 */

import { $, checkout, files } from "@inngest/ci";

import { ci } from "../client.ts";
import { base, build } from "./base.ts";

/** Where `agentsBase` puts the Dev Server it builds. */
const ossDevServerBin = "/usr/local/bin/inngest-oss";

const shards = 4;

export const agentChecks = ci.job(
  { id: "agent-checks", from: build },
  async () => {
    await checkout();

    await $`pnpm --filter inngest run test agent`;

    await $`pnpm --filter inngest run test:types`;

    await $`pnpm --filter inngest run lint`;
  },
);

export const agentsBase = ci.job(
  {
    id: "agents-base",
    from: base,
    cache: {
      key: files("packages/inngest/test/agents-e2e/kit/oss-pins.json"),
    },
  },
  async () => {
    await checkout();

    await $.sh`apt-get update -qq && apt-get install -y -qq redis-server`.as(
      "install redis",
    );

    await $.sh`
      set -e
      pin=$(node -p "Object.values(require('./packages/inngest/test/agents-e2e/kit/oss-pins.json'))[0]")
      git init -q /tmp/oss
      cd /tmp/oss
      git fetch -q --depth 1 https://github.com/inngest/inngest "$pin"
      git checkout -q FETCH_HEAD
      goversion=$(awk '/^go /{print $2}' go.mod)
      arch=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
      curl -fsSL "https://go.dev/dl/go$goversion.linux-$arch.tar.gz" | tar -C /usr/local -xz
      /usr/local/go/bin/go build -o ${ossDevServerBin} ./cmd/main.go
      ${ossDevServerBin} version
    `.as("build the pinned Dev Server");
  },
);

export const agentScenarios = ci.job(
  {
    id: "agent-scenarios",
    from: agentsBase,
    matrix: {
      axes: {
        shard: Array.from({ length: shards }, (_, i) => {
          return String(i + 1);
        }),
      },
    },
  },
  async ({ matrix }) => {
    await checkout();

    await $`pnpm --filter @inngest/test run build`;

    await $`pnpm --filter inngest run build`;

    await $.sh`
      ids=$(ls packages/inngest/test/agents-e2e/scenarios | sed 's/[.]ts$//' | sort | awk -v s=${matrix.shard} -v n=${shards} '(NR - 1) % n == s - 1')
      AGENTS_VERIFY_STACK=direct AGENTS_VERIFY_DEV_BIN=${ossDevServerBin} timeout 12m pnpm agents:verify $ids
    `.as("agents:verify shard");
  },
);
