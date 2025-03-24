import type { EventPayload } from "../types.ts";
import { ExecutionVersion } from "./consts.ts";
import { type FnData, parseFnData } from "./functions.ts";

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
  const specs: {
    name: string;
    data: Extract<FnData, { version: ExecutionVersion.V1 }>;
    isOk: boolean;
  }[] = [
    {
      name: "should parse successfully for valid data",
      data: {
        version: 1,
        event: generateEvent(),
        events: [...Array.from(Array(5).keys())].map(() => generateEvent()),
        steps: {},
        ctx: {
          run_id: randomstr(),
          attempt: 0,
          disable_immediate_execution: false,
          use_api: false,
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
      // @ts-expect-error No `event`
      data: {
        version: ExecutionVersion.V1,
        events: [...Array.from(Array(5).keys())].map(() => generateEvent()),
        steps: {},
        ctx: {
          run_id: randomstr(),
          attempt: 0,
          disable_immediate_execution: false,
          use_api: false,
          stack: {
            stack: [randomstr()],
            current: 0,
          },
        },
      },
      isOk: false,
    },
    {
      name: "should return an error with empty object",
      // @ts-expect-error No data at all
      data: {},
      isOk: false,
    },
  ];

  // biome-ignore lint/complexity/noForEach: <explanation>
  specs.forEach((test) => {
    it(test.name, () => {
      if (test.isOk) {
        return expect(() => parseFnData(test.data)).not.toThrow();
      } else {
        return expect(() => parseFnData(test.data)).toThrow();
      }
    });
  });
});
