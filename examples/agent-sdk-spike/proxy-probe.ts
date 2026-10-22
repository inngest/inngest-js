/**
 * @module Transparent logging proxy used to inspect what Claude Code sends to
 * the model: records every request body and the raw streamed response.
 */
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.PROBE_DIR ?? "/tmp/probe";
mkdirSync(dir, { recursive: true });
let n = 0;
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  const id = ++n;
  writeFileSync(join(dir, `${id}.req.json`), JSON.stringify({ method: req.method, url: req.url, headers: { ...req.headers, "x-api-key": "[redacted]", authorization: "[redacted]" }, body: body.length ? JSON.parse(body.toString()) : null }, null, 1));
  const headers = { ...req.headers } as Record<string, string>;
  delete headers.host;
  let up: Response;
  try {
    up = await fetch("https://api.anthropic.com" + req.url, { method: req.method, headers, body: req.method === "POST" ? body : undefined });
  } catch {
    res.writeHead(502);
    res.end();
    return;
  }
  const out: Buffer[] = [];
  const rh: Record<string, string> = {};
  up.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding"].includes(k)) rh[k] = v; });
  res.writeHead(up.status, rh);
  for await (const c of (up.body ?? []) as any) { out.push(Buffer.from(c)); res.write(c); }
  res.end();
  writeFileSync(join(dir, `${id}.res.txt`), Buffer.concat(out));
}).listen(Number(process.env.PORT ?? 8799), () => console.log("probe up"));
