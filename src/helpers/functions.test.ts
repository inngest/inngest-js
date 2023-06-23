import { type EventPayload } from "@local/types";
import { parseFnData } from "@local/helpers/functions";
import { InngestAPI } from "@local/api/api";

const randomstr = (): string => {
  return (Math.random() + 1).toString(36).substring(2);
};

const generateEvent = (): EventPayload => {
  return {
    name: randomstr(),
    data: { hello: "world" },
    user: {},
    ts: 0,
  };
};

describe("#parseFnData", () => {
  const API = new InngestAPI({ signingKey: "something" });

  [
    {
      name: "should parse successfully for valid data",
      data: {
        event: generateEvent(),
        events: [...Array(5).keys()].map(() => generateEvent()),
        steps: {},
        ctx: {
          run_id: randomstr(),
          stack: {
            stack: [randomstr()],
            current: 0,
          },
        },
      },
      isOk: true,
    },
    {
      name: "should return an error for missing event",
      data: {
        events: [...Array(5).keys()].map(() => generateEvent()),
        steps: {},
        ctx: {
          run_id: randomstr(),
          stack: {
            stack: [],
            current: 0,
          },
        },
      },
      isOk: false,
    },
    {
      name: "should return an error with empty object",
      data: {},
      isOk: false,
    },
  ].forEach((test) => {
    it(test.name, async () => {
      const result = await parseFnData(test.data, API);
      expect(result.ok).toEqual(test.isOk);
    });
  });
});
