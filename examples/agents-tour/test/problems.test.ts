import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeDiagnostic,
  describeRuntimeError,
  locate,
} from "../shared/problems.ts";

const diagnostic = (code: number, message: string, file = "run.ts") => {
  return { file, line: 1, column: 10, length: 5, code, message };
};

describe("describeDiagnostic", () => {
  it("names the missing export and the file that needs it", () => {
    const got = describeDiagnostic(
      diagnostic(2305, `Module '"./agent"' has no exported member 'hello'.`),
    );

    assert.equal(
      got.headline,
      "`run.ts` can't find `hello` in `agent.ts`. `run.ts` imports `hello`, so `agent.ts` needs `export const hello`.",
    );
    assert.equal(got.detail, "run.ts:1");
  });

  it("offers the spelling TypeScript suggests", () => {
    const got = describeDiagnostic(
      diagnostic(
        2724,
        `'"./agent"' has no exported member named 'hello'. Did you mean 'hi'?`,
      ),
    );

    assert.match(got.headline, /Did you mean `hi`\?$/);
  });

  it("says when the name is declared but not exported", () => {
    const got = describeDiagnostic(
      diagnostic(
        2459,
        `Module '"./agent"' declares 'hello' locally, but it is not exported.`,
      ),
    );

    assert.match(got.headline, /declares `hello` but does not export it/);
  });

  it("explains an unknown name, a syntax error and the rest", () => {
    assert.equal(
      describeDiagnostic(
        diagnostic(2304, "Cannot find name 'nope'.", "agent.ts"),
      ).headline,
      "`nope` is not defined in `agent.ts`. Declare it or import it.",
    );
    assert.match(
      describeDiagnostic(diagnostic(1005, "';' expected.", "agent.ts"))
        .headline,
      /^`agent.ts` has a syntax error: ';' expected\.$/,
    );
    assert.match(
      describeDiagnostic(
        diagnostic(7006, "Parameter 'x' implicitly has an 'any' type."),
      ).headline,
      /does not typecheck: Parameter 'x'/,
    );
  });
});

describe("describeRuntimeError", () => {
  const files = ["agent.ts", "run.ts"];

  it("finds the line in the stack", () => {
    const got = describeRuntimeError(
      "Error: boom\n    at file:///w/.tour/run/gen-1/run.ts?run=1:3:7",
      files,
      "run.ts",
    );

    assert.equal(got.headline, "`run.ts` failed: boom");
    assert.equal(got.detail, "run.ts:3");
    assert.equal(got.line, 3);
  });

  it("translates a missing export", () => {
    const got = describeRuntimeError(
      "SyntaxError: The requested module './agent' does not provide an export named 'hello'\n    at run.ts:1:10",
      files,
      "run.ts",
    );

    assert.match(got.headline, /`run.ts` can't find `hello` in `agent.ts`/);
  });

  it("finds nothing when no file is named", () => {
    assert.equal(locate("Error: x\n at node:internal:1:1", files), undefined);
  });
});
