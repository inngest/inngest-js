import {
  type ChildProcess,
  exec,
  execSync,
  type SpawnOptions,
  spawn,
} from "child_process";
import { promises as fsPromises } from "fs";
import * as path from "path";

const pollInterval = 1000; // 1 second

async function checkServerReady(
  apiUrl: string,
  timeout: number,
): Promise<void> {
  let error;
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(apiUrl);
      if (response.ok) {
        console.log(`Server is ready at ${apiUrl}`);
        return;
      }
      throw new Error(
        `Server not ready at ${apiUrl}: ${response.status}, ${await response.text()}`,
      );
    } catch (e) {
      error = e;
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }
  console.log("Server not ready:", error);
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
  const exampleName = path.basename(examplePath);

  // If Bun is seen, use it. Otherwise, use npm. Hacky, but this doesn't need to
  // be fancy.
  if (exampleName.startsWith("bun") || exampleName.includes("elysiajs")) {
    await execAsync(
      "bun add --no-save inngest@../../packages/inngest/inngest.tgz",
      {
        cwd: examplePath,
      },
    );
  } else {
    await execAsync(
      "npm install --no-save --legacy-peer-deps ../../packages/inngest/inngest.tgz",
      {
        cwd: examplePath,
      },
    );
  }

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
        },
      );
    },
  );

  const exampleFunctionsPath = path.join(
    examplePath,
    path.dirname(exampleFunctionsTarget),
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
    { cwd: examplePath },
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
      },
    );
  });

  for (const file of tsFiles) {
    if (file) {
      const fileContents = await fsPromises.readFile(file);
      await fsPromises.writeFile(
        file,
        "// @ts-nocheck\n" + fileContents.toString(),
      );
    }
  }
}

function startProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
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
  devServerPort: number,
  exampleServerPort: number,
  examplePath: string,
): Promise<void> {
  const serverProcess = startProcess(
    "npx",
    [
      "--yes",
      "inngest-cli@latest",
      "dev",
      "--port",
      devServerPort.toString(),
      "--no-discovery",
      "--no-poll",
      "--retry-interval",
      "1",
      "--log-level",
      "trace",
      "--sdk-url",
      `http://localhost:${exampleServerPort}/api/inngest`,
    ],
    {
      env: { ...process.env, DO_NOT_TRACK: "1" },
      cwd: examplePath,
      detached: true,
      stdio: "inherit",
    },
  );

  serverProcess.unref();

  return checkServerReady(`http://localhost:${devServerPort}`, 60000);
}

async function startExampleServer(
  examplePath: string,
  exampleServerPort: number,
  devServerPort: number,
): Promise<void> {
  const exampleName = path.basename(examplePath);
  const env = {
    ...process.env,
    HOST: "0.0.0.0",
    PORT: "3000",
    NODE_ENV: "development",
    INNGEST_LOG_LEVEL: "debug",
    INNGEST_BASE_URL: `http://localhost:${devServerPort}`,
  } as const;
  const command = exampleName.startsWith("bun") ? "bun" : "npm";

  startProcess(command, ["run", "dev"], {
    env,
    cwd: examplePath,
    detached: true,
    stdio: "inherit",
  });

  return checkServerReady(
    `http://localhost:${exampleServerPort}/api/inngest`,
    60000,
  );
}

async function registerExample(exampleServerPort: number): Promise<void> {
  console.log("Registering...");
  try {
    const registerRes = await fetch(
      `http://localhost:${exampleServerPort}/api/inngest`,
      {
        method: "PUT",
      },
    );

    console.log(
      "Register response:",
      registerRes.status,
      registerRes.statusText,
    );
  } catch (err) {
    console.error("Failed to register example", err);
    throw err;
  }
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

// If an example has no current changes, return a function that resets it back
// to that state after integration tests have run. If it has changes, return
// undefined.
async function getExampleResetter(
  examplePath: string,
): Promise<(() => Promise<void>) | undefined> {
  const exampleGitStatus = await new Promise<string>((resolve, reject) => {
    exec("git status --porcelain .", { cwd: examplePath }, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout.toString().trim());
      }
    });
  });

  if (exampleGitStatus) {
    console.log("Example has changes, not resetting", exampleGitStatus);
    return undefined;
  }

  console.log("Example has no changes, will reset after tests");

  let hasReset = false;

  const resetter = async () => {
    if (hasReset) return;
    hasReset = true;

    console.log("Resetting example");
    await execAsync("git checkout -- .", { cwd: examplePath });
    await execAsync("git clean -fd .", { cwd: examplePath });
  };

  return resetter;
}

async function runIntegrationTest(
  example: string,
  devServerPort: number,
  exampleServerPort: number,
): Promise<void> {
  // Start a 10 minute timeout. If we don't finish within 10 minutes, something
  // is wrong.
  setTimeout(
    () => {
      console.error("Integration test timed out");
      process.exit(1);
    },
    10 * 60 * 1000,
  );

  const rootPath = path.join(import.meta.dirname, "..", "..", "..");
  const sdkPath = path.join(rootPath, "packages", "inngest");
  const examplePath = path.join(rootPath, "examples", example);

  const reset = await getExampleResetter(examplePath);

  const startExamplePromise = (async () => {
    await setupExample(examplePath);
    await startExampleServer(examplePath, exampleServerPort, devServerPort);
  })();

  const startDevServerPromise = startDevServer(
    devServerPort,
    exampleServerPort,
    examplePath,
  );

  await Promise.all([startExamplePromise, startDevServerPromise]);
  await registerExample(exampleServerPort);

  runTests(sdkPath);

  await reset?.().catch((err) => {
    console.warn("Failed to reset example", err);
  });
}

const example = process.argv[2];
const devServerPort = parseInt(process.argv[3] ?? "8288", 10);
const exampleServerPort = parseInt(process.argv[4] ?? "3000", 10);

// Validate input arguments.
if (!example || isNaN(devServerPort) || isNaN(exampleServerPort)) {
  console.error(
    "Usage: tsx integrationTestRunner.ts <example> <devServerPort> <exampleServerPort>",
  );
  process.exit(1);
}

console.log(
  `Running integration test for ${example} using port ${exampleServerPort} and dev server port ${devServerPort}`,
);

runIntegrationTest(example, devServerPort, exampleServerPort)
  .then(() => {
    console.log("itest successful");
    process.exit(0);
  })
  .catch((error) => {
    console.error("itest failed:", error);
    process.exit(1);
  });
