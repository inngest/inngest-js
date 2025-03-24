import { slugify, stringify, timeStr } from "./strings.ts";

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
