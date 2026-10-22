import { join } from "node:path";
import { FileSessionStore, resetSandbox, runTurn } from "./lib.ts";
const [phase, sessionId, budget] = process.argv.slice(2);
const store = new FileSessionStore();
const cwd = join(import.meta.dirname, "host/website");
const maxBudgetUsd = budget === "none" ? undefined : Number(budget ?? 1);
if (phase === "t1") {
  resetSandbox();
  const t = await runTurn({ prompt: "Write a note named a with text hello, then tell me done.", sessionId, resume: false, store, cwd, maxBudgetUsd });
  console.log("T1", t.subtype, t.toolCalls);
} else {
  const t = await runTurn({ prompt: "continue", sessionId, resume: true, store, cwd, maxBudgetUsd });
  console.log("T2", t.subtype, t.text);
}
