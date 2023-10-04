import { slugify, timeStr } from "@local/helpers/strings";
import { assertType } from "type-plus";

describe("slugify", () => {
  describe("Generates a slug using hyphens", () => {
    test("generic", () => {
      const expected = "yes-ok-this-looks-good";
      const actual = slugify("Yes Ok THIS looks*good!!");
      expect(actual).toEqual(expected);
      assertType<typeof expected>(actual);
    });

    test("lowercase", () => {
      const expected = "lower-case";
      const actual = slugify("LOWER CASE");
      expect(actual).toEqual(expected);
      assertType<typeof expected>(actual);
    });

    test("emoji", () => {
      const expected = "remove-emojis";
      const actual = slugify("Remove 🌝 emojis");
      expect(actual).toEqual(expected);
      assertType<typeof expected>(actual);
    });

    test("multi-dashes", () => {
      const expected = "multi-dashes";
      const actual = slugify("multi--dashes---");
      expect(actual).toEqual(expected);
      assertType<typeof expected>(actual);
    });

    test("leading and trailing dash", () => {
      const expected = "leading-and-trailing-dash";
      const actual = slugify("-leading and trailing dash-");
      expect(actual).toEqual(expected);
      assertType<typeof expected>(actual);
    });

    test("extra spaces", () => {
      const expected = "extra-spac-es";
      const actual = slugify("extra   spac es");
      expect(actual).toEqual(expected);
      assertType<typeof expected>(actual);
    });

    test("special chars", () => {
      const expected = "special-chars-removed";
      const actual = slugify(
        //   ^?
        `special !@#$%^&*()+ chars ={}[]|\\<>,._ removed '";:`
      );
      expect(actual).toEqual(expected);
      assertType<typeof expected>(actual);
    });

    test("unicode", () => {
      const expected = "ther-b-t-a-d-bops";
      const actual = slugify(`öther Δ bītš añd ✓ bops`);
      expect(actual).toEqual(expected);
      assertType<typeof expected>(actual);
    });
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
