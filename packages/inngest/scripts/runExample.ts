import { type SpawnOptionsWithoutStdio, spawn } from "child_process";
import fs from "fs";
import inquirer from "inquirer";
import minimist from "minimist";
import path from "path";

const exec = (
  command: string,
  args: string[] = [],
  options?: SpawnOptionsWithoutStdio,
) => {
  return new Promise<number>((resolve, reject) => {
    const proc = spawn(command, args, { ...options, stdio: "inherit" });
    proc.on("close", () => {
      return proc.exitCode === 0 ? resolve(0) : reject(proc.exitCode);
    });
  });
};

const argv = minimist(process.argv.slice(2));

const inngestPath = path.join(import.meta.dirname, "..");
const examplesPath = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "examples",
);

const allowedPrefixes = ["framework-", "bun"];

const examples: string[] = fs
  .readdirSync(examplesPath, { withFileTypes: true })
  .filter(
    (file) =>
      file.isDirectory() &&
      allowedPrefixes.some((prefix) => file.name.startsWith(prefix)),
  )
  .map((file) => file.name);

const exampleFromFlag: string = (argv.example as string) ?? "";

if (exampleFromFlag && !examples.includes(exampleFromFlag)) {
  console.error(`Example "${exampleFromFlag}" not found`);
  process.exit(1);
}

void inquirer
  .prompt([
    {
      type: "list",
      name: "example",
      message: "Which example would you like to run?",
      choices: examples,
      when: () => !exampleFromFlag,
    },
  ])
  .then(async ({ example = exampleFromFlag }: { example: string }) => {
    console.log("Running example:", example);
    const examplePath = path.join(examplesPath, example);

    await exec("pnpm", ["install"], { cwd: inngestPath });
    await exec("pnpm", ["run", "-r", "local:pack"], { cwd: inngestPath });

    const relativeTgzPath = path.join(
      path.relative(examplePath, inngestPath),
      "inngest.tgz",
    );

    const devServerEnv = {
      ...process.env,
      DEBUG: "inngest:*",
      INNGEST_BASE_URL: "http://127.0.0.1:8288",
    };

    // If Bun is seen, use it. Otherwise, use npm. Hacky, but this doesn't need
    // to be fancy.
    if (example.startsWith("bun")) {
      // Force reinstalling, otherwise it can just see the local package/version
      // and stick to a stale version.
      await exec("bun", ["remove", "inngest"], {
        cwd: examplePath,
      });

      await exec("bun", ["add", "--no-save", `inngest@${relativeTgzPath}`], {
        cwd: examplePath,
      });

      await exec("bun", ["run", "dev"], {
        cwd: examplePath,
        env: devServerEnv,
      });

      return;
    }
    // For everything else
    await exec(
      "npm",
      ["install", "--no-save", "--no-package-lock", relativeTgzPath],
      { cwd: examplePath },
    );

    await exec("npm", ["run", "dev"], {
      cwd: examplePath,
      env: devServerEnv,
    });
  });
