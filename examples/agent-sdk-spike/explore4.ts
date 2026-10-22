import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { FileSessionStore, runTurn } from "./lib.ts";
const cwd = join(import.meta.dirname, "host/website");
for (const [label, extra] of [
  ["project settings + Skill tool", { tools: ["Skill"], maxTurns: 4 }],
  ["settingSources [] (control)", { tools: ["Skill"], maxTurns: 4, settingSources: [] }],
] as const) {
  const t = await runTurn({ prompt: "Use the shout skill on the word hello.", sessionId: randomUUID(), resume: false, store: new FileSessionStore(), cwd, extra: extra as never });
  console.log(label, "=>", JSON.stringify({ subtype: t.subtype, calls: t.toolCalls, text: t.text, skills: (t.system as any)?.skills?.slice(0, 3) }));
}
