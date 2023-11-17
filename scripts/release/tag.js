const path = require("path");
const { exec: rawExec, getExecOutput } = require("@actions/exec");

const branch = process.env.BRANCH;
if (branch !== "main" && !branch.endsWith(".x")) {
  throw new Error(
    `Stopping release from branch ${branch}; only "main" and "v*.x" branches are allowed to release`
  );
}
console.log("branch:", branch);

const exec = async (...args) => {
  // const exitCode = await rawExec(...args);
  // if (exitCode !== 0) {
  //   throw new Error(`Command exited with ${exitCode}`);
  // }
};

const repoRootDir = path.join(__dirname, "..", "..");

(async () => {
  // Tag and push the release commit
  console.log('running "changeset tag" to tag the release commit');
  await exec("changeset", ["tag"], { cwd: repoRootDir });

  console.log(`pushing git tags to origin/${branch}`);
  await exec("git", ["push", "--follow-tags", "origin", branch]);
})();
