import { RuleTester } from "@typescript-eslint/rule-tester";
import { awaitInngestSend } from "./await-inngest-send";

const ruleTester = new RuleTester({
  parser: "@typescript-eslint/parser",
});

ruleTester.run("my-rule", awaitInngestSend, {
  valid: [
    'await inngest.send({ name: "some.event" });',
    'return inngest.send({ name: "some.event" });',
    'void inngest.send({ name: "some.event" });',
  ],
  invalid: [
    {
      code: 'inngest.send({ name: "some.event" });',
      errors: [{ messageId: "await-inngest-send" }],
    },
  ],
});
