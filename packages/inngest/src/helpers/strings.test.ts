import { ConsoleLogger } from "../middleware/logger.ts";
import { signDataWithKey } from "./net.ts";
import { slugify, stringify, timeStr, timingSafeEqual } from "./strings.ts";

const logger = new ConsoleLogger({ level: "silent" });

describe("slugify", () => {
  it("Generates a slug using hyphens", () => {
    const specs = [
      { input: "Yes Ok THIS looks*good!!", expected: "yes-ok-this-looks-good" },
      { input: "LOWER CASE", expected: "lower-case" },
      { input: "Remove 🌝 emojis", expected: "remove-emojis" },
      { input: "multi--dashes---", expected: "multi-dashes" },
      {
        input: "-leading and trailing dash-",
        expected: "leading-and-trailing-dash",
      },
      { input: "extra   spac es", expected: "extra-spac-es" },
      { input: "Num6er5", expected: "num6er5" },
      {
        input: `special !@#$%^&*()+ chars ={}[]|\\<>,._ removed '";:`,
        expected: "special-chars-removed",
      },
      {
        input: `öther Δ bītš añd ✓ bops`,
        expected: "ther-b-t-a-d-bops",
      },
    ];

    for (const spec of specs) {
      expect(slugify(spec.input)).toEqual(spec.expected);
    }
  });
});

describe("timeStr", () => {
  test("Converts milliseconds to a time string", () => {
    expect(timeStr(1000)).toEqual("1s");
  });

  test("converts ms string to a time string", () => {
    expect(timeStr("1 day")).toEqual("1d");
  });

  test("converts a date to an ISO string", () => {
    expect(timeStr(new Date(0))).toEqual("1970-01-01T00:00:00.000Z");
  });
});

describe("stringify", () => {
  test("removes BigInt", () => {
    expect(stringify({ a: BigInt(1), b: 2 })).toEqual(JSON.stringify({ b: 2 }));
  });
});

describe("timingSafeEqual", () => {
  it("returns true for identical strings", () => {
    const a = "deadbeefcafef00d";
    const b = "deadbeefcafef00d";
    expect(timingSafeEqual(a, b)).toBe(true);
  });

  it("returns true for real signDataWithKey output compared to itself", async () => {
    const mac = await signDataWithKey(
      "payload",
      "signkey-test-abc",
      "1234567890",
      logger,
    );
    expect(timingSafeEqual(mac, mac)).toBe(true);
  });

  it("returns false for equal-length strings that differ", () => {
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
  });

  it("returns false when strings differ only in the first character", () => {
    expect(timingSafeEqual("0bc123", "abc123")).toBe(false);
  });

  it("returns false when strings differ only in the last character", () => {
    expect(timingSafeEqual("abc120", "abc123")).toBe(false);
  });

  it("returns false for differing-length strings (prefix match)", () => {
    expect(timingSafeEqual("abc", "abc123")).toBe(false);
  });

  it("returns false for differing-length strings (empty vs non-empty)", () => {
    expect(timingSafeEqual("", "a")).toBe(false);
    expect(timingSafeEqual("a", "")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("returns false for strings that differ in multi-byte characters", () => {
    expect(timingSafeEqual("café", "cafe")).toBe(false);
    expect(timingSafeEqual("🌍a", "🌍b")).toBe(false);
  });

  it("returns true for identical non-ASCII strings", () => {
    expect(timingSafeEqual("世界 🌍", "世界 🌍")).toBe(true);
  });
});
