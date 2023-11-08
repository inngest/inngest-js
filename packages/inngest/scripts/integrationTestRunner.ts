/* eslint-disable @inngest/internal/process-warn */
import {
  exec,
  execSync,
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "child_process";
import { promises as fsPromises } from "fs";
import * as path from "path";

const pollInterval = 1000; // 1 second

async function checkServerReady(
  apiUrl: string,
  timeout: number
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(apiUrl);
      if (response.ok) {
        console.log(`Server is ready at ${apiUrl}`);
        return;
      }
      throw new Error("Server not ready");
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }
  throw new Error(`Server did not start within ${timeout / 1000} seconds.`);
}

function execAsync(command: string, options: { cwd: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = exec(command, options, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error: ${stderr}`);
        reject(error);
      } else {
        console.log(stdout);
        resolve();
      }
    });

    proc.stdout?.pipe(process.stdout);
    proc.stderr?.pipe(process.stderr);
  });
}

async function setupExample(examplePath: string): Promise<void> {
  await execAsync("npm install ../../packages/inngest/inngest.tgz", {
    cwd: examplePath,
  });

  const exampleFunctionsTarget = await new Promise<string>(
    (resolve, reject) => {
      exec(
        "git ls-files | grep inngest/index.ts",
        { cwd: examplePath },
        (error, stdout) => {
          if (error) {
            reject(error);
          } else {
            resolve(stdout.toString().trim());
          }
        }
      );
    }
  );

  const exampleFunctionsPath = path.join(
    examplePath,
    path.dirname(exampleFunctionsTarget)
  );

  //   const sdkFunctionsPath = path.join(examplePath, "inngest");
  try {
    await fsPromises.rmdir(exampleFunctionsPath, { recursive: true });
  } catch (error) {
    if ((error as { code?: string })?.code !== "ENOENT") throw error;
  }
  await fsPromises.mkdir(exampleFunctionsPath, { recursive: true });

  await execAsync(
    `cp -r ../../packages/inngest/src/test/functions/* ${exampleFunctionsPath}/`,
    { cwd: examplePath }
  );

  const eslintIgnorePath = path.join(examplePath, ".eslintignore");
  await fsPromises.appendFile(eslintIgnorePath, "**/inngest/**\n");

  const tsFiles = await new Promise<string[]>((resolve, reject) => {
    exec(
      `find ${exampleFunctionsPath} -type f -name "*.ts"`,
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout.toString().trim().split("\n"));
        }
      }
    );
  });

  for (const file of tsFiles) {
    if (file) {
      const fileContents = await fsPromises.readFile(file);
      await fsPromises.writeFile(
        file,
        "// @ts-nocheck\n" + fileContents.toString()
      );
    }
  }
}

function startProcess(
  command: string,
  args: string[],
  options: SpawnOptions
): ChildProcess {
  const proc = spawn(command, args, options);

  proc.on("error", (err) => {
    console.error(`Failed to start process: ${command}`, err);
    process.exit(1);
  });

  const killProcess = () => {
    if (typeof proc.pid !== "number") {
      console.warn(`Process ${command} has no pid`);
      return;
    }

    if (!proc.killed) {
      console.log(`Killing process ${command} with pid ${proc.pid}`);
      process.kill(-proc.pid);
    }
  };

  process.on("exit", killProcess);
  process.on("SIGINT", killProcess);
  process.on("SIGTERM", killProcess);
  process.on("uncaughtException", killProcess);

  return proc;
}

async function startDevServer(
  port: number,
  examplePath: string
): Promise<void> {
  const serverProcess = startProcess(
    "npx",
    ["inngest-cli@latest", "dev", "--port", port.toString()],
    {
      env: { ...process.env, DO_NOT_TRACK: "1" },
      cwd: examplePath,
      detached: true,
      stdio: "inherit",
    }
  );

  serverProcess.unref();

  return checkServerReady(`http://127.0.0.1:${port}`, 60000);
}

async function startExampleServer(
  examplePath: string,
  exampleServerPort: number,
  devServerPort: number
): Promise<void> {
  const devServerProcess = startProcess("npm", ["run", "dev"], {
    env: {
      ...process.env,
      HOST: "0.0.0.0",
      PORT: "3000",
      NODE_ENV: "development",
      INNGEST_LOG_LEVEL: "debug",
      INNGEST_BASE_URL: `http://127.0.0.1:${devServerPort}`,
    },
    cwd: examplePath,
    detached: true,
    stdio: "inherit",
  });

  devServerProcess.unref();

  return checkServerReady(
    `http://127.0.0.1:${exampleServerPort}/api/inngest`,
    60000
  );
}

function runTests(sdkPath: string): void {
  try {
    execSync("pnpm run test:examples", { cwd: sdkPath, stdio: "inherit" });
    console.log("Tests completed successfully");
  } catch (error) {
    console.error("Test suite failed to execute", error);
    process.exit(1);
  }
}

async function runIntegrationTest(
  example: string,
  devServerPort: number,
  exampleServerPort: number
): Promise<void> {
  const rootPath = path.join(__dirname, "..", "..", "..");
  const sdkPath = path.join(rootPath, "packages", "inngest");
  const examplePath = path.join(rootPath, "examples", example);

  // Start all the asynchronous operations.
  const startExamplePromise = setupExample(examplePath).then(() => {
    return startExampleServer(examplePath, exampleServerPort, devServerPort);
  });
  const startDevServerPromise = startDevServer(devServerPort, examplePath);

  // Use Promise.all to wait for all promises to resolve.
  await Promise.all([startExamplePromise, startDevServerPromise]);

  // Wait for 5 seconds for registration.
  console.log("Waitng for 10 seconds for registration...");
  await new Promise((resolve) => setTimeout(resolve, 10000));

  runTests(sdkPath);
}

const example = process.argv[2];
const devServerPort = parseInt(process.argv[3] ?? "?", 10);
const exampleServerPort = parseInt(process.argv[4] ?? "?", 10);

// Validate input arguments.
if (!example || isNaN(devServerPort) || isNaN(exampleServerPort)) {
  console.error(
    "Usage: tsx integrationTestRunner.ts <example> <devServerPort> <exampleServerPort>"
  );
  process.exit(1);
}

runIntegrationTest(example, devServerPort, exampleServerPort).catch((error) => {
  console.error(error);
  process.exit(1);
});
