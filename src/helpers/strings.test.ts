import { slugify } from "./strings";

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
