/**
 * Tests for resolving the config: loading it, guided setup and the error
 * without a terminal.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { Prompter } from "../prompter.ts";
import { configure } from "./guided.ts";

let repo: string;

const write = (path: string, contents: string): void => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), contents);
};

const read = (path: string): string => {
  return readFileSync(join(repo, path), "utf8");
};

/** A prompter that answers from a script and records what it was asked. */
const scripted = (answers: unknown[]) => {
  const asked: string[] = [];
  const next = async (question: string) => {
    asked.push(question);

    return answers.shift();
  };
  const prompter = {
    choose: next,
    review: next,
    line: next,
  } as unknown as Prompter;

  return { prompter, asked };
};

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "ci-guided-")));

  execFileSync("git", ["init", "-q"], { cwd: repo });
  write(
    "ci/client.ts",
    'export const inngest = new Inngest({ id: "x" });\nexport const ci = createCi(inngest);',
  );
  write(
    "app/server.ts",
    'import { createServer } from "inngest/node";\ncreateServer({ client: inngest, functions: ci.functions() }).listen(process.env.PORT);',
  );
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("configure", () => {
  test("a valid config loads without asking", async () => {
    write("inngest.json", JSON.stringify({ ci: { start: "node s.js" } }));

    const { prompter, asked } = scripted([]);

    expect(
      (await configure({ root: repo, gitRoot: repo, prompter })).start,
    ).toBe("node s.js");
    expect(asked).toEqual([]);
  });

  test("a broken config is still an error to show", async () => {
    write("inngest.json", JSON.stringify({ ci: { start: 1 } }));

    await expect(
      configure({ root: repo, gitRoot: repo, prompter: scripted([]).prompter }),
    ).rejects.toThrow("ci.start");
  });

  test("with no config, accepting writes it and offers .gitignore", async () => {
    const { prompter, asked } = scripted(["accept", true]);
    const config = await configure({ root: repo, gitRoot: repo, prompter });

    expect(config).toMatchObject({
      start: "tsx app/server.ts",
      path: "/api/inngest",
    });
    expect(JSON.parse(read("inngest.json"))).toEqual({
      ci: { start: "tsx app/server.ts", path: "/api/inngest" },
    });
    expect(read(".gitignore")).toBe(".inngest/\n");
    expect(asked).toEqual([
      "Run inngest-ci with this?",
      "Add .inngest/ to .gitignore?",
    ]);
  });

  test("declining .gitignore leaves it alone", async () => {
    await configure({
      root: repo,
      gitRoot: repo,
      prompter: scripted(["accept", false]).prompter,
    });

    expect(existsSync(join(repo, ".gitignore"))).toBe(false);
  });

  test("an ignored .inngest/ isn't offered again", async () => {
    write(".gitignore", ".inngest/\n");

    const { prompter, asked } = scripted(["accept"]);

    await configure({ root: repo, gitRoot: repo, prompter });

    expect(asked).toEqual(["Run inngest-ci with this?"]);
  });

  test("editing asks for the start command and path, prefilled", async () => {
    const initials: unknown[] = [];
    const answers: unknown[] = ["edit", "node x.js", "/inngest", false];
    const prompter = {
      review: async () => {
        return answers.shift();
      },
      line: async (_: string, __: unknown, initial: unknown) => {
        initials.push(initial);

        return answers.shift();
      },
      choose: async () => {
        return answers.shift();
      },
    } as unknown as Prompter;

    await configure({ root: repo, gitRoot: repo, prompter });

    expect(JSON.parse(read("inngest.json")).ci).toEqual({
      start: "node x.js",
      path: "/inngest",
    });
    expect(initials).toEqual(["tsx app/server.ts", "/api/inngest"]);
  });

  test("with several servers, choosing another shows it and asks again", async () => {
    write(
      "ci/server.ts",
      'import { serve } from "inngest/node";\nserve({ servePath: "/ci", functions: ci.functions() });',
    );

    const { prompter, asked } = scripted([
      "server",
      {
        file: "app/server.ts",
        ci: { file: "ci/client.ts", name: "ci", client: "inngest" },
        warnings: [],
        start: "tsx app/server.ts",
        path: "/api/inngest",
      },
      "accept",
      false,
    ]);

    await configure({ root: repo, gitRoot: repo, prompter, again: true });

    expect(asked).toEqual([
      "Run inngest-ci with this?",
      "Which server?",
      "Run inngest-ci with this?",
      "Add .inngest/ to .gitignore?",
    ]);
    expect(JSON.parse(read("inngest.json")).ci.start).toBe("tsx app/server.ts");
  });

  test("keeps the rest of inngest.json", async () => {
    write("inngest.json", JSON.stringify({ name: "x", ci: { dir: "out" } }));

    await configure({
      root: repo,
      gitRoot: repo,
      prompter: scripted(["accept", false]).prompter,
    });

    expect(JSON.parse(read("inngest.json"))).toEqual({
      name: "x",
      ci: { dir: "out", start: "tsx app/server.ts", path: "/api/inngest" },
    });
  });

  test("again runs setup though the config loads, keeping other keys", async () => {
    write(
      "inngest.json",
      JSON.stringify({
        ci: { start: "node broken.js", path: "/wrong", dir: "out" },
      }),
    );

    const config = await configure({
      root: repo,
      gitRoot: repo,
      prompter: scripted(["accept", false]).prompter,
      again: true,
    });

    expect(config).toMatchObject({
      start: "tsx app/server.ts",
      path: "/api/inngest",
    });
    expect(JSON.parse(read("inngest.json")).ci.dir).toBe("out");
  });

  test("without a prompter, it is an error with the snippet", async () => {
    await expect(
      configure({ root: repo, gitRoot: repo }),
    ).rejects.toMatchObject({
      message: "There is no ci config in inngest.json.",
      fix: expect.stringContaining('"start": "tsx app/server.ts"'),
    });
    expect(existsSync(join(repo, "inngest.json"))).toBe(false);
  });

  test("with nothing found, even a terminal gets the error", async () => {
    rmSync(join(repo, "ci"), { recursive: true });

    await expect(
      configure({ root: repo, gitRoot: repo, prompter: scripted([]).prompter }),
    ).rejects.toThrow("@inngest/ci isn't set up");
  });
});
