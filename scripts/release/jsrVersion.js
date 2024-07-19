const path = require("path");
const fs = require("fs");
const { exec: rawExec, getExecOutput } = require("@actions/exec");

const packageRootDir = process.cwd();
const version = process.env.npm_package_version;

const exec = async (...args) => {
  const exitCode = await rawExec(...args);
  if (exitCode !== 0) {
    throw new Error(`Command exited with ${exitCode}`);
  }
};

(async () => {
  // If this package has a `jsr.json` file, also update the version there
  const jsrFilePath = path.join(packageRootDir, "jsr.json");
  if (!fs.existsSync(jsrFilePath)) {
    return;
  }

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageRootDir, "package.json"), "utf8")
  );

  const version = packageJson.version;
  console.log({ version });

  const jsr = JSON.parse(fs.readFileSync(jsrFilePath, "utf8"));
  jsr.version = version;
  fs.writeFileSync(jsrFilePath, JSON.stringify(jsr, null, 2));
})();
