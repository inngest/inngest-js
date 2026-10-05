/**
 * Tests for the wait scripts: a URL is data, not shell syntax.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { httpWaitScript } from "./wait.ts";

const exec = promisify(execFile);

describe("httpWaitScript", () => {
  let root: string;
  let seen: string[];
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "ci-wait-"));
    seen = [];

    server = createServer((req, res) => {
      seen.push(req.url ?? "");
      res.end("ok");
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
    });

    rmSync(root, { recursive: true, force: true });
  });

  // Async, so the server in this process can answer while the script runs.
  const run = async (url: string) => {
    await exec("/bin/sh", ["-c", httpWaitScript(url, 200, 5000)]);
  };

  test("a query string is requested whole", async () => {
    await run(`http://127.0.0.1:${port}/health?a=1&b=2`);

    expect(seen).toEqual(["/health?a=1&b=2"]);
  });

  test("shell syntax in a URL doesn't run", async () => {
    const marker = join(root, "pwned");

    await run(
      `http://127.0.0.1:${port}/$(touch\${IFS}${marker})?x=1;touch\${IFS}${marker}`,
    );

    expect(existsSync(marker)).toBe(false);
    expect(seen).toHaveLength(1);
  });
});
