/**
 * @module
 * Proves `repo()` with a read-only sandbox and a host-side push. The sandbox
 * clones a repository that anyone may read (it holds no credential), makes
 * commits, and the model's `push` tool sends them through the host: the sandbox
 * bundles the new commits once, the policy checks them, and the host pushes
 * with a write token that is in no command, file or result of the sandbox. A
 * branch under `agent/` goes through; `main` is refused by the policy, and
 * the refusal is a tool error the model can read.
 */
import { execFileSync } from "node:child_process";
import {
  agent,
  openSandboxes,
  repo,
  sandbox,
} from "inngest/experimental/agents";
import { scenario, script } from "../kit/driver.ts";
import { type GitRemote, startGitRemote } from "../kit/gitRemote.ts";

const writeToken = "ghs_kit_write_token_9d41ce";

let started: Promise<GitRemote> | undefined;

const prepare = (): Promise<GitRemote> => {
  started ??= startGitRemote({ token: writeToken, anonymousReads: true });

  return started;
};

export const repoHostPush = scenario({
  id: "repo-host-push",
  owner: "agents-git-batch",
  sandbox: "fake",
  functions: ({ client, event }) => {
    return [
      client.createFunction(
        { id: "repo-host-push-fn", triggers: [{ event: event("go") }] },
        async ({ step }) => {
          const remote = await prepare();
          const bench = sandbox({
            id: "workbench",
            tools: sandbox.tools.code(),
          });
          const sandboxes = openSandboxes({ work: bench }, step.sandbox);

          try {
            const work = await sandboxes.work?.get();

            if (!work) {
              throw new Error("no sandbox");
            }

            const checkout = await repo(work, {
              repo: remote.url,
              push: {
                token: () => {
                  return writeToken;
                },
                policy: (push) => {
                  if (!push.branch?.startsWith("agent/")) {
                    return { refuse: "only agent/* branches may be pushed" };
                  }

                  return { notes: [`checked ${push.paths.length} path(s)`] };
                },
              },
            });

            for (const branch of ["agent/host", "main"]) {
              await work.commands.run(`edit:${branch}`, [
                "/bin/sh",
                "-c",
                `cd /work && git checkout -q -B ${branch} && echo ${branch} > NOTES-${branch.replace("/", "-")}.md && git add . && git commit -q -m "edit ${branch}"`,
              ]);
            }

            const result = await agent.loop({
              model: script([
                { call: { name: "push", input: { branch: "agent/host" } } },
                { call: { name: "push", input: { branch: "main" } } },
                { say: "done" },
              ]),
              prompt: "push everything",
              tools: { push: checkout.tools.push },
            });

            return {
              text: result.text,
              action: checkout.action,
              pushes: result.toolCalls.map((call) => {
                return { isError: call.isError, output: String(call.output) };
              }),
              heads: execFileSync(
                "git",
                ["for-each-ref", "--format=%(refname)"],
                { cwd: remote.dir, encoding: "utf8" },
              )
                .trim()
                .split("\n")
                .sort(),
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

    const output = run.output as {
      pushes: { isError: boolean; output: string }[];
      heads: string[];
    };

    ctx.check(
      "the policy let agent/host through and refused main",
      output.pushes[0]?.isError === false &&
        output.pushes[0]?.output === "pushed agent/host" &&
        output.pushes[1]?.isError === true &&
        output.pushes[1]?.output.includes("only agent/* branches"),
      output.pushes,
    );
    ctx.check(
      "the remote got the branch",
      output.heads.includes("refs/heads/agent/host") &&
        !output.heads.includes("refs/heads/agent/main"),
      output.heads,
    );

    const calls = JSON.stringify(ctx.fakes.posts({ channel: "sandbox" }));

    ctx.check(
      "the write token was never in the sandbox",
      !calls.includes(writeToken),
    );
    ctx.check(
      "the write token is not in the run",
      !JSON.stringify(run).includes(writeToken),
    );
  },
});
