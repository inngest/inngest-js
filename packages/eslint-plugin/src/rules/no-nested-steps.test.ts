import { RuleTester } from "@typescript-eslint/rule-tester";
import { noNestedSteps } from "./no-nested-steps";

const ruleTester = new RuleTester({
  parser: "@typescript-eslint/parser",
});

ruleTester.run("my-rule", noNestedSteps, {
  valid: [
    `const a = await step.run("a", () => "a");
     const b = await step.run("b", () => "b");`,
    `await step.run("a", () => "a").then((a) => step.run("b", () => a + "b"));`,
  ],
  invalid: [
    {
      code: `await step.run("a", async () => {
          await step.run("b", async () => {
               // ...
          });
      });`,
      errors: [{ messageId: "no-nested-steps" }],
    },
  ],
});
