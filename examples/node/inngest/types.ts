import { EventSchemas } from "inngest";

type DemoEventSent = {
  name: "demo/event.sent";
  data: {
    message: string;
  };
};

type HelloWorldEvent = {
  name: "hello-world";
};

export const schemas = new EventSchemas().fromUnion<
  HelloWorldEvent | DemoEventSent
>();
