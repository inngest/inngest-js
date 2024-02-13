import { EventSchemas } from "inngest";

type DemoEventSent = {
  name: "demo/hello.world";
  data: {
    message: string;
    email?: string;
  };
};

export const schemas = new EventSchemas().fromUnion<DemoEventSent>();
