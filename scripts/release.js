const path = require("path");
const { exec: rawExec, getExecOutput } = require("@actions/exec");

const { version } = require("../package.json");
const tag = `v${version}`;

const [, tagEnd = ""] = version.split("-");
const distTag = tagEnd.split(".")[0] || "latest";

const rootDir = path.join(__dirname, "..");
const distDir = path.join(rootDir, "dist");
process.chdir(rootDir);

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
    cwd: distDir,
  });
  await exec(
    "npm",
    ["publish", "--tag", distTag, "--access", "public", "--provenance"],
    {
      cwd: distDir,
    }
  );

  // Tag and push the release commit
  await exec("changeset", ["tag"]);
  await exec("git", ["push", "--follow-tags", "origin", "main"]);
})();
