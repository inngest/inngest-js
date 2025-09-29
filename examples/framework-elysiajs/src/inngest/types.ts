import { EventSchemas } from "inngest";

type TestHelloWorld = {
  name: "test/hello.world";
  data: {
    email: string;
  };
};

export const schemas = new EventSchemas().fromUnion<TestHelloWorld>();
