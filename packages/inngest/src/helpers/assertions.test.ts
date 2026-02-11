import { Inngest } from "../components/Inngest.ts";
import { isInngest, isInngestFunction } from "./assertions.ts";

describe("isInngest", () => {
  it("should return true for Inngest instance", () => {
    const inngest = new Inngest({ id: "test" });
    expect(isInngest(inngest)).toBe(true);
  });

  it("should return false for non-Inngest instance", () => {
    const obj = {};
    expect(isInngest(obj)).toBe(false);
  });
});

describe("isInngestFunction", () => {
  it("should return true for InngestFunction instance", () => {
    const inngest = new Inngest({ id: "test" });

    const fn = inngest.createFunction(
      { id: "test" },
      { event: "user/created" },
      () => undefined,
    );

    expect(isInngestFunction(fn)).toBe(true);
  });

  it("should return false for non-InngestFunction instance", () => {
    const obj = {};
    expect(isInngestFunction(obj)).toBe(false);
  });
});
