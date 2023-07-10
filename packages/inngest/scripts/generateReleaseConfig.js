const fs = require("node:fs");
const path = require("node:path");

const config = {
  "$schema": "https://unpkg.com/@changesets/config@2.3.0/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": process.env.BRANCH || "main",
  "updateInternalDependencies": "patch",
  "ignore": [],
};

console.log("Writing release config:", config);

const rootDir = path.join(__dirname, "..");
process.chdir(rootDir);

const changesetDir = path.join(rootDir, ".changeset");
const configName = "config.json";
const configPath = path.join(changesetDir, configName);

const serializedConfig = JSON.stringify(config, null, 2);

fs.writeFileSync(
  configPath,
  serializedConfig,
);
