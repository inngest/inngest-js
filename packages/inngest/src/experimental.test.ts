import { expectTypeOf, test } from "vitest";
import type { SandboxCommand } from "./experimental.ts";

test("exports the sandbox command type", () => {
  expectTypeOf<SandboxCommand>().toEqualTypeOf<string | readonly string[]>();
});
