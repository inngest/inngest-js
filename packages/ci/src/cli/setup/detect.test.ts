/**
 * Tests for detection on fixture projects in temporary git repositories.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { detectProject } from "./detect.ts";

let repo: string;

const write = (path: string, contents: string): void => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), contents);
};

const client = `import { Inngest } from "inngest";
import { createCi } from "@inngest/ci";
export const inngest = new Inngest({ id: "x" });
export const ci = createCi(inngest);`;

const nodeServer = `import { createServer } from "inngest/node";
import { ci, inngest } from "./client";
createServer({ client: inngest, functions: ci.functions() }).listen(Number(process.env.PORT));`;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "ci-detect-")));

  execFileSync("git", ["init", "-q"], { cwd: repo });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("detectProject", () => {
  test("a dedicated ci/server.ts", async () => {
    write("ci/client.ts", client);
    write("ci/server.ts", nodeServer);
    mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(repo, "node_modules/.bin/tsx"), "");

    expect(await detectProject(repo, repo)).toEqual({
      instances: [{ file: "ci/client.ts", name: "ci", client: "inngest" }],
      candidates: [
        {
          file: "ci/server.ts",
          ci: { file: "ci/client.ts", name: "ci", client: "inngest" },
          start: "tsx ci/server.ts",
          path: "/api/inngest",
          warnings: [],
        },
      ],
      connects: [],
    });
  });

  test("a Next.js route, started by the dev script", async () => {
    write("package.json", JSON.stringify({ scripts: { dev: "next dev" } }));
    write("pnpm-lock.yaml", "");
    write("src/inngest/ci.ts", client);
    write(
      "src/app/api/inngest/route.ts",
      `import { serve } from "inngest/next";
import { ci, inngest } from "../../../inngest/ci";
export const { GET, POST, PUT } = serve({ client: inngest, functions: ci.functions() });`,
    );

    const { candidates } = await detectProject(repo, repo);

    expect(candidates).toMatchObject([
      {
        file: "src/app/api/inngest/route.ts",
        start: "pnpm run dev",
        path: "/api/inngest",
        warnings: [],
      },
    ]);
  });

  test("a package.json script that runs the server", async () => {
    write(
      "package.json",
      JSON.stringify({ scripts: { serve: "node server.js" } }),
    );
    write("client.js", client);
    write("server.js", nodeServer);

    expect((await detectProject(repo, repo)).candidates).toMatchObject([
      { start: "npm run serve" },
    ]);
  });

  test("warns when the server ignores PORT, and when tsx is missing", async () => {
    write("client.ts", client);
    write("server.ts", nodeServer.replace("process.env.PORT", "3000"));

    expect((await detectProject(repo, repo)).candidates[0]).toMatchObject({
      start: "tsx server.ts",
      warnings: [
        "server.ts doesn't read PORT, which inngest-ci sets.",
        "tsx isn't installed. Add it with npm install --save-dev tsx.",
      ],
    });
  });

  test("a tsx above the project counts", async () => {
    mkdirSync(join(repo, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(repo, "node_modules/.bin/tsx"), "");
    write("apps/ci/client.ts", client);
    write("apps/ci/server.ts", nodeServer);

    const { candidates } = await detectProject(join(repo, "apps/ci"), repo);

    expect(candidates[0]?.warnings).toEqual([]);
  });

  test("connect() only", async () => {
    write("client.ts", client);
    write(
      "worker.ts",
      `import { connect } from "inngest/connect";
import { ci, inngest } from "./client";
await connect({ apps: [{ client: inngest, functions: ci.functions() }] });`,
    );

    const detection = await detectProject(repo, repo);

    expect(detection.candidates).toEqual([]);
    expect(detection.connects).toEqual(["worker.ts"]);
  });

  test("nothing", async () => {
    write("index.ts", "export const x = 1;");

    expect(await detectProject(repo, repo)).toEqual({
      instances: [],
      candidates: [],
      connects: [],
    });
  });

  test("ranks a dedicated ci/ server first, then the shallower one", async () => {
    write("client.ts", client);
    write("server.ts", nodeServer);
    write("deep/er/server.ts", nodeServer);
    write("tools/ci/server.ts", nodeServer);

    expect(
      (await detectProject(repo, repo)).candidates.map((candidate) => {
        return candidate.file;
      }),
    ).toEqual(["tools/ci/server.ts", "server.ts", "deep/er/server.ts"]);
  });

  test("skips ignored files, build output and other languages", async () => {
    write(".gitignore", "ignored/\n");
    write("client.ts", client);
    write("ignored/server.ts", nodeServer);
    write("dist/server.js", nodeServer);
    write("node_modules/pkg/server.js", nodeServer);
    write("notes.md", nodeServer);

    expect((await detectProject(repo, repo)).candidates).toEqual([]);
  });
});
