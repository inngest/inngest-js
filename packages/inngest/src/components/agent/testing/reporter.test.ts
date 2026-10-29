/**
 * @module
 * Tests for `testReporter()`: the reporter of an app's channel test.
 */
import { defineChannel } from "../channels.ts";
import { testReporter } from "./reporter.ts";

describe("testReporter", () => {
  test("posts to the channels, lists the steps, and returns the finish reference", async () => {
    const posted: string[] = [];
    const channel = defineChannel({
      post: async (message) => {
        posted.push(message.text);

        return "ts-9";
      },
    });
    const { report, ran } = testReporter({ main: channel });

    await report("hello");

    expect(await report.finish({ text: "bye" })).toBe("ts-9");
    expect(posted).toEqual(["hello", "bye"]);
    expect(ran).toEqual(["report:1:0:main", "report:finish:1:0:main"]);
  });

  test("replays from saved results without posting again", async () => {
    const posted: string[] = [];
    const channel = defineChannel({
      post: async (message) => {
        posted.push(message.text);
      },
    });
    const first = testReporter({ main: channel });

    await first.report("hello");

    const again = testReporter({ main: channel }, { saved: first.results });

    await again.report("hello");

    expect(posted).toEqual(["hello"]);
    expect(again.ran).toEqual([]);
  });
});
