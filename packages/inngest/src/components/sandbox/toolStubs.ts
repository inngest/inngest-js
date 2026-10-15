/**
 * @module
 * The sandbox side of tools: an `inngest_tools` module for Node,
 * the wrapper that installs it around the command, and the waiter that reports
 * back.
 *
 * Sandbox code and the host talk through one append-only log in a per-run
 * directory (`INNGEST_TOOLS_DIR`). `ops.log` holds one JSON event per line, and
 * `op` says whose it is:
 *
 * - `{"op":"call","id":1,"tool":"getCustomer","args":["c1"]}` is a request,
 *   appended by the stub.
 * - `{"op":"reply","id":1,"result":{...}}` (or `"error":"..."` in place of
 *   `result`) answers request `id`. The waiter appends it, and the stub scans
 *   the log for it from where its own request was written.
 * - `{"op":"exit","code":0,"stdout":"<base64>","stderr":"<base64>"}` is
 *   appended by the wrapper when the command ends.
 *
 * While the command runs, its output stays in the files `out` and `err`, since
 * it can be large. Every line is appended with a single `write()` to a file
 * opened for append, which the kernel serializes whatever its size, so lines
 * never interleave. A reader can still catch a line half-written, so everyone
 * consumes complete lines only.
 *
 * Everyone polls the log every 20ms; nothing relies on file notifications,
 * which sandboxes don't reliably provide.
 *
 * The stubs ship inside the command itself (a heredoc in the wrapper script),
 * so a run that never calls a tool pays no extra requests and no extra steps.
 */
import { maxToolRequestBytes } from "./tools.ts";

export const toolsRoot = "/inngest/tools";

/**
 * Appends stdin to the log in one `write()`: its block size is above any batch
 * of lines.
 */
const append = `dd of="$d/ops.log" oflag=append conv=notrunc iflag=fullblock bs=32M status=none`;

const nodeStub = `const fs = require("node:fs");

const log = fs.openSync(process.env.INNGEST_TOOLS_DIR + "/ops.log", "a+");
let seq = 0;

class ToolError extends Error { name = "ToolError"; }

const call = async (name, args) => {
  const id = ++seq;
  const line = JSON.stringify({ op: "call", id, tool: name, args }) + "\\n";
  if (Buffer.byteLength(line) > ${maxToolRequestBytes}) {
    throw new ToolError("request to " + name + " is too large");
  }
  const pos = fs.fstatSync(log).size;
  fs.writeSync(log, line);
  const prefix = '{"op":"reply","id":' + id + ",";
  for (;;) {
    const data = Buffer.alloc(fs.fstatSync(log).size - pos);
    fs.readSync(log, data, 0, data.length, pos);
    for (const found of data.toString().split("\\n").slice(0, -1)) {
      if (found.startsWith(prefix)) {
        const reply = JSON.parse(found);
        if ("error" in reply) {
          throw new ToolError(reply.error);
        }
        return reply.result;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

exports.ToolError = ToolError;
exports.tools = new Proxy({}, {
  get: (_, name) => {
    return typeof name === "string" && name !== "then" && !name.startsWith("_")
      ? (...args) => call(name, args)
      : undefined;
  },
});
`;

/**
 * Runs as a process: "/bin/sh -c <script> sh <dir> <command...>". Claims the
 * directory by creating `started` in it, and exits at once if that already
 * exists, so a start repeated by a retry does nothing. Otherwise it installs
 * the stubs, runs the command with its output in files, and appends its exit.
 * It records its pid for the host to stop it, and the directory is in the
 * command so that the process can be found again.
 */
export const wrapperScript = `put() { cat > "$1.tmp$$" && mv "$1.tmp$$" "$1"; }
d=$1; shift
mkdir -p "$d" ${toolsRoot}/js/inngest_tools
mkdir "$d/started" 2>/dev/null || exit 0
echo $$ > "$d/pid"
put ${toolsRoot}/js/inngest_tools/index.js <<'INNGEST_TOOLS_JS'
${nodeStub}INNGEST_TOOLS_JS
export INNGEST_TOOLS_DIR=$d
export NODE_PATH="${toolsRoot}/js\${NODE_PATH:+:$NODE_PATH}"
"$@" > "$d/out" 2> "$d/err"
printf '{"op":"exit","code":%s,"stdout":"%s","stderr":"%s"}\\n' $? "$(base64 -w0 "$d/out")" "$(base64 -w0 "$d/err")" | ${append}
`;

/**
 * Runs as an exec: "/bin/sh -c <script> sh <dir> <lines> <seconds> <replies...>".
 * Appends the replies to the log, then polls it until it has a request or the
 * exit past its first `lines` lines, or the time is up. It tolerates running
 * before the wrapper has started. Only requests and the exit end the wait: the
 * replies it appends itself don't.
 *
 * A reply is a whole log line, or `@<path>` for a file holding one (too big to
 * ride in the command). Prints the log lines past `lines`.
 */
export const waiterScript = `d=$1; n=$2; i=$(($3 * 50)); shift 3
mkdir -p "$d"
for r; do case $r in @*) cat "\${r#@}";; *) printf '%s\\n' "$r";; esac; done | ${append}
new() { tail -n +$((n + 1)) "$d/ops.log"; }
while [ $i -gt 0 ] && ! new | grep -q -E '^\\{"op": ?"(call|exit)"'; do sleep 0.02; i=$((i - 1)); done
new
`;
