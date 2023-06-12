const path = require("path");
const { exec: rawExec, getExecOutput } = require("@actions/exec");

const branch = process.env.BRANCH;
if (branch !== "main" && !branch.endsWith(".x")) {
  throw new Error(
    `Stopping release from branch ${branch}; only "main" and "v*.x" branches are allowed to release`,
  );
}

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
    },
  );

  if (exitCode === 0) {
    console.log(
      `Action is not being published because version ${tag} is already published`,
    );
    return;
  }

  if (exitCode !== 2) {
    throw new Error(`git ls-remote exited with ${exitCode}:\n${stderr}`);
  }

  // Get current latest version
  const { exitCode: latestCode, stdout: latestStdout, stderr: latestStderr } =
    await getExecOutput("npm", ["dist-tag", "ls"]);

  if (latestCode !== 0) {
    throw new Error(`npm dist-tag ls exited with ${latestCode}:\n${latestStderr}`);
  }

  const latestVersion = latestStdout.split("\n").find((line) => line.startsWith("latest: "))?.split(" ")[1];

  if (!latestVersion) {
    throw new Error(`Could not find "latest" dist-tag in:\n${latestStdout}`);
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
    },
  );

  // If this was a backport release, republish the "latest" tag at the actual latest version
  if (branch !== "main" && distTag === "latest") {
    await exec("npm", ["dist-tag", "add", `inngest@${latestVersion}`, "latest"]);
  }

  // Tag and push the release commit
  await exec("changeset", ["tag"]);
  await exec("git", ["push", "--follow-tags", "origin", branch]);
})();
