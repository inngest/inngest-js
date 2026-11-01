/**
 * @module
 * The key table: built from the per-area lists, and refusing a clash.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadKeyTable } from "../scripts/keytable.ts";

const list = (name: string, id: string, outside: string) => {
  return `export const ${name} = [{ id: "${id}", label: "x", group: "G", inField: [], outside: ["${outside}"] }];\n`;
};

describe("the key table", () => {
  it("joins the lists of every area into one table, the page's keys first", async () => {
    const table = await loadKeyTable();
    const ids = table.map((def) => {
      return def.id;
    });

    assert.equal(ids[0], "run");
    assert.ok(ids.includes("slackCompose"));
    assert.ok(ids.includes("githubPull"));
    assert.equal(new Set(ids).size, ids.length);
  });

  it("takes a new area's file with no other change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keys-"));

    writeFileSync(join(dir, "core.ts"), list("coreKeys", "a", "a"));
    writeFileSync(join(dir, "extra.ts"), list("extraKeys", "b", "b"));

    const table = await loadKeyTable(dir);

    assert.deepEqual(
      table.map((def) => {
        return def.id;
      }),
      ["a", "b"],
    );
  });

  it("fails when two areas bind the same key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keys-"));

    writeFileSync(join(dir, "core.ts"), list("coreKeys", "a", "q"));
    writeFileSync(join(dir, "extra.ts"), list("extraKeys", "b", "q"));

    await assert.rejects(loadKeyTable(dir), /out:q is bound to both a and b/);
  });

  it("fails when two areas define the same action", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keys-"));

    writeFileSync(join(dir, "core.ts"), list("coreKeys", "a", "q"));
    writeFileSync(join(dir, "extra.ts"), list("extraKeys", "a", "w"));

    await assert.rejects(loadKeyTable(dir), /action a is defined twice/);
  });
});
