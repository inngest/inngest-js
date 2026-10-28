/**
 * @module
 * The CLI behind `pnpm agents:verify <scenario...|--all> [--bin local@sha]
 * [--keep]`. It re-runs itself inside `devstack with --timeout`, so a crash
 * cannot leak a stack; inside, it starts one stack (Dev Server, Redis, the
 * kit app), runs the scenarios against it, prints PASS or FAIL lines and
 * stops the stack. Exits non-zero when anything fails.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakes } from "./kit/channels.ts";
import { createCtx, type Scenario } from "./kit/driver.ts";
import {
  devstack,
  devstackBin,
  ossRepo,
  stackName,
  startStack as startDevstack,
  stopStack as stopDevstack,
} from "./kit/stack.ts";
import {
  startStack as startDirect,
  stopStack as stopDirect,
} from "./kit/stack-direct.ts";
import { waitForSync } from "./kit/sync.ts";

const direct = process.env.AGENTS_VERIFY_STACK === "direct";
const startStack = direct ? startDirect : startDevstack;
const stopStack = direct ? stopDirect : stopDevstack;

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "../..");
const scenarioCapMs = 110_000;

const args = process.argv.slice(2);
const inner = args.includes("--inner");
const keep = args.includes("--keep");
const all = args.includes("--all");
let binFlag: string | undefined;
const requested: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i] as string;

  if (arg === "--bin") {
    binFlag = args[++i];

    if (!binFlag) {
      console.error("--bin needs a value, such as --bin local@<sha>");
      process.exit(2);
    }
  } else if (arg.startsWith("--bin=")) {
    binFlag = arg.slice("--bin=".length);
  } else if (arg.startsWith("--")) {
    if (!["--inner", "--keep", "--all"].includes(arg)) {
      console.error(`Unknown flag ${arg}`);
      process.exit(2);
    }
  } else {
    requested.push(arg);
  }
}

if (direct && keep) {
  console.error("--keep is not supported with AGENTS_VERIFY_STACK=direct");
  process.exit(2);
}

if (all && requested.length > 0) {
  console.error("Pass scenario ids or --all, not both");
  process.exit(2);
}

// Forwarded to the inner process, which is not under `devstack with`
// in direct or --keep mode, so a cancel still stops the stack.
const rebuilt = (): string[] => {
  return [...(binFlag ? ["--bin", binFlag] : []), ...(keep ? ["--keep"] : [])];
};

const listIds = () => {
  return readdirSync(join(here, "scenarios"))
    .filter((file) => {
      return file.endsWith(".ts");
    })
    .map((file) => {
      return file.slice(0, -3);
    })
    .sort();
};

const load = async (id: string) => {
  const module = (await import(`./scenarios/${id}.ts`)) as Record<
    string,
    unknown
  >;
  const found = Object.values(module).find((value) => {
    return (value as Scenario | undefined)?.id === id;
  });

  if (!found) {
    throw new Error(`scenarios/${id}.ts exports no scenario with id "${id}"`);
  }

  return found as Scenario;
};

const ids = all ? listIds() : requested;

if (ids.length === 0) {
  console.error(
    "Usage: pnpm agents:verify <scenario...|--all> [--bin local@sha] [--keep]",
  );
  console.error(`Scenarios: ${listIds().join(", ")}`);
  process.exit(2);
}

for (const id of ids) {
  if (!listIds().includes(id)) {
    console.error(`No scenario "${id}". Scenarios: ${listIds().join(", ")}`);
    process.exit(2);
  }
}

const branch = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: here,
      encoding: "utf8",
    }).trim();
  } catch {
    return process.env.GITHUB_REF_NAME ?? "local";
  }
})();
// Unique to this process, so two runs of the same branch and scenarios on one
// machine never share (or stop) a stack or an expect file.
const name = `${stackName(branch, all ? "all" : ids.join("-"))}-${randomBytes(3).toString("hex")}`;

/**
 * The Dev Server build: `--bin` wins, else the backend pin the scenarios need
 * (built from the OSS repo, cached per commit), else the published CLI.
 */
const resolveBin = async (scenarios: Scenario[]) => {
  if (binFlag) {
    return binFlag;
  }

  if (direct) {
    return process.env.AGENTS_VERIFY_DEV_BIN ?? "AGENTS_VERIFY_DEV_BIN (unset)";
  }

  const pins = JSON.parse(
    readFileSync(join(here, "kit/oss-pins.json"), "utf8"),
  ) as Record<string, string>;
  const wanted = new Set(
    scenarios.flatMap((s) => {
      return s.needs?.oss ? [pins[s.needs.oss] ?? s.needs.oss] : [];
    }),
  );

  if (wanted.size === 0) {
    return "published";
  }

  if (wanted.size > 1) {
    throw new Error(
      `Scenarios need different backends: ${[...wanted].join(", ")}. Edit kit/oss-pins.json so they agree.`,
    );
  }

  const ref = [...wanted][0] as string;

  await devstack(["build-local", ossRepo, "--ref", ref]);

  return `local@${ref.slice(0, 12)}`;
};

if (!inner) {
  // Outer: run the inner process under `devstack with`, which stops every
  // instance it started even if the inner process dies or times out. `--keep`
  // skips it, since the scope would stop the stack too.
  const loaded = await Promise.all(ids.map(load));
  const builds = loaded.some((s) => {
    return s.needs?.oss;
  });
  const minutes = 3 + ids.length * 2 + (builds ? 10 : 0);
  const inside = [
    process.execPath,
    ...process.execArgv,
    process.argv[1] as string,
    "--inner",
    ...(all ? ["--all"] : requested),
    ...rebuilt(),
  ];
  const child =
    keep || direct
      ? spawn(inside[0] as string, inside.slice(1), {
          stdio: "inherit",
          cwd: packageDir,
        })
      : spawn(
          devstackBin,
          ["with", "--timeout", `${minutes}m`, "--", ...inside],
          {
            stdio: "inherit",
            cwd: packageDir,
          },
        );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }

  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });
} else {
  const scenarios = await Promise.all(ids.map(load));
  const bin = await resolveBin(scenarios);
  const fakes = await startFakes();
  let failed = false;
  const started = Date.now();
  const stopAndExit = async (code: number) => {
    if (!keep) {
      await stopStack(name);
    }

    process.exit(code);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void stopAndExit(130);
    });
  }

  // Direct mode has no `devstack with`, so it carries its own cap.
  if (direct) {
    setTimeout(
      () => {
        console.log("FAIL agents:verify exceeded its time cap");
        void stopAndExit(1);
      },
      (3 + ids.length * 2) * 60_000,
    ).unref();
  }

  console.log(`stack ${name}, Dev Server ${bin}, scenarios ${ids.join(", ")}`);

  try {
    const expectFile = join(tmpdir(), `agents-e2e-expect-${name}.json`);
    rmSync(expectFile, { force: true });

    const stack = await startStack({
      name,
      bin,
      cwd: packageDir,
      appCommand:
        "pnpm exec tsx --tsconfig test/agents-e2e/tsconfig.json test/agents-e2e/app.ts",
      appEnv: {
        AGENTS_E2E_SCENARIOS: ids.join(","),
        AGENTS_E2E_FAKES: fakes.url,
        AGENTS_E2E_EXPECT_FILE: expectFile,
      },
    });

    await waitForSync(stack.devUrl, expectFile);

    console.log(`stack ready in ${Math.round((Date.now() - started) / 1000)}s`);

    for (const s of scenarios) {
      const begin = Date.now();
      let scenarioFailed = false;
      const ctx = createCtx(s.id, stack.devUrl, stack.redisUrl, fakes, () => {
        scenarioFailed = true;
      });
      let timer: NodeJS.Timeout | undefined;

      try {
        await Promise.race([
          s.run(ctx),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`scenario exceeded ${scenarioCapMs / 1000}s`));
            }, scenarioCapMs);
          }),
        ]);
      } catch (error) {
        scenarioFailed = true;
        console.log(
          `FAIL ${s.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(timer);
      }

      failed ||= scenarioFailed;
      console.log(
        `${scenarioFailed ? "FAIL" : "PASS"} ${s.id} (${Math.round((Date.now() - begin) / 1000)}s)`,
      );
    }
  } catch (error) {
    failed = true;
    console.log(
      `FAIL setup: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (keep) {
      console.log(
        `--keep: leaving stack ${name} up (stop it with: devstack stop ${name})`,
      );
    } else {
      await stopStack(name);
    }

    await fakes.close();
    rmSync(join(tmpdir(), `agents-e2e-expect-${name}.json`), { force: true });
  }

  console.log(failed ? "agents:verify FAILED" : "agents:verify PASSED");
  process.exit(failed ? 1 : 0);
}
