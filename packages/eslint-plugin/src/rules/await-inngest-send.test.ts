// myRule.test.ts
import { RuleTester } from "@typescript-eslint/rule-tester";
import { awaitInngestSend } from "./await-inngest-send";

const ruleTester = new RuleTester({
  parser: "@typescript-eslint/parser",
});

ruleTester.run("my-rule", awaitInngestSend, {
  valid: ["notFooBar()", "const foo = 2", "const bar = 2"],
  invalid: [
    {
      code: "foo()",
      errors: [{ messageId: "await-inngest-send" }],
    },
    {
      code: "bar()",
      errors: [{ messageId: "await-inngest-send" }],
    },
  ],
});
