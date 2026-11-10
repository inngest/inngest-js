const path = require("path");
const { exec: rawExec, getExecOutput } = require("@actions/exec");

const tag = process.env.TAG;

// Tags that are real release channels: a prerelease must never move one of
// them, however it was derived.
const reservedTags = ["latest", "next", "beta", "alpha", "rc", "canary"];

// Set by the workflow only in the branch that derives the tag from a
// `prerelease-tag/<tag>` label, where the label has already been sanitised
// (lowercased, non-alphanumerics collapsed to hyphens, semver-shaped values
// rejected). Without it, only `pr-*` may release.
const labelDerived = Boolean(process.env.ALLOW_LABEL_TAG);

if (!tag) {
  throw new Error("Stopping prerelease: no TAG was given");
}

if (!tag.startsWith("pr-") && !labelDerived) {
  throw new Error(
    `Stopping prerelease from tag ${tag}; only "pr-*" tags, or a tag the workflow derived from a prerelease-tag/* label (ALLOW_LABEL_TAG), are allowed to release`
  );
}

if (reservedTags.includes(tag)) {
  throw new Error(
    `Stopping prerelease from tag ${tag}; it is a release channel (${reservedTags.join(", ")}) and publishing would move it off the released version`
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
