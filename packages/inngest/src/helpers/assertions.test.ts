import { Inngest } from "../components/Inngest.ts";
import { InngestMiddleware } from "../components/InngestMiddleware.ts";
import {
  isInngest,
  isInngestFunction,
  isInngestMiddleware,
} from "./assertions.ts";

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

describe("isInngestMiddleware", () => {
  it("should return true for InngestMiddleware instance", () => {
    const middleware = new InngestMiddleware({
      name: "test",
      init: () => ({}),
    });

    expect(isInngestMiddleware(middleware)).toBe(true);
  });

  it("should return false for non-InngestMiddleware instance", () => {
    const obj = {};
    expect(isInngestMiddleware(obj)).toBe(false);
  });
});
