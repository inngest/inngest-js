const github = require("@actions/github");
const fs = require("fs").promises;
const path = require("path");

const token = process.env.GITHUB_TOKEN;
const octokit = github.getOctokit(token);

const rootDir = path.resolve(__dirname, "..");

async function getChangedPackages() {
  const prNumber = github.context.payload.pull_request.number;
  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;

  const { data: files } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
  });

  const changedPackages = new Set();

  for (const file of files) {
    if (file.filename.startsWith("packages/")) {
      const packageName = file.filename.split("/")[1];
      changedPackages.add(packageName);
    }
  }

  return changedPackages;
}

async function getLabelsForPackages(packageNames) {
  const labels = [];

  for (const packageName of packageNames) {
    const packageJsonPath = path.resolve(
      rootDir,
      "packages",
      packageName,
      "package.json"
    );
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
    const label = `📦 ${packageJson.name}`;
    labels.push(label);
  }

  return labels;
}

async function labelPR(labels) {
  if (labels.length === 0) return;

  const prNumber = github.context.payload.pull_request.number;
  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;

  await octokit.rest.issues.addLabels({
    owner,
    repo,
    issue_number: prNumber,
    labels: labels,
  });
}

async function run() {
  const changedPackages = await getChangedPackages();
  if (changedPackages.size > 0) {
    const labels = await getLabelsForPackages(changedPackages);
    await labelPR(labels);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
