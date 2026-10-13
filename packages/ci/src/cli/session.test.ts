/**
 * Tests for the session's offer to run setup again when the config is wrong.
 * The Dev Server and the app are faked; the config, detection and prompts are
 * real.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { parseCliArgs } from "./args.ts";
import type { SessionEvent } from "./events.ts";
import type { Prompter } from "./prompter.ts";
import { runSession } from "./session.ts";
import { SetupError } from "./setupError.ts";

const mocks = vi.hoisted(() => {
  return { waitForSync: vi.fn() };
});

vi.mock("./app.ts", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("./app.ts")>()),
    startApp: vi.fn(),
    waitForSync: mocks.waitForSync,
  };
});

vi.mock("./devServer.ts", () => {
  return {
    resolveDevServerBin: vi.fn(),
    devServerDir: vi.fn(),
    startDevServer: vi.fn(async () => {
      return { url: "http://127.0.0.1:1", dir: "dir", process: {} };
    }),
  };
});

vi.mock("./process.ts", async (importOriginal) => {
  return {
    ...(await importOriginal<typeof import("./process.ts")>()),
    reapStaleGroups: vi.fn(),
    stopGroup: vi.fn(),
  };
});

const args = parseCliArgs([]);

let repo: string;

const write = (path: string, contents: string): void => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), contents);
};

/** Answers from a script, and records the questions in order. */
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

const run = async (prompter: Prompter) => {
  const events: SessionEvent[] = [];
  const result = await runSession({
    cwd: repo,
    args,
    sessionId: "s",
    prompter,
    emit: (event) => {
      events.push(event);
    },
    signal: new AbortController().signal,
  });

  return { result, events };
};

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "ci-session-")));

  execFileSync("git", ["init", "-q"], { cwd: repo });
  write("ci/client.ts", "export const ci = createCi(inngest);");
  write(
    "app/server.ts",
    'import { createServer } from "inngest/node";\ncreateServer({ functions: ci.functions() }).listen(process.env.PORT);',
  );
  write("inngest.json", JSON.stringify({ ci: { start: "tsx broken.ts" } }));

  mocks.waitForSync.mockReset();
  mocks.waitForSync.mockRejectedValueOnce(
    new SetupError("The app exited before it was ready.", {
      reconfigurable: true,
    }),
  );
  mocks.waitForSync.mockRejectedValue(new SetupError("Still broken."));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("a config that doesn't work", () => {
  test("offers setup again and, on yes, starts over with the detected config", async () => {
    const { prompter, asked } = scripted([true, "accept", false]);
    const { result, events } = await run(prompter);

    expect(asked).toEqual([
      "Run setup again?",
      "Run inngest-ci with this?",
      "Add .inngest/ to .gitignore?",
    ]);
    expect(
      events
        .filter((event) => {
          return event.kind === "setup-error" || event.kind === "restart";
        })
        .map((event) => {
          return event.kind === "setup-error" ? event.message : event.kind;
        }),
    ).toEqual([
      "The app exited before it was ready.",
      "restart",
      "Still broken.",
    ]);
    expect(
      JSON.parse(readFileSync(join(repo, "inngest.json"), "utf8")).ci.start,
    ).toBe("tsx app/server.ts");
    expect(result.conclusion).toBe("setup-error");
  });

  test("on no, ends with the error", async () => {
    const { prompter, asked } = scripted([false]);
    const { result, events } = await run(prompter);

    expect(asked).toEqual(["Run setup again?"]);
    expect(
      events.some((event) => {
        return event.kind === "restart";
      }),
    ).toBe(false);
    expect(result.conclusion).toBe("setup-error");
  });

  test("backing out of the question is a no", async () => {
    const prompter = {
      choose: async () => {
        throw new Error("Cancelled.");
      },
    } as unknown as Prompter;

    expect((await run(prompter)).result.conclusion).toBe("setup-error");
  });

  test("an error that setup can't fix isn't offered", async () => {
    mocks.waitForSync.mockReset();
    mocks.waitForSync.mockRejectedValue(new SetupError("The Dev Server died."));

    const { prompter, asked } = scripted([]);

    await run(prompter);

    expect(asked).toEqual([]);
  });
});

describe("no config in a terminal", () => {
  test("backing out of setup cancels, without an error", async () => {
    write("inngest.json", "{}");

    const { PromptCancelled } = await import("./prompter.ts");
    const prompter = {
      review: async () => {
        throw new PromptCancelled();
      },
    } as unknown as Prompter;
    const { result, events } = await run(prompter);

    expect(result.conclusion).toBe("cancelled");
    expect(
      events.some((event) => {
        return event.kind === "setup-error";
      }),
    ).toBe(false);
  });
});

describe("the Sandbox access check", () => {
  const answer = (status: number, code: string) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ errors: [{ code, message: "x" }] }),
          { status },
        );
      }),
    );
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("not logged in stops before the app starts", async () => {
    const { startApp } = await import("./app.ts");

    answer(401, "cloud_login_required");
    vi.mocked(startApp).mockClear();

    const { result, events } = await run(scripted([]).prompter);
    const error = events.find((event) => {
      return event.kind === "setup-error";
    });

    expect(result.conclusion).toBe("setup-error");
    expect(error).toMatchObject({
      message: expect.stringContaining("isn't logged in"),
      fix: expect.stringContaining("npx inngest-cli@latest login"),
    });
    expect(startApp).not.toHaveBeenCalled();
  });

  test("an account without access stops the same way", async () => {
    answer(403, "access_denied");

    const { events } = await run(scripted([]).prompter);

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "setup-error",
        message: expect.stringContaining("can't use Sandboxes"),
      }),
    );
  });

  test("an unknown error passes through to the next step", async () => {
    answer(500, "internal_error");

    const { events } = await run(scripted([]).prompter);

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "setup-error",
        message: "The app exited before it was ready.",
      }),
    );
  });
});
