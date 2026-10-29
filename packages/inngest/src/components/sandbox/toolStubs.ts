/**
 * @module
 * The sandbox side of tools: an `inngest_tools` module for Python and Node,
 * the wrapper that installs it around the command, and the waiter that reports
 * back.
 *
 * Sandbox code and the host talk through one append-only log in a per-run
 * directory (`INNGEST_TOOLS_DIR`). `ops.log` holds one JSON event per line, and
 * `op` says whose it is. A request claims its `id` by creating the directory
 * `id.<id>`, so ids are unique across the interpreters of one command:
 *
 * - `{"op":"call","id":1,"tool":"getCustomer","args":["c1"],"kwargs":{}}` is a
 *   request, appended by the stub. `kwargs` is Python only.
 * - `{"op":"reply","id":1,"result":{...}}` (or `"error":"..."` in place of
 *   `result`) answers request `id`. The waiter appends it, and the stub scans
 *   the log for it from where its own request was written.
 * - `{"op":"reply","id":1,"yield":true}` tells the stub to write
 *   `{"op":"yielded"}` and exit with code 75 at once. The host resumes only on
 *   both, so a script's own exit 75 is never taken for a suspension. It answers a call to a tool that waits (see `tool.group({ waits })`).
 *   The host starts the command again with `INNGEST_TOOLS_JOURNAL` naming a
 *   file of reply lines, one per earlier call in order, and the stub answers its
 *   first calls from those without sending requests. Each request carries `h`,
 *   a hash of its arguments, which the journal keeps. A replay that calls a
 *   different tool or arguments writes to stderr and exits 76. The stub writes
 *   `{"op":"replayed"}` when it has used the whole journal; the host fails a
 *   replay that exits 0 without it. The stub deletes the journal once it has
 *   read it, and the host removes it when the command ends.
 * - `{"op":"exit","code":0,"stdout":"<base64>","stderr":"<base64>",`
 *   `"stdoutBytes":12,"stderrBytes":0}` is appended by the wrapper when the
 *   command ends. The output is the last 256 KiB of each stream, and the byte
 *   counts are the full sizes, so the host can tell when it was cut.
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
import { toolCliName, toolCliScript } from "./toolCli.ts";
import { maxToolRequestBytes } from "./tools.ts";

export const toolsRoot = "/inngest/tools";

/**
 * Appends stdin to the log in one `write()`: its block size is above any batch
 * of lines.
 */
const append = `dd of="$d/ops.log" oflag=append conv=notrunc iflag=fullblock bs=32M status=none`;

const pythonStub = `import asyncio, hashlib, json, os, sys

_dir = os.environ["INNGEST_TOOLS_DIR"]
_log = os.open(_dir + "/ops.log", os.O_RDWR | os.O_APPEND | os.O_CREAT)
_seq = 0
_journal = []
if os.environ.get("INNGEST_TOOLS_JOURNAL"):
    with open(os.environ["INNGEST_TOOLS_JOURNAL"]) as _file:
        _journal = [json.loads(_line) for _line in _file.read().split("\\n") if _line]
    try:
        os.unlink(os.environ["INNGEST_TOOLS_JOURNAL"])
    except OSError:
        pass
_replayed = 0
os.environ.pop("INNGEST_TOOLS_JOURNAL", None)


def _diverged(message):
    sys.stderr.write("inngest: replay diverged: " + message + "\\n")
    sys.stderr.flush()
    os._exit(76)


def _canon(value):
    if isinstance(value, dict):
        return {"o": sorted([[str(key), _canon(item)] for key, item in value.items()], key=lambda pair: pair[0])}
    if isinstance(value, (list, tuple)):
        return [_canon(item) for item in value]
    return value


def _claim():
    global _seq
    while True:
        _seq += 1
        try:
            os.mkdir(_dir + "/id." + str(_seq))
            return _seq
        except FileExistsError:
            pass


class ToolError(Exception):
    pass


def _result(reply):
    if "error" in reply:
        raise ToolError(reply["error"])
    return reply["result"]


class _Tools:
    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        async def call(*args, **kwargs):
            global _replayed
            digest = hashlib.sha256(json.dumps(_canon([args, kwargs]), default=str).encode()).hexdigest()[:16]
            if _replayed < len(_journal):
                _replayed += 1
                entry = _journal[_replayed - 1]
                if entry.get("tool") != name or entry.get("h") != digest:
                    _diverged("call " + str(_replayed) + " is " + name + " with other arguments than the first run's " + str(entry.get("tool")))
                if _replayed == len(_journal):
                    os.write(_log, b'{"op":"replayed"}\\n')
                return _result(entry)
            id = _claim()
            line = json.dumps({"op": "call", "id": id, "tool": name, "args": args, "kwargs": kwargs, "h": digest}) + "\\n"
            if len(line) > ${maxToolRequestBytes}:
                raise ToolError("request to " + name + " is too large")
            pos = os.fstat(_log).st_size
            os.write(_log, line.encode())
            prefix = b'{"op":"reply","id":%d,' % id
            while True:
                for found in os.pread(_log, os.fstat(_log).st_size - pos, pos).split(b"\\n")[:-1]:
                    if found.startswith(prefix):
                        reply = json.loads(found)
                        if reply.get("yield"):
                            os.write(_log, b'{"op":"yielded"}\\n')
                            os._exit(75)
                        return _result(reply)
                await asyncio.sleep(0.02)

        return call


tools = _Tools()
`;

const nodeStub = `const fs = require("node:fs");
const crypto = require("node:crypto");

const dir = process.env.INNGEST_TOOLS_DIR;
const log = fs.openSync(dir + "/ops.log", "a+");
let seq = 0;
const journal = process.env.INNGEST_TOOLS_JOURNAL
  ? fs.readFileSync(process.env.INNGEST_TOOLS_JOURNAL, "utf8").split("\\n").filter(Boolean).map((line) => JSON.parse(line))
  : [];
let replayed = 0;
if (process.env.INNGEST_TOOLS_JOURNAL) {
  try {
    fs.unlinkSync(process.env.INNGEST_TOOLS_JOURNAL);
  } catch {}
}
delete process.env.INNGEST_TOOLS_JOURNAL;

const diverged = (message) => {
  fs.writeSync(2, "inngest: replay diverged: " + message + "\\n");
  process.exit(76);
};

const canon = (value) => {
  if (Array.isArray(value)) {
    return value.map(canon);
  }
  if (value && typeof value === "object") {
    return { o: Object.keys(value).sort().map((key) => [key, canon(value[key])]) };
  }
  return value;
};

const claim = () => {
  for (;;) {
    try {
      fs.mkdirSync(dir + "/id." + ++seq);
      return seq;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
};

class ToolError extends Error { name = "ToolError"; }

const result = (reply) => {
  if ("error" in reply) {
    throw new ToolError(reply.error);
  }
  return reply.result;
};

const call = async (name, args) => {
  const digest = crypto.createHash("sha256").update(JSON.stringify(canon(JSON.parse(JSON.stringify(args))))).digest("hex").slice(0, 16);
  if (replayed < journal.length) {
    const entry = journal[replayed++];
    if (entry.tool !== name || entry.h !== digest) {
      diverged("call " + replayed + " is " + name + " with other arguments than the first run's " + entry.tool);
    }
    if (replayed === journal.length) {
      fs.writeSync(log, '{"op":"replayed"}\\n');
    }
    return result(entry);
  }
  const id = claim();
  const line = JSON.stringify({ op: "call", id, tool: name, args, h: digest }) + "\\n";
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
        if (reply.yield) {
          fs.writeSync(log, '{"op":"yielded"}\\n');
          process.exit(75);
        }
        return result(reply);
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
export const wrapperScript = `put() { cat > "$1.tmp$$" && chmod 755 "$1.tmp$$" && mv "$1.tmp$$" "$1"; }
d=$1; shift
mkdir -p "$d" ${toolsRoot}/py ${toolsRoot}/js/inngest_tools ${toolsRoot}/bin
mkdir "$d/started" 2>/dev/null || exit 0
echo $$ > "$d/pid"
put ${toolsRoot}/py/inngest_tools.py <<'INNGEST_TOOLS_PY'
${pythonStub}INNGEST_TOOLS_PY
put ${toolsRoot}/js/inngest_tools/index.js <<'INNGEST_TOOLS_JS'
${nodeStub}INNGEST_TOOLS_JS
put ${toolsRoot}/bin/${toolCliName} <<'INNGEST_TOOLS_SH'
${toolCliScript}INNGEST_TOOLS_SH
chmod +x ${toolsRoot}/bin/${toolCliName}
export INNGEST_TOOLS_DIR=$d PYTHONUNBUFFERED=1 PATH="${toolsRoot}/bin:$PATH"
export PYTHONPATH="${toolsRoot}/py\${PYTHONPATH:+:$PYTHONPATH}" NODE_PATH="${toolsRoot}/js\${NODE_PATH:+:$NODE_PATH}"
"$@" > "$d/out" 2> "$d/err"
printf '{"op":"exit","code":%s,"stdout":"%s","stderr":"%s","stdoutBytes":%s,"stderrBytes":%s}\\n' $? "$(tail -c 262144 "$d/out" | base64 -w0)" "$(tail -c 262144 "$d/err" | base64 -w0)" $(($(wc -c < "$d/out"))) $(($(wc -c < "$d/err"))) | ${append}
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
