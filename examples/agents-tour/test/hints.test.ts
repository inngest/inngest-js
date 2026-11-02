/**
 * @module
 * Key hints in page text: which tokens there are and what they name.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actionNamed, hintTokens, replaceHints } from "../shared/hints.ts";

const table = [
  { id: "run", label: "Run" },
  { id: "next", label: "Next page" },
];

describe("key hints", () => {
  it("finds the tokens outside code", () => {
    assert.deepEqual(
      hintTokens("Press {Run}, then {next}. Not `{code}` or {two words}."),
      ["Run", "next"],
    );
  });

  it("names an action by id in any case", () => {
    assert.equal(actionNamed(table, "RUN")?.id, "run");
    assert.equal(actionNamed(table, "nope"), undefined);
  });

  it("replaces a token that names an action and leaves any other as written", () => {
    assert.equal(
      replaceHints("Press {Run} or {nope}.", table, (action) => {
        return `[${action.label}]`;
      }),
      "Press [Run] or {nope}.",
    );
  });
});
