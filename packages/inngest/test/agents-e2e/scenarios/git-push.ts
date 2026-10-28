/**
 * @module
 * Proves the `git_push` agent tool. The model pushes three branches from a
 * sandbox that runs real git, to a remote that wants a token. A branch under
 * `agent/` goes through; a push to `main` and a branch whose changes contain a
 * secret are refused by the policy. The token is held by the function only: it
 * is in no command, file or result the sandbox saw, and in no run output.
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
import { scenario, script } from "../kit/driver.ts";
import { type GitRemote, startGitRemote } from "../kit/gitRemote.ts";

const token = "ghs_kit_remote_token_4f9a1c";
// One directory per app process: every kit run on the machine shares the temp
// directory, and a run that cleared a shared one would pull the repository out
// from under another run's push.
const work = join(tmpdir(), `git-push-kit-work-${process.pid}`);

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

let started: Promise<GitRemote> | undefined;

/**
 * Starts the remote once and makes a clone of it with a branch for each push.
 */
const prepare = (): Promise<GitRemote> => {
  started ??= (async () => {
    const remote = await startGitRemote(token);

    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    process.on("exit", () => {
      rmSync(work, { recursive: true, force: true });
    });
    git(work, "clone", "--quiet", remote.dir, ".");

    const branch = (name: string, file: string, text: string) => {
      git(work, "checkout", "--quiet", "-B", name, "origin/main");
      writeFileSync(join(work, file), text);
      git(work, "add", ".");
      git(work, "commit", "--quiet", "-m", `edit ${file}`);
    };

    branch("agent/ok", "NOTES.md", "a note\n");
    branch("main", "src/a.ts", "export const a = 2;\n");
    branch(
      "agent/leak",
      "config.ts",
      'export const key = "AKIAIOSFODNN7EXAMPLE";\n',
    );

    return remote;
  })();

  return started;
};

export const gitPush = scenario({
  id: "git-push",
  owner: "agents-git-push-tool",
  sandbox: "fake",
  sandboxLocalDirs: [work],
  functions: ({ client, event }) => {
    return [
      client.createFunction(
        { id: "git-push-fn", triggers: [{ event: event("go") }] },
        async ({ step }) => {
          const remote = await prepare();
          // The remote's port is only known now, so the tool is built here.
          const bench = sandbox({
            id: "workbench",
            tools: sandbox.tools.git({
              remote: remote.url,
              token: () => {
                return token;
              },
              cwd: work,
              policy: async (push) => {
                if (!push.branch?.startsWith("agent/")) {
                  return { refuse: "only agent/* branches may be pushed" };
                }

                if (/AKIA[0-9A-Z]{16}/.test(await push.patch())) {
                  return { refuse: "the changes contain a secret" };
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
                { say: "done" },
              ]),
              prompt: "push everything",
              tools: sandboxTools(sandboxes),
            });
            const heads = await step.run("remote-heads", () => {
              return git(remote.dir, "for-each-ref", "--format=%(refname)")
                .split("\n")
                .sort();
            });

            return {
              text: result.text,
              pushes: result.toolCalls.map((call) => {
                return {
                  isError: call.isError,
                  output: JSON.stringify(call.output).replace(
                    /"sha":"[0-9a-f]+"/g,
                    '"sha":"<sha>"',
                  ),
                };
              }),
              heads,
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
      ],
      heads: ["refs/heads/agent/ok", "refs/heads/main"],
    });

    const calls = JSON.stringify(ctx.fakes.posts({ channel: "sandbox" }));

    ctx.check("the sandbox saw git commands", calls.includes("bundle"), calls);
    ctx.check("the token was never in the sandbox", !calls.includes(token));
    ctx.check(
      "the token is not in the run",
      !JSON.stringify(run).includes(token),
    );
  },
});
