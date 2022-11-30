#!/usr/bin/env node

import { spawn } from "child_process";

const [, , ...args] = process.argv;

spawn("npx", ["--quiet", "inngest-cli@latest", ...args], {
  stdio: "inherit",
});
