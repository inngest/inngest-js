const path = require("path");
const { exec: rawExec, getExecOutput } = require("@actions/exec");

const tag = process.env.TAG;
if (!tag || !tag.startsWith("pr-")) {
  throw new Error(
    `Stopping prerelease from tag ${tag}; only "pr-*" tags are allowed to release`
  );
}

console.log("tag:", tag);
const packageRootDir = process.cwd();
console.log("package root:", packageRootDir);
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
  // Get current latest tag version
  const {
    exitCode: latestCode,
    stdout: latestStdout,
    stderr: latestStderr,
  } = await getExecOutput("npm", ["dist-tag", "ls"]);

  if (latestCode !== 0) {
    throw new Error(
      `npm dist-tag ls exited with ${latestCode}:\n${latestStderr}`
    );
  }

  const latestVersion = latestStdout
    .split("\n")
    .find((line) => line.startsWith(`${tag}: `))
    ?.split(" ")[1];

  if (latestVersion) {
    // Set the latest version first; these snapshots are not checked into Git
    await exec("npm", [
      "version",
      "--allow-same-version",
      "--no-git-tag-version",
      latestVersion,
    ]);
  }

  // Always bump
  await exec("npm", [
    "version",
    "--no-git-tag-version",
    "--preid",
    tag,
    "prerelease",
  ]);

  // Release to npm
  await exec("npm", ["config", "set", "git-tag-version", "false"], {
    cwd: distDir,
  });

  console.log("publishing", tag);
  await exec(
    "npm",
    ["publish", "--tag", tag, "--access", "public", "--provenance"],
    {
      cwd: distDir,
    }
  );
})();
