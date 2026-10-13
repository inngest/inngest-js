/**
 * @module
 * The sandbox side of tools: an `inngest_tools` module for Python and Node,
 * the wrapper that installs it around the command, and the waiter that reports
 * back.
 *
 * Sandbox code and the host talk through files in a per-run directory
 * (`INNGEST_TOOLS_DIR`):
 *
 * - `req.log`: append-only, one JSON request per line. The stub appends, the
 *   host reads by line count.
 * - `<id>.json`: the reply to request `id`, uploaded by the host.
 * - `out`, `err`, `code`: the command's output, then its exit code (written
 *   last, so its existence means the other two are complete).
 *
 * The stubs ship inside the command itself (a heredoc in the wrapper script),
 * so a run that never calls a tool pays no extra requests and no extra steps.
 */
import { maxToolRequestBytes } from "./tools.ts";

export const toolsRoot = "/inngest/tools";

/**
 * What sandbox code calls tools on: `from inngest_tools import tools`.
 */
const handle = "tools";

/**
 * Both stubs share the file layout above and the 50ms reply poll. Everything
 * else is the idiom of its language.
 */
const pythonStub = `import asyncio, json, os

_dir = os.environ["INNGEST_TOOLS_DIR"]
_seq = 0


class ToolError(Exception):
    pass


class _Tools:
    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        async def call(*args, **kwargs):
            global _seq
            _seq += 1
            seq = _seq
            line = json.dumps({"id": seq, "tool": name, "args": args, "kwargs": kwargs}) + "\\n"
            if len(line) > ${maxToolRequestBytes}:
                raise ToolError("request to " + name + " is too large")
            with open(_dir + "/req.log", "a") as f:
                f.write(line)
            while True:
                try:
                    with open("%s/%d.json" % (_dir, seq)) as f:
                        reply = json.load(f)
                    break
                except (OSError, ValueError):
                    await asyncio.sleep(0.05)
            if "error" in reply:
                raise ToolError(reply["error"])
            return reply["result"]

        return call


${handle} = _Tools()
`;

const nodeStub = `const fs = require("node:fs");

const dir = process.env.INNGEST_TOOLS_DIR;
let seq = 0;

class ToolError extends Error {
  name = "ToolError";
}

const call = async (name, args) => {
  const id = ++seq;
  const line = JSON.stringify({ id, tool: name, args }) + "\\n";
  if (Buffer.byteLength(line) > ${maxToolRequestBytes}) {
    throw new ToolError("request to " + name + " is too large");
  }
  fs.appendFileSync(dir + "/req.log", line);
  let reply;
  while (!reply) {
    try {
      reply = JSON.parse(fs.readFileSync(dir + "/" + id + ".json", "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if ("error" in reply) {
    throw new ToolError(reply.error);
  }
  return reply.result;
};

exports.ToolError = ToolError;
exports.${handle} = new Proxy({}, {
  get: (_, name) => {
    return typeof name === "string" && name !== "then" && !name.startsWith("_")
      ? (...args) => call(name, args)
      : undefined;
  },
});
`;

/**
 * Runs as a process: "/bin/sh -c <script> sh <command...>". Installs the
 * stubs, runs the command with its output in files, and records the exit code.
 */
export const wrapperScript = `put() { cat > "$1.tmp$$" && mv "$1.tmp$$" "$1"; }
d=$INNGEST_TOOLS_DIR
mkdir -p "$d" ${toolsRoot}/py ${toolsRoot}/js/inngest_tools
put ${toolsRoot}/py/inngest_tools.py <<'INNGEST_TOOLS_PY'
${pythonStub}INNGEST_TOOLS_PY
put ${toolsRoot}/js/inngest_tools/index.js <<'INNGEST_TOOLS_JS'
${nodeStub}INNGEST_TOOLS_JS
: > "$d/req.log"
export PYTHONPATH="${toolsRoot}/py\${PYTHONPATH:+:$PYTHONPATH}"
export NODE_PATH="${toolsRoot}/js\${NODE_PATH:+:$NODE_PATH}"
export PYTHONUNBUFFERED=1
"$@" > "$d/out" 2> "$d/err"
echo $? > "$d/code.tmp" && mv "$d/code.tmp" "$d/code"
`;

/**
 * Runs as an exec: "/bin/sh -c <script> sh <dir> <lines> <seconds>". Blocks
 * until the request log has more than `lines` lines, the command has exited, or
 * the time is up. It tolerates running before the wrapper has started.
 *
 * Prints three lines, then the new requests: the exit code (empty while the
 * command runs), its base64 stdout, its base64 stderr.
 */
export const waiterScript = `d=$1; n=$2; i=$(($3 * 50))
while [ "$(cat "$d/req.log" 2>/dev/null | wc -l)" -le "$n" ] && [ ! -e "$d/code" ] && [ $i -gt 0 ]; do sleep 0.02; i=$((i - 1)); done
code=$(cat "$d/code" 2>/dev/null)
echo "$code"
if [ -n "$code" ]; then base64 -w0 "$d/out"; echo; base64 -w0 "$d/err"; echo; else echo; echo; fi
tail -n +$((n + 1)) "$d/req.log" 2>/dev/null | head -c 1048576
`;
