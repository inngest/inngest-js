/**
 * @module
 * What the reader typed, kept per file of a page.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Page } from "../shared/types.ts";
import { clearEdits, type EditStore, saveEdits, withEdits } from "../site/src/edits.ts";

const page = (agent = "export const a = 1;"): Page => {
  return {
    id: "first/more",
    label: "2",
    kind: "core",
    module: "first",
    moduleTitle: "First",
    title: "More",
    markdown: "",
    manifest: {},
    files: [
      { name: "agent.ts", content: agent, editable: true },
      { name: "tools.ts", content: "export const b = 2;", editable: true },
      { name: "setup.ts", content: "export const s = 3;", editable: false },
    ],
  };
};

describe("saved edits", () => {
  let memory = new Map<string, string>();
  const store: EditStore = {
    get: (key) => {
      return memory.get(key) ?? null;
    },
    set: (key, value) => {
      memory.set(key, value);
    },
    remove: (key) => {
      memory.delete(key);
    },
  };

  beforeEach(() => {
    memory = new Map();
  });

  const contents = (files: Page["files"]) => {
    return Object.fromEntries(
      files.map((file) => {
        return [file.name, file.content];
      }),
    );
  };

  it("keeps an edit to one file out of the others", () => {
    saveEdits(page(), { "tools.ts": "edited tools" }, store);

    assert.deepEqual(contents(withEdits(page(), store)), {
      "agent.ts": "export const a = 1;",
      "tools.ts": "edited tools",
      "setup.ts": "export const s = 3;",
    });
  });

  it("keeps an edit to each editable file", () => {
    saveEdits(
      page(),
      { "agent.ts": "edited agent", "tools.ts": "edited tools" },
      store,
    );

    assert.deepEqual(contents(withEdits(page(), store)), {
      "agent.ts": "edited agent",
      "tools.ts": "edited tools",
      "setup.ts": "export const s = 3;",
    });
  });

  it("never saves a read-only file", () => {
    saveEdits(page(), { "setup.ts": "tampered" }, store);

    assert.equal(memory.size, 0);
  });

  it("drops an edit when the file's starting code changes", () => {
    saveEdits(page(), { "agent.ts": "edited agent" }, store);

    assert.equal(
      contents(withEdits(page("export const a = 99;"), store))["agent.ts"],
      "export const a = 99;",
    );
  });

  it("clears every file's edit", () => {
    saveEdits(page(), { "agent.ts": "x", "tools.ts": "y" }, store);
    clearEdits(page(), store);

    assert.equal(memory.size, 0);
  });
});
