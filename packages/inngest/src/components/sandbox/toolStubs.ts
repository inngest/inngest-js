/**
 * @module
 * The sandbox side of tools: an `inngest_tools` module for Python and Node,
 * and the shell scripts that install it and wait on it.
 *
 * Sandbox code and the host talk through files in a per-run directory
 * (`INNGEST_TOOLS_DIR`):
 *
 * - `req.log`: append-only, one JSON request per line. The stub appends, the
 *   host reads from a byte offset.
 * - `<seq>.json`: the reply to request `seq`, uploaded by the host.
 * - `exit`: written by the wrapper when the command ends.
 *
 * The stubs ship inside the command itself (a heredoc in the wrapper script),
 * so a run that never calls a tool pays no extra requests and no extra steps.
 */
import { maxToolRequestBytes } from "./tools.ts";

export const toolsRoot = "/inngest/tools";

export const toolsRunsRoot = "/inngest/rpc";

const pythonStub = `import asyncio, json, os, time

_dir = os.environ["INNGEST_TOOLS_DIR"]
_wait = float(os.environ.get("INNGEST_TOOLS_TIMEOUT", "300"))
_seq = 0


class ToolError(Exception):
    pass


async def _call(name, args, kwargs):
    global _seq
    _seq += 1
    seq = _seq
    request = {"id": seq, "tool": name, "args": list(args)}
    if kwargs:
        request["kwargs"] = kwargs
    line = json.dumps(request) + "\\n"
    if len(line) > ${maxToolRequestBytes}:
        raise ToolError("request to " + name + " is too large")
    fd = os.open(_dir + "/req.log", os.O_WRONLY | os.O_APPEND | os.O_CREAT)
    try:
        os.write(fd, line.encode())
    finally:
        os.close(fd)
    path = "%s/%d.json" % (_dir, seq)
    end = time.time() + _wait
    while True:
        try:
            with open(path) as f:
                reply = json.load(f)
            break
        except (OSError, ValueError):
            if time.time() > end:
                raise ToolError("timed out waiting for " + name)
            await asyncio.sleep(0.05)
    if "error" in reply:
        raise ToolError(reply["error"])
    return reply.get("result")


class _Tools:
    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        async def call(*args, **kwargs):
            return await _call(name, args, kwargs)

        return call


tools = _Tools()
`;

const nodeStub = `"use strict";
const fs = require("node:fs");

const dir = process.env.INNGEST_TOOLS_DIR;
const wait = Number(process.env.INNGEST_TOOLS_TIMEOUT || 300) * 1000;
let seq = 0;

class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolError";
  }
}

const ascii = (text) => {
  return text.replace(/[\\u007f-\\uffff]/g, (c) => {
    return "\\\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
  });
};

const call = async (name, args) => {
  const id = ++seq;
  const line = ascii(JSON.stringify({ id, tool: name, args })) + "\\n";
  if (line.length > ${maxToolRequestBytes}) {
    throw new ToolError("request to " + name + " is too large");
  }
  fs.appendFileSync(dir + "/req.log", line);
  const path = dir + "/" + id + ".json";
  const end = Date.now() + wait;
  let reply;
  for (;;) {
    try {
      reply = JSON.parse(fs.readFileSync(path, "utf8"));
      break;
    } catch {
      if (Date.now() > end) {
        throw new ToolError("timed out waiting for " + name);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if ("error" in reply) {
    throw new ToolError(reply.error);
  }
  return reply.result;
};

exports.ToolError = ToolError;
exports.tools = new Proxy(
  {},
  {
    get: (_, name) => {
      if (typeof name !== "string" || name === "then" || name.startsWith("_")) {
        return undefined;
      }
      return (...args) => call(name, args);
    },
  },
);
`;

/**
 * Runs as "/bin/sh -c <script> sh <command...>". Installs the stubs, runs
 * the command, and records its exit code for the waiter.
 */
export const wrapperScript = `put() { cat > "$1.tmp$$" && mv "$1.tmp$$" "$1"; }
mkdir -p "$INNGEST_TOOLS_DIR" ${toolsRoot}/py ${toolsRoot}/js/inngest_tools
put ${toolsRoot}/py/inngest_tools.py <<'INNGEST_TOOLS_PY'
${pythonStub}INNGEST_TOOLS_PY
put ${toolsRoot}/js/inngest_tools/index.js <<'INNGEST_TOOLS_JS'
${nodeStub}INNGEST_TOOLS_JS
: > "$INNGEST_TOOLS_DIR/req.log"
export PYTHONPATH="${toolsRoot}/py\${PYTHONPATH:+:$PYTHONPATH}"
export NODE_PATH="${toolsRoot}/js\${NODE_PATH:+:$NODE_PATH}"
export PYTHONUNBUFFERED=1
"$@"
code=$?
echo $code > "$INNGEST_TOOLS_DIR/exit"
exit $code
`;

/**
 * Runs as "/bin/sh -c <script> sh <dir> <offset> <seconds>". Blocks until
 * the request log grows past the offset, the command exits, or the time is up.
 * Prints "exit=1" or "exit=0", then the new bytes of the log.
 */
export const waiterScript = `d=$1; o=$2; s=$3; i=0
while [ "$(wc -c < "$d/req.log" 2>/dev/null || echo 0)" -le "$o" ] && [ ! -e "$d/exit" ] && [ "$i" -lt $((s * 20)) ]; do sleep 0.05; i=$((i + 1)); done
if [ -e "$d/exit" ]; then echo exit=1; else echo exit=0; fi
tail -c +$((o + 1)) "$d/req.log" 2>/dev/null | head -c 1048576
`;
