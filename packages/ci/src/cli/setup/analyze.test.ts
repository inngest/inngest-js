/**
 * Tests for reading source as text: instances, the files that serve them,
 * route paths and start commands.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import {
  findInstances,
  findServed,
  installTsx,
  packageManagerOf,
  routePath,
  startCommand,
} from "./analyze.ts";

describe("findInstances", () => {
  test("finds the name and the client", () => {
    expect(
      findInstances(
        "ci/client.ts",
        'export const inngest = new Inngest({ id: "x" });\nexport const ci = createCi(inngest, {});',
      ),
    ).toEqual([{ file: "ci/client.ts", name: "ci", client: "inngest" }]);
  });

  test("finds several, and falls back to inngest without a client", () => {
    expect(
      findInstances("a.ts", "const a = createCi(c1);\nlet b = createCi({});"),
    ).toEqual([
      { file: "a.ts", name: "a", client: "c1" },
      { file: "a.ts", name: "b", client: "inngest" },
    ]);
  });

  test("ignores a file that doesn't call it", () => {
    expect(
      findInstances("a.ts", "import { createCi } from '@inngest/ci';"),
    ).toEqual([]);
  });
});

describe("findServed", () => {
  const instances = ["ci"];

  test("serve() with an adapter", () => {
    const source = `import { serve } from "inngest/express";
app.use("/api/inngest", serve({ client, functions: ci.functions() }));`;

    expect(findServed("server.ts", source, instances)).toMatchObject({
      file: "server.ts",
      instance: "ci",
      kind: "serve",
      adapter: "express",
      readsPort: false,
    });
  });

  test("createServer() from inngest/node", () => {
    const source = `import { createServer } from "inngest/node";
createServer({ client, functions: ci.functions() }).listen(process.env.PORT);`;

    expect(findServed("ci/server.ts", source, instances)).toMatchObject({
      kind: "serve",
      adapter: "node",
      readsPort: true,
    });
  });

  test("a createServer() from node:http isn't Inngest's", () => {
    const source = `import { createServer } from "node:http";
createServer(() => ci.functions());`;

    expect(findServed("a.ts", source, instances)).toBeUndefined();
  });

  test("Bun.serve() isn't serve()", () => {
    const source = `import { x } from "inngest/bun";
Bun.serve({ fetch: () => ci.functions() });`;

    expect(findServed("a.ts", source, instances)).toBeUndefined();
  });

  test("connect() alone is a connect, which serve() beats", () => {
    const connect = `import { connect } from "inngest/connect";
await connect({ apps: [{ client, functions: ci.functions() }] });`;

    expect(findServed("worker.ts", connect, instances)).toMatchObject({
      kind: "connect",
      adapter: undefined,
    });
    expect(
      findServed(
        "both.ts",
        `${connect}\nimport { serve } from "inngest/node";\nserve({});`,
        instances,
      ),
    ).toMatchObject({ kind: "serve" });
  });

  test("only functions of a known instance count", () => {
    const source = `import { serve } from "inngest/node";
serve({ functions: other.functions() });`;

    expect(findServed("a.ts", source, instances)).toBeUndefined();
  });

  test("takes the path from servePath", () => {
    const source = `import { serve } from "inngest/node";
serve({ servePath: "/inngest", functions: ci.functions() });`;

    expect(findServed("a.ts", source, instances)?.path).toBe("/inngest");
  });

  test("takes the path of a route file from where it lives", () => {
    const source = `import { serve } from "inngest/next";
export const { GET, POST } = serve({ functions: ci.functions() });`;
    const served = findServed(
      "src/app/api/inngest/route.ts",
      source,
      instances,
    );

    expect(served?.path).toBe("/api/inngest");
    expect(served?.readsPort).toBe(true);
  });
});

describe("routePath", () => {
  test.each([
    ["next", "app/api/inngest/route.ts", "/api/inngest"],
    ["next", "src/app/(ci)/api/inngest/route.js", "/api/inngest"],
    ["next", "app/route.ts", "/"],
    ["next", "app/api/inngest/page.ts", undefined],
    ["next", "pages/api/inngest.ts", "/api/inngest"],
    ["next", "src/pages/api/inngest/index.ts", "/api/inngest"],
    ["next", "lib/inngest.ts", undefined],
    ["sveltekit", "src/routes/api/inngest/+server.ts", "/api/inngest"],
    ["sveltekit", "src/routes/api/inngest/other.ts", undefined],
    ["remix", "app/routes/api.inngest.ts", "/api/inngest"],
    ["remix", "app/routes/api/inngest.ts", "/api/inngest"],
    ["remix", "app/routes/api.inngest/route.ts", "/api/inngest"],
    ["remix", "app/routes/_index.ts", "/"],
    ["express", "app/api/inngest/route.ts", undefined],
  ])("%s: %s", (adapter, file, expected) => {
    expect(routePath(file, adapter)).toBe(expected);
  });
});

describe("packageManagerOf", () => {
  test.each([
    [["pnpm-lock.yaml"], "pnpm"],
    [["yarn.lock"], "yarn"],
    [["yarn.lock", "pnpm-lock.yaml"], "pnpm"],
    [[], "npm"],
  ] as const)("%j is %s", (lockfiles, expected) => {
    expect(packageManagerOf([...lockfiles])).toBe(expected);
  });
});

describe("installTsx", () => {
  test.each([
    ["npm", "npm install --save-dev tsx"],
    ["pnpm", "pnpm add --save-dev tsx"],
    ["yarn", "yarn add --dev tsx"],
  ] as const)("%s", (manager, command) => {
    expect(installTsx(manager)).toBe(command);
  });
});

describe("startCommand", () => {
  const served = { file: "ci/server.ts", adapter: "node" };

  test.each([
    ["npm", "npm run ci:serve"],
    ["pnpm", "pnpm run ci:serve"],
    ["yarn", "yarn ci:serve"],
  ] as const)("a script that runs the file, with %s", (manager, command) => {
    expect(
      startCommand({
        served,
        scripts: { test: "vitest", "ci:serve": "tsx ./ci/server.ts" },
        manager,
      }),
    ).toBe(command);
  });

  test("prefers a script that doesn't watch", () => {
    expect(
      startCommand({
        served,
        scripts: {
          dev: "tsx watch ci/server.ts",
          start: "node --import tsx ci/server.ts",
        },
        manager: "npm",
      }),
    ).toBe("npm run start");
  });

  test("a framework's dev script runs its routes", () => {
    expect(
      startCommand({
        served: { file: "app/api/inngest/route.ts", adapter: "next" },
        scripts: { build: "next build", dev: "next dev --turbo" },
        manager: "pnpm",
      }),
    ).toBe("pnpm run dev");
  });

  test("without a script, tsx for TypeScript and node for JavaScript", () => {
    const base = { scripts: { lint: "biome lint" }, manager: "npm" } as const;

    expect(startCommand({ ...base, served })).toBe("tsx ci/server.ts");
    expect(startCommand({ ...base, served: { file: "ci/server.mjs" } })).toBe(
      "node ci/server.mjs",
    );
  });
});
