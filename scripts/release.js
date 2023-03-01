const path = require("path");
const { exec: rawExec, getExecOutput } = require("@actions/exec");

const { version } = require("../package.json");
const tag = `v${version}`;
const distPath = path.join(__dirname, "dist");

const exec = async (...args) => {
  const exitCode = await rawExec(...args);

  if (exitCode !== 0) {
    throw new Error(`Command exited with ${exitCode}`);
  }
};

(async () => {
  const { exitCode, stderr } = await getExecOutput(
    `git`,
    ["ls-remote", "--exit-code", "origin", "--tags", `refs/tags/${tag}`],
    {
      ignoreReturnCode: true,
    }
  );

  if (exitCode === 0) {
    console.log(
      `Action is not being published because version ${tag} is already published`
    );
    return;
  }

  if (exitCode !== 2) {
    throw new Error(`git ls-remote exited with ${exitCode}:\n${stderr}`);
  }

  // Release to npm
  await exec("npm", ["config", "set", "git-tag-version", "false"], {
    cwd: distPath,
  });
  await exec("npm", ["publish", "--tag", "changeset", "--access", "public"], {
    cwd: distPath,
  });

  // Tag and push the release commit
  await exec("git", ["add", "."]);
  await exec("git", ["commit", "-m", tag]);
  await exec("changeset", ["tag"]);
  await exec("git", ["push", "--follow-tags", "origin", "changesets-release"]);
})();
