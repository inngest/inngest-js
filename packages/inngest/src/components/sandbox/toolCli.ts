/**
 * @module
 * EXPERIMENTAL: `inngest-tool`, a POSIX shell client for the tools channel
 * (see `toolStubs.ts`), installed on `PATH` for every command with tools.
 *
 *     inngest-tool [-j] [-r] [--stdin] <tool> [arg...]
 *
 * It claims a request id with `mkdir`, appends one `call` line to `ops.log`,
 * and polls the log for the reply, exactly as the Python and Node stubs do. It
 * needs `sh`, `sed`, `grep`, `tail`, `wc` and `dd`, and no interpreter.
 *
 * - Arguments are strings. With `-j` they are JSON values, which is how a tool
 *   with an `input` schema gets its one object of named arguments.
 * - `inngest-tool shims` prints what the command's shims do, one line each.
 * - `--stdin` adds all of stdin as a final string argument. Trailing newlines
 *   are not kept, and control characters other than tab and newline exit 2
 *   (the static binary has neither limit).
 * - The result is printed as JSON. With `-r` a string result is printed
 *   unescaped, for `\n`, `\t`, `\"`, `\\` and `\/` only.
 * - A tool error prints its message on stderr and exits 1. Exit 2 is misuse
 *   and exit 3 means the command's wrapper has already exited.
 */
import { maxToolRequestBytes } from "./tools.ts";

export const toolCliName = "inngest-tool";

export const toolCliScript = String.raw`raw=; json=; stdin=
if [ "$1" = shims ] && [ $# -eq 1 ]; then
  cat "$INNGEST_SHIMS_DIR/shims.txt" 2>/dev/null || echo "no shims"
  exit 0
fi
while :; do
  case $1 in
    -r) raw=1; shift;;
    -j) json=1; shift;;
    --stdin) stdin=1; shift;;
    *) break;;
  esac
done
name=$1
d=$INNGEST_TOOLS_DIR
if [ -z "$name" ] || [ -z "$d" ]; then
  echo "usage: inngest-tool [-j] [-r] [--stdin] <tool> [arg...] (inside a command with tools)" >&2
  exit 2
fi
shift
tab=$(printf '\t')
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/$tab/\\\\t/g" -e ':a;N;$!ba;s/\n/\\n/g'; }
plain() { printf '%s' "$1" | tr -d '\t\n' | LC_ALL=C grep -q '[[:cntrl:]]' && { echo "inngest-tool: control characters other than tab and newline need the static binary" >&2; exit 2; }; return 0; }
args=
sep=
for a; do
  [ -n "$json" ] || plain "$a"
  if [ -n "$json" ]; then args="$args$sep$a"; else args="$args$sep\"$(esc "$a")\""; fi
  sep=,
done
if [ -n "$stdin" ]; then
  input=$(cat)
  plain "$input"
  args="$args$sep\"$(esc "$input")\""
fi
id=0
until mkdir "$d/id.$((id + 1))" 2>/dev/null; do id=$((id + 1)); done
id=$((id + 1))
line="{\"op\":\"call\",\"id\":$id,\"tool\":\"$name\",\"args\":[$args],\"kwargs\":{}}"
if [ "$(printf '%s' "$line" | wc -c)" -gt ${maxToolRequestBytes} ]; then
  echo "inngest-tool: request to $name is too large" >&2
  exit 2
fi
pos=$(wc -c < "$d/ops.log")
printf '%s\n' "$line" | dd of="$d/ops.log" oflag=append conv=notrunc iflag=fullblock bs=32M status=none
while :; do
  r=$(tail -c +$((pos + 1)) "$d/ops.log" | grep -m1 "^{\"op\":\"reply\",\"id\":$id,")
  [ -n "$r" ] && break
  if grep -q '^{"op":"exit"' "$d/ops.log"; then
    echo "inngest-tool: the command has already exited" >&2
    exit 3
  fi
  sleep 0.02
done
pre="{\"op\":\"reply\",\"id\":$id,"
case $r in
  "$pre\"error\":"*)
    printf '%s\n' "$r" | sed -e "s/^$pre\"error\"://" -e 's/}$//' -e 's/^"//' -e 's/"$//' -e 's/\\"/"/g' >&2
    exit 1;;
esac
v=$(printf '%s' "$r" | sed -e "s/^$pre\"result\"://" -e 's/}$//')
if [ -n "$raw" ]; then
  case $v in
    \"*) printf '%s' "$v" | sed -e 's/^"//' -e 's/"$//' -e 's/\\\\/\x01/g' -e 's/\\"/"/g' -e 's/\\\//\//g' -e 's/\\t/\t/g' -e 's/\\n/\n/g' -e 's/\x01/\\/g'; exit 0;;
  esac
fi
printf '%s\n' "$v"
`;
