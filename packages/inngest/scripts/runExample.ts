/* eslint-disable @inngest/internal/process-warn */
import { spawn, type SpawnOptionsWithoutStdio } from "child_process";
import fs from "fs";
import inquirer from "inquirer";
import minimist from "minimist";
import path from "path";

const exec = (
  command: string,
  args: string[] = [],
  options?: SpawnOptionsWithoutStdio
) => {
  return new Promise<number>((resolve, reject) => {
    const proc = spawn(command, args, { ...options, stdio: "inherit" });
    proc.on("close", () => {
      return proc.exitCode === 0 ? resolve(0) : reject(proc.exitCode);
    });
  });
};

const argv = minimist(process.argv.slice(2));

const inngestPath = path.join(__dirname, "..");
const examplesPath = path.join(__dirname, "..", "..", "..", "examples");

const examples: string[] = fs
  .readdirSync(examplesPath, { withFileTypes: true })
  .filter((file) => file.isDirectory())
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
      "inngest.tgz"
    );
    await exec(
      "npm",
      ["install", "--no-save", "--no-package-lock", relativeTgzPath],
      { cwd: examplePath }
    );

    await exec("npm", ["run", "dev"], {
      cwd: examplePath,
      env: { ...process.env, DEBUG: "inngest:*" },
    });
  });
