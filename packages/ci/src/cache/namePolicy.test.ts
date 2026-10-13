/**
 * Tests of the name policy and the wire flags it stands in for.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import {
  deletesHolder,
  excludedBy,
  type NameFlags,
  policyFromFlags,
  policyToFlags,
} from "./namePolicy.ts";

describe("name policy", () => {
  test.each<[NameFlags, NameFlags]>([
    [{}, {}],
    [{ exclude: "snap" }, { exclude: "snap" }],
    [
      { exclude: "snap", broken: true },
      { exclude: "snap", broken: true },
    ],
    [
      { exclude: "snap", unnamed: true },
      { exclude: "snap", unnamed: true },
    ],
    // A rebuild whose broken snapshot couldn't be deleted is sent unnamed.
    [
      { exclude: "snap", broken: true, unnamed: true },
      { exclude: "snap", unnamed: true },
    ],
  ])("%j goes over the wire as %j", (flags, wire) => {
    expect(policyToFlags(policyFromFlags(flags))).toEqual(wire);
  });

  test("says what to exclude and whether to delete it", () => {
    const replace = policyFromFlags({ exclude: "snap", broken: true });

    expect(excludedBy(replace)).toBe("snap");
    expect(deletesHolder(replace)).toBe(true);
    expect(excludedBy(policyFromFlags({}))).toBeUndefined();
    expect(deletesHolder(policyFromFlags({ exclude: "snap" }))).toBe(false);
  });
});
