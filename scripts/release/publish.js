const path = require("path");
const { exec: rawExec, getExecOutput } = require("@actions/exec");

const branch = process.env.BRANCH;
if (branch !== "main" && !branch.endsWith(".x")) {
  throw new Error(
    `Stopping release from branch ${branch}; only "main" and "v*.x" branches are allowed to release`
  );
}
console.log("branch:", branch);

const name = process.env.npm_package_name;
const version = process.env.npm_package_version;
console.log("version:", version);
const tag = `${name}@${version}`;
console.log("tag:", tag);

const [, tagEnd = ""] = version.split("-");
let distTag = tagEnd.split(".")[0] || "latest";
// Backport branches publish under their own dist-tag (e.g. `v3-lts`) so they
// never touch `latest`.
if (branch !== "main") {
  distTag = `${branch}-lts`;
}
console.log("distTag:", distTag);

console.log("process.cwd()", process.cwd());

const packageRootDir = process.cwd();
console.log("package root:", packageRootDir);
const repoRootDir = path.join(packageRootDir, "..", "..");
console.log("repo root:", repoRootDir);
const distDir = process.env.DIST_DIR
  ? path.join(packageRootDir, process.env.DIST_DIR)
  : packageRootDir;
console.log("dist dir:", distDir);
process.chdir(packageRootDir);

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

  console.log("publishing", tag, "to dist tag:", distTag);
  const {
    exitCode: publishExitCode,
    stdout: publishStdout,
    stderr: publishStderr,
  } = await getExecOutput(
    "npm",
    ["publish", "--tag", distTag, "--access", "public", "--provenance"],
    {
      cwd: distDir,
      ignoreReturnCode: true,
    }
  );

  if (publishExitCode !== 0) {
    // It could be a non-zero code if the package was already published by
    // another action or human. If this is the case, we should not fail the
    // action.
    const duplicatePublishMsg =
      "cannot publish over the previously published versions";

    if (
      publishStdout.includes(duplicatePublishMsg) ||
      publishStderr.includes(duplicatePublishMsg)
    ) {
      console.log("npm publish failed but it's okay; it's already published");

      return;
    }

    throw new Error(`npm publish exited with ${publishExitCode}`);
  }

  console.log("Publish successful");
})();
