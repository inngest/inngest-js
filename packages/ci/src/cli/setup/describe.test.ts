/**
 * Tests for what setup says: the facts and the errors without a terminal.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import { factsOf, missingConfigError } from "./describe.ts";
import type { Candidate, Detection } from "./detect.ts";

const ci = { file: "ci/client.ts", name: "ci", client: "inngest" };

const candidate = (overrides: Partial<Candidate> = {}): Candidate => {
  return {
    file: "server.ts",
    ci,
    start: "tsx server.ts",
    path: "/api/inngest",
    warnings: [],
    ...overrides,
  };
};

describe("factsOf", () => {
  test("says what was found, with warnings last", () => {
    expect(factsOf(candidate({ warnings: ["No PORT."] }))).toEqual([
      { label: "CI", value: "ci/client.ts (ci)" },
      { label: "Server", value: "server.ts" },
      { label: "Start", value: "tsx server.ts" },
      { label: "Path", value: "/api/inngest" },
      { label: "Warning", value: "No PORT.", warn: true },
    ]);
  });
});

describe("missingConfigError", () => {
  const none = { instances: [], candidates: [], connects: [] };

  test("prints what was found and the exact snippet to write", () => {
    const error = missingConfigError(
      { instances: [ci], candidates: [candidate()], connects: [] },
      { claude: false },
    );

    expect(error.message).toBe("There is no ci config in inngest.json.");
    expect(error.fix).toBe(`Found
  CI      ci/client.ts (ci)
  Server  server.ts
  Start   tsx server.ts
  Path    /api/inngest

Add this to inngest.json, then run inngest-ci again:

{
  "ci": {
    "start": "tsx server.ts",
    "path": "/api/inngest"
  }
}`);
  });

  test("lists the other servers when there are several", () => {
    const detection: Detection = {
      instances: [ci],
      candidates: [
        candidate(),
        candidate({ file: "a.ts" }),
        candidate({ file: "b.ts" }),
      ],
      connects: [],
    };

    expect(missingConfigError(detection, { claude: false }).fix).toContain(
      "Also found servers in a.ts, b.ts. Use one of those instead",
    );
  });

  test("with no createCi(), points to the Quick start", () => {
    const error = missingConfigError(none, { claude: false });

    expect(error.message).toBe("@inngest/ci isn't set up in this project.");
    expect(error.fix).toContain("#quick-start");
    expect(error.fix).not.toContain("Claude");
  });

  test("with no createCi() in Claude Code, also says to ask Claude", () => {
    expect(missingConfigError(none, { claude: true }).fix).toContain(
      "ask Claude to set up Inngest CI",
    );
  });

  test("with connect() only, shows the minimal server", () => {
    const error = missingConfigError(
      { instances: [ci], candidates: [], connects: ["worker.ts"] },
      { claude: false },
    );

    expect(error.message).toBe(
      "worker.ts serves ci.functions() with connect(), which inngest-ci can't run yet.",
    );
    expect(error.fix).toContain('import { inngest, ci } from "./client";');
    expect(error.fix).toContain(
      "createServer({ client: inngest, functions: ci.functions() })",
    );
  });

  test("with nothing serving, imports the instance from where it is", () => {
    const error = missingConfigError(
      {
        instances: [{ file: "src/lib/ci.ts", name: "ci", client: "client" }],
        candidates: [],
        connects: [],
      },
      { claude: false },
    );

    expect(error.message).toBe("Nothing serves ci.functions().");
    expect(error.fix).toContain('import { client, ci } from "../src/lib/ci";');
  });
});
