import { InngestFunction } from "@local/components/InngestFunction";
import { ExecutionVersion } from "@local/components/execution/InngestExecution";
import { parseFnData, type FnData } from "@local/helpers/functions";
import { type EventPayload } from "@local/types";
import { createClient } from "../__test__/helpers";

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

  const fn = new InngestFunction(
    createClient({ id: "test-client" }),
    { id: "test-fn", triggers: [{ event: "test-event" }] },
    () => "test-return"
  );

  specs.forEach((test) => {
    it(test.name, () => {
      if (test.isOk) {
        return expect(() => parseFnData(fn, test.data)).not.toThrow();
      } else {
        return expect(() => parseFnData(fn, test.data)).toThrow();
      }
    });
  });
});
