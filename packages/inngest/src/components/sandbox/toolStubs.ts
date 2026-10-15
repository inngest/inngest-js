/**
 * @module
 * The sandbox side of tools: an `inngest_tools` module for Python and Node,
 * the wrapper that installs it around the command, and the waiter that reports
 * back.
 *
 * Sandbox code and the host talk through one append-only log in a per-run
 * directory (`INNGEST_TOOLS_DIR`). `ops.log` holds one JSON event per line, and
 * `op` says whose it is:
 *
 * - `{"op":"call","id":1,"tool":"getCustomer","args":["c1"],"kwargs":{}}` is a
 *   request, appended by the stub. `kwargs` is Python only.
 * - `{"op":"reply","id":1,"result":{...}}` (or `"error":"..."` in place of
 *   `result`) answers request `id`. The waiter appends it, and the stub scans
 *   the log for it from where its own request was written.
 * - `{"op":"exit","code":0}` is appended by the wrapper when the command ends.
 *
 * The command's output stays in the files `out` and `err`, since it can be
 * large. The waiter prints them along with the exit event.
 *
 * Writers never interleave: every line is appended with a single `write()` to
 * a file opened for append, which the kernel serializes whatever its size
 * (PIPE_BUF only matters for pipes). Requests stop at `maxToolRequestBytes`,
 * replies at `maxToolReplyBytes`, and the exit line is tiny. A reader can still
 * catch a line half-written, so everyone consumes complete lines only.
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
 * Both stubs share the log format above and a 50ms poll for their reply.
 * Everything else is the idiom of its language.
 */
const pythonStub = `import asyncio, json, os

_log = os.open(os.environ["INNGEST_TOOLS_DIR"] + "/ops.log", os.O_RDWR | os.O_APPEND | os.O_CREAT)
_seq = 0


class ToolError(Exception):
    pass


async def _reply(seq, pos):
    while True:
        data = os.pread(_log, os.fstat(_log).st_size - pos, pos)
        end = data.rfind(b"\\n") + 1
        pos += end
        for line in data[:end].split(b"\\n"):
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("op") == "reply" and event.get("id") == seq:
                return event
        await asyncio.sleep(0.05)


class _Tools:
    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        async def call(*args, **kwargs):
            global _seq
            _seq += 1
            seq = _seq
            line = json.dumps({"op": "call", "id": seq, "tool": name, "args": args, "kwargs": kwargs}, separators=(",", ":")).encode() + b"\\n"
            if len(line) > ${maxToolRequestBytes}:
                raise ToolError("request to " + name + " is too large")
            pos = os.fstat(_log).st_size
            os.write(_log, line)
            reply = await _reply(seq, pos)
            if "error" in reply:
                raise ToolError(reply["error"])
            return reply["result"]

        return call


${handle} = _Tools()
`;

const nodeStub = `const fs = require("node:fs");

const log = fs.openSync(process.env.INNGEST_TOOLS_DIR + "/ops.log", "a+");
let seq = 0;

class ToolError extends Error {
  name = "ToolError";
}

const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return {};
  }
};

const reply = async (id, pos) => {
  for (;;) {
    const data = Buffer.alloc(fs.fstatSync(log).size - pos);
    fs.readSync(log, data, 0, data.length, pos);
    const end = data.lastIndexOf("\\n") + 1;
    pos += end;
    for (const line of data.subarray(0, end).toString().split("\\n")) {
      const event = parse(line);
      if (event.op === "reply" && event.id === id) {
        return event;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const call = async (name, args) => {
  const id = ++seq;
  const line = JSON.stringify({ op: "call", id, tool: name, args }) + "\\n";
  if (Buffer.byteLength(line) > ${maxToolRequestBytes}) {
    throw new ToolError("request to " + name + " is too large");
  }
  const pos = fs.fstatSync(log).size;
  fs.writeSync(log, line);
  const event = await reply(id, pos);
  if ("error" in event) {
    throw new ToolError(event.error);
  }
  return event.result;
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
 * Runs as a process: "/bin/sh -c <script> sh <dir> <command...>". Marks the
 * directory as started, installs the stubs, runs the command with its output in
 * files, and appends its exit. The directory is in the command so that the
 * process can be found again.
 */
export const wrapperScript = `put() { cat > "$1.tmp$" && mv "$1.tmp$" "$1"; }
d=$1; shift
export INNGEST_TOOLS_DIR=$d
mkdir -p "$d" ${toolsRoot}/py ${toolsRoot}/js/inngest_tools
: > "$d/started"
put ${toolsRoot}/py/inngest_tools.py <<'INNGEST_TOOLS_PY'
${pythonStub}INNGEST_TOOLS_PY
put ${toolsRoot}/js/inngest_tools/index.js <<'INNGEST_TOOLS_JS'
${nodeStub}INNGEST_TOOLS_JS
export PYTHONPATH="${toolsRoot}/py\${PYTHONPATH:+:$PYTHONPATH}"
export NODE_PATH="${toolsRoot}/js\${NODE_PATH:+:$NODE_PATH}"
export PYTHONUNBUFFERED=1
"$@" > "$d/out" 2> "$d/err"
printf '{"op":"exit","code":%s}\\n' $? >> "$d/ops.log"
`;

/**
 * Runs as an exec: "/bin/sh -c <script> sh <dir>"; prints `started` when the
 * wrapper has run there, which is how a retried first step knows not to start
 * the command twice.
 */
export const startedScript = `[ -e "$1/started" ] && echo started`;

/**
 * Runs as an exec: "/bin/sh -c <script> sh <dir> <lines> <seconds> <replies...>".
 * Appends the replies to the log, then blocks until the log has a request or
 * the exit past its first `lines` lines, or the time is up. It tolerates
 * running before the wrapper has started.
 *
 * It waits with `tail -f`, which is woken by inotify, so it ends the moment
 * the line lands rather than polling. That needs GNU `tail`, `timeout` and
 * `grep`, and `dd` for the replies, which the default image has. Only
 * requests and the exit end the wait: the replies it appends itself don't.
 *
 * A reply is a whole log line, or `@<path>` for a file holding one (too big to
 * ride in the command). `dd` appends each with a single write, which is what
 * keeps it from interleaving with the stub's: its block size is above the
 * largest reply line.
 *
 * Prints the log lines past `lines`, then one `output` line with the base64
 * stdout and stderr when they include the exit.
 */
export const waiterScript = `d=$1; n=$2; s=$3; shift 3
mkdir -p "$d"
: >> "$d/ops.log"
put() { dd of="$d/ops.log" oflag=append conv=notrunc iflag=fullblock bs=2M status=none; }
for r; do
  case $r in
    @*) put < "\${r#@}" ;;
    *) printf '%s\\n' "$r" | put ;;
  esac
done
new() { tail -n +$((n + 1)) "$d/ops.log" 2>/dev/null; }
timeout "$s" tail -n +$((n + 1)) -f "$d/ops.log" 2>/dev/null | grep -q -E '^\\{"op":"(call|exit)"'
new
if new | grep -q '^{"op":"exit"'; then
  printf '{"op":"output","stdout":"%s","stderr":"%s"}\\n' "$(base64 -w0 "$d/out")" "$(base64 -w0 "$d/err")"
fi
`;
