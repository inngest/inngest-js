/**
 * @module
 * `pnpm tour:page-check <url> [--no-run] [--exercise] [--keep]`: drives one
 * page of a running tour with `agent-browser` and prints what a reader would
 * see: the title, the pills, the file tabs (in order), the editor's red squiggles, the page
 * state in the left nav, and after Run (pressed with its key in the editor)
 * every run with its status, output and trace rows, the first row opened.
 *
 * `--exercise` also presses Check, then Show a solution and Check again.
 * `--keep` leaves the browser open in the printed session so you can go on
 * pressing things by hand; otherwise it is closed. A screenshot of the page
 * after Run is saved and its path printed.
 */
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const url = args.find((arg) => {
  return !arg.startsWith("--");
});
const flag = (name: string) => {
  return args.includes(`--${name}`);
};

if (!url) {
  console.error(
    "Usage: pnpm tour:page-check <page url> [--no-run] [--exercise] [--keep]",
  );
  process.exit(1);
}

const slug = new URL(url).pathname.split("/").filter(Boolean).join("-");
const session = process.env.AGENT_BROWSER_SESSION ?? `${slug}-${process.pid}`;

const ab = (...command: string[]) => {
  const result = spawnSync("agent-browser", command, {
    encoding: "utf8",
    env: { ...process.env, AGENT_BROWSER_SESSION: session },
  });

  if (result.status !== 0) {
    throw new Error(
      `agent-browser ${command.join(" ")}: ${result.stdout}${result.stderr}`,
    );
  }

  return result.stdout.trim();
};

// Runs an expression in the page and returns its value (agent-browser
// prints it as JSON).
const page = <T>(expression: string): T => {
  return JSON.parse(ab("eval", expression)) as T;
};

const sleep = (ms: number) => {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
};

const until = async (expression: string, timeout: number) => {
  const end = Date.now() + timeout;

  while (Date.now() < end) {
    if (page<boolean>(expression)) {
      return true;
    }

    await sleep(300);
  }

  return false;
};

const navState = () => {
  return page<string>(
    `document.querySelector('.nav-page[aria-current="page"]')?.dataset.state ?? "none"`,
  );
};

const show = (label: string, value: unknown) => {
  console.log(
    `${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
};

const runs = () => {
  return page<
    { fn: string; status: string; output: string | null; rows: string[] }[]
  >(`Array.from(document.querySelectorAll(".trace section.run")).map((run) => ({
    fn: run.getAttribute("aria-label").replace(/^Run of /, ""),
    status: run.querySelector(".run-head .status")?.textContent ?? "",
    output: run.querySelector(".run-output")?.textContent ?? null,
    rows: Array.from(run.querySelectorAll(".wf-row .wf-name")).map((row) => row.textContent.trim()),
  }))`);
};

const typed = (text: string) => {
  return `!!document.querySelector(".text h2") && ${text}`;
};

try {
  ab("open", url);

  if (!(await until(typed("true"), 15_000))) {
    throw new Error("The page did not load in 15 s");
  }

  show("session", session);
  show("page", page<string>(`document.querySelector(".text h2").textContent`));
  show(
    "module",
    page<string>(`document.querySelector(".text .crumb").textContent`),
  );
  show(
    "pills",
    page<string[]>(
      `Array.from(document.querySelectorAll(".pills li")).map((pill) => pill.textContent.trim())`,
    ),
  );
  const tabs = page<string[]>(
    `Array.from(document.querySelectorAll('section[aria-label="Code"] [role="tab"]')).map((tab) => tab.textContent.trim())`,
  );

  show("tabs", tabs);

  if (
    tabs.length > 0 &&
    !tabs.some((tab) => {
      return tab.startsWith("run.ts");
    })
  ) {
    console.log("warning: no run.ts tab, so Run's call is not on screen");
  }
  show(
    "concepts chip",
    page<string>(`document.getElementById("concepts-chip")?.textContent ?? ""`),
  );
  show("nav state", navState());

  // The editor's TypeScript worker needs a moment to load the SDK's types.
  await sleep(4000);
  show(
    "red squiggles",
    page<number>(`document.querySelectorAll(".squiggly-error").length`),
  );

  if (!flag("no-run")) {
    ab("click", ".view-lines");
    ab("press", "Control+Enter");

    const settled = await until(
      `(() => {
        const runs = document.querySelectorAll(".trace section.run");
        if (runs.length === 0) return false;
        return Array.from(runs).every((run) => /completed|failed|cancelled/.test(run.querySelector(".run-head .status")?.textContent ?? ""));
      })()`,
      60_000,
    );

    // Late runs (a second agent, a reply) still get a moment to show.
    await sleep(1500);
    show("runs settled", settled);
    show(
      "status line",
      page<string>(`document.querySelector(".status-line")?.textContent ?? ""`),
    );

    for (const run of runs()) {
      console.log(`run ${run.fn}: ${run.status}`);
      console.log(`  output: ${run.output ?? "(none)"}`);
      console.log(`  rows: ${run.rows.join(" | ")}`);
    }

    if (page<boolean>(`!!document.querySelector(".trace .wf-row")`)) {
      ab("click", ".trace .wf-row");
      await sleep(800);
      show(
        "first row",
        page<string>(
          `document.querySelector(".trace .step-detail")?.textContent ?? "(nothing)"`,
        ),
      );
    }

    show("nav state after Run", navState());

    const shot = `/tmp/${slug}.png`;

    ab("screenshot", shot);
    show("screenshot", shot);
  }

  if (flag("exercise")) {
    const verdict = async () => {
      ab("click", ".exercise .controls .primary");
      await until(
        `(() => { const v = document.querySelector(".verdict")?.textContent ?? ""; return v !== "" && v !== "Checking..."; })()`,
        90_000,
      );

      return page<string>(`document.querySelector(".verdict").textContent`);
    };

    show("Check on the stub", await verdict());
    ab("click", ".exercise .controls button:last-child");
    await sleep(1000);
    show("Check on the solution", await verdict());
    show("nav state after Check", navState());
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
} finally {
  if (!flag("keep")) {
    ab("close");
  }
}
