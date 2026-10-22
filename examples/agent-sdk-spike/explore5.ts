import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSessionStore, runTurn, DATA } from "./lib.ts";
const work = mkdtempSync(join(tmpdir(), "website-"));
cpSync(join(import.meta.dirname, "host/website"), work, { recursive: true });
const sessionId = randomUUID();
const store = new FileSessionStore();
const tools = ["Read", "Edit", "Write", "Glob", "Grep"];
const extra = { tools, disallowedTools: ["Bash"], permissionMode: "dontAsk" };
const a = await runTurn({ prompt: "Read docs/page.md and then fix the typo brwon using the Edit tool.", sessionId, resume: false, store, cwd: work, allowedTools: tools, extra });
console.log("T1", a.subtype, a.toolCalls);
const b = await runTurn({ prompt: "continue", sessionId, resume: true, store, cwd: work, allowedTools: tools, extra });
console.log("T2", b.subtype, b.toolCalls);
const c = await runTurn({ prompt: "continue", sessionId, resume: true, store, cwd: work, allowedTools: tools, extra });
console.log("T3", c.subtype, c.toolCalls, c.text.slice(0, 80));
for (const l of readFileSync(join(DATA, "sessions", sessionId + ".jsonl"), "utf8").split("\n").filter(Boolean)) {
  const e = JSON.parse(l);
  if (e.type === "user" && Array.isArray(e.message?.content)) {
    for (const x of e.message.content) if (x.type === "tool_result") console.log("RESULT", JSON.stringify(x.content).slice(0, 260), x.is_error ? "(error)" : "");
  }
}
console.log(readFileSync(join(work, "docs/page.md"), "utf8"));
