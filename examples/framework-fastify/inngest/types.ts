import { EventSchemas } from "inngest";

type DemoEventSent = {
  name: "demo/event.sent";
  data: {
    message: string;
  };
};

export const schemas = new EventSchemas().fromUnion<DemoEventSent>();
