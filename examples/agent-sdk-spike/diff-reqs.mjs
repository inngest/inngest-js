import { readFileSync, readdirSync } from "node:fs";
const dir = process.argv[2];
const posts = readdirSync(dir).filter((f) => f.endsWith(".req.json")).sort((a, b) => parseInt(a) - parseInt(b))
  .map((f) => ({ f, r: JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) })).filter((x) => x.r.method === "POST");
console.log(posts.map((p) => `${p.f}:msgs=${p.r.body.messages.length}:tools=${p.r.body.tools.length}:sys=${p.r.body.system.length}`).join("  "));
function walk(a, b, path, out) {
  if (typeof a !== typeof b || (a === null) !== (b === null)) { out.push([path, a, b]); return; }
  if (a && typeof a === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], path + "." + k, out);
  } else if (a !== b) out.push([path, a, b]);
}
const mains = posts.filter((p) => p.r.body.tools.length > 0);
const last2 = mains.slice(-2);
const out = [];
walk(last2[0].r.body, last2[1].r.body, "", out);
console.log("compare", last2[0].f, last2[1].f, "diffs:", out.length);
for (const [p, a, b] of out) console.log(" ", p, "\n    A:", JSON.stringify(a)?.slice(0, 200), "\n    B:", JSON.stringify(b)?.slice(0, 200));
